import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { open, lstat } from 'node:fs/promises'
import { existsSync, constants } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { Transport, type Reply } from './transport.js'
import { displayDefaults, displayValues, type DisplayValues } from './display.js'
export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: { command: { options: { command: string } }; launchApp: { options: { appId: string } } }
	feedbacks: Record<string, never>
	variables: { connection: string; last_result: string } & DisplayValues
}
export const UpgradeScripts = []
const commands: Record<string, { capability: string; action: Record<string, unknown> }> = {
	up: { capability: 'navigation', action: { action: 'navigate', direction: 'up' } },
	down: { capability: 'navigation', action: { action: 'navigate', direction: 'down' } },
	left: { capability: 'navigation', action: { action: 'navigate', direction: 'left' } },
	right: { capability: 'navigation', action: { action: 'navigate', direction: 'right' } },
	...Object.fromEntries(
		[
			'select',
			'back',
			'home',
			'playPause',
			'previous',
			'next',
			'toggleMute',
			'controlCenter',
			'appSwitcher',
			'screensaver',
			'power',
		].map((key) => [key, { capability: key, action: { action: key } }]),
	),
	volumeUp: { capability: 'relativeVolume', action: { action: 'relativeVolume', delta: 1 } },
	volumeDown: { capability: 'relativeVolume', action: { action: 'relativeVolume', delta: -1 } },
	seekForward: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: 10 } },
	seekBackward: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: -10 } },
	seekForward30: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: 30 } },
	seekBackward30: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: -30 } },
}
export default class AppleTV extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	private generation = 0
	private transport = new Transport(() => this.offline())
	// Retained session snapshot; dispatch uses the worker's per-action check.
	private capabilities = new Set<string>()
	private timer: NodeJS.Timeout | undefined
	private tail: Promise<void> = Promise.resolve()
	private queued = 0
	private ready = false
	private healthTimer: NodeJS.Timeout | undefined
	private probe = false
	private retryDelay = 5000
	private lastActivity = 0
	async init(config: ModuleConfig): Promise<void> {
		this.setVariableDefinitions({
			connection: { name: 'Connection state' },
			last_result: { name: 'Last dispatch result (not physical confirmation)' },
			...(Object.fromEntries(
				Object.keys(displayDefaults).map((key) => [key, { name: key.replaceAll('_', ' ') }]),
			) as Record<keyof DisplayValues, { name: string }>),
		})
		this.setVariableValues(displayDefaults)
		this.setActionDefinitions({
			command: {
				name: 'Remote command',
				options: [
					{
						id: 'command',
						type: 'dropdown',
						label: 'Command',
						default: 'select',
						choices: Object.keys(commands).map((id) => ({ id, label: id })),
					},
				],
				callback: async (event) => this.dispatch(event.options.command),
			},
			launchApp: {
				name: 'Launch App',
				options: [{ id: 'appId', type: 'textinput', label: 'App Bundle Identifier', default: '' }],
				callback: async (event) => this.dispatchAction({ action: 'launchApp', appId: event.options.appId }),
			},
		})
		await this.configUpdated(config)
	}
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}
	async configUpdated(config: ModuleConfig): Promise<void> {
		await this.destroy()
		this.config = config
		this.retryDelay = 5000
		if (!config.enabled) {
			this.updateStatus(InstanceStatus.Disconnected, 'Disabled')
			this.setVariableValues({ connection: 'disabled', last_result: '' })
			return
		}
		await this.connect()
	}
	private async connect(): Promise<void> {
		const generation = ++this.generation
		this.updateStatus(InstanceStatus.Connecting)
		this.setVariableValues({ connection: 'connecting' })
		try {
			if (!isAbsolute(this.config.python) || !isAbsolute(this.config.credentialFile)) throw new Error('configuration')
			const parent = await lstat(dirname(this.config.credentialFile))
			if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid()))
				throw new Error('credential_directory')
			const file = await open(
				this.config.credentialFile,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			)
			let secret: unknown
			try {
				const stat = await file.stat()
				if (
					!stat.isFile() ||
					stat.size > 8192 ||
					(stat.mode & 0o077) !== 0 ||
					(process.getuid && stat.uid !== process.getuid())
				)
					throw new Error('credential_permissions')
				const buffer = Buffer.alloc(8193)
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
				if (bytesRead > 8192) throw new Error('credential_size')
				secret = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
			} finally {
				await file.close()
			}
			if (this.generation !== generation) return
			this.transport.start(this.config.python, [
				fileURLToPath(
					new URL(
						existsSync(new URL('./worker.py', import.meta.url)) ? './worker.py' : '../bridge/worker.py',
						import.meta.url,
					),
				),
			])
			const response = await this.transport.request({ operation: 'connect', secret })
			if (this.generation !== generation) return
			if (response.state !== 'ready' || response.error) throw new Error('connection')
			const health = await this.transport.request({ operation: 'status' }, 3000)
			if (this.generation !== generation) return
			if (health.error === 'healthUnsupported') {
				this.offline(false)
				return
			}
			if (health.state !== 'ready' || health.error) throw new Error('health')
			this.capabilities = new Set(health.capabilities)
			this.ready = true
			this.updateStatus(InstanceStatus.Ok)
			this.setVariableValues({ connection: 'ready', last_result: '' })
			this.lastActivity = performance.now()
			this.healthTimer = setInterval(() => {
				void this.checkHealth()
					.then(async () => this.refreshSnapshot())
					.catch(() => undefined)
			}, 1000)
		} catch {
			if (this.generation === generation) this.offline()
		}
	}
	private applySnapshot(reply: Reply): void {
		if (reply.values) this.setVariableValues(displayValues(reply.values))
	}
	private async refreshSnapshot(): Promise<void> {
		if (!this.ready || this.queued || this.probe) return
		const generation = this.generation
		this.probe = true
		const task = this.tail.then(async () => {
			try {
				if (generation !== this.generation) return
				const reply = await this.transport.request({ operation: 'snapshot' }, 3000)
				if (generation !== this.generation) return
				if (reply.error || reply.state !== 'ready') this.offline()
				else this.applySnapshot(reply)
			} catch {
				if (generation === this.generation) this.offline()
			} finally {
				if (generation === this.generation) this.probe = false
			}
		})
		this.tail = task.catch(() => undefined)
		await task
	}
	private async checkHealth(): Promise<void> {
		if (!this.ready || this.queued || this.probe || performance.now() - this.lastActivity < 30000) return
		const generation = this.generation
		this.probe = true
		const task = this.tail.then(async () => {
			try {
				if (generation !== this.generation) return
				const reply = await this.transport.request({ operation: 'status' }, 3000)
				if (generation !== this.generation) return
				if (reply.error === 'healthUnsupported') {
					this.offline(false)
					return
				}
				if (reply.error || reply.state !== 'ready') {
					this.offline()
					return
				}
				if (Array.isArray(reply.capabilities)) this.capabilities = new Set(reply.capabilities)
				this.retryDelay = 5000
				this.lastActivity = performance.now()
			} catch {
				if (generation === this.generation) this.offline()
			} finally {
				if (generation === this.generation) this.probe = false
			}
		})
		this.tail = task.catch(() => undefined)
		await task
	}
	private offline(retry = true): void {
		++this.generation
		this.ready = false
		this.capabilities.clear()
		this.transport.stop()
		if (this.healthTimer) clearInterval(this.healthTimer)
		this.healthTimer = undefined
		this.probe = false
		this.updateStatus(
			retry ? InstanceStatus.ConnectionFailure : InstanceStatus.BadConfig,
			retry ? 'Offline or unconfigured; no input replay' : 'Required health query unsupported; connection stopped',
		)
		this.setVariableValues({
			connection: retry ? 'offline' : 'unsupported',
			last_result: 'not confirmed',
			metadata_state: 'Offline',
			mute_state: 'Unavailable',
			power: 'Unknown',
		})
		if (retry && !this.timer && this.config?.enabled) {
			this.timer = setTimeout(
				() => {
					this.timer = undefined
					void this.connect().catch(() => undefined)
				},
				this.retryDelay + Math.floor(Math.random() * 1000),
			)
			this.retryDelay = Math.min(this.retryDelay * 2, 60000)
		}
	}
	private async dispatch(key: string): Promise<void> {
		// The worker checks current capabilities immediately before dispatch.
		// A cached negative here can outlive the start of seekable playback.
		const command = commands[key]
		if (!this.ready || !command || this.queued >= 8) {
			this.setVariableValues({
				last_result: !this.ready
					? 'not connected; not sent'
					: !command
						? 'unknown command; not sent'
						: 'busy; not sent',
			})
			return
		}
		await this.dispatchAction(command.action)
	}
	private async dispatchAction(action: Record<string, unknown>): Promise<void> {
		if (!this.ready || this.queued >= 8) {
			this.setVariableValues({ last_result: !this.ready ? 'not connected; not sent' : 'busy; not sent' })
			return
		}
		const generation = this.generation
		const submitted = performance.now()
		this.queued++
		const task = this.tail
			.then(async () => {
				if (generation !== this.generation) return
				if (performance.now() - submitted > 1000) {
					this.setVariableValues({ last_result: 'expired; not sent' })
					return
				}
				try {
					const reply = await this.transport.request(
						{ operation: 'action', action },
						action.action === 'toggleMute' ? 7000 : 3000,
					)
					if (generation !== this.generation) return
					if (reply.error) {
						this.setVariableValues({
							last_result:
								reply.error === 'unsupportedAction'
									? 'unsupported by current playback'
									: reply.error === 'noSavedVolume'
										? 'already at zero; no saved volume'
										: reply.error === 'unknownPower'
											? 'power state unknown; not sent'
											: 'rejected',
						})
						if (reply.state !== 'ready') this.offline()
					} else {
						this.lastActivity = performance.now()
						this.retryDelay = 5000
						if (Array.isArray(reply.capabilities)) this.capabilities = new Set(reply.capabilities)
						this.setVariableValues({ last_result: 'dispatched; not state-confirmed' })
					}
				} catch {
					if (generation === this.generation) this.offline()
				}
			})
			.finally(() => {
				this.queued--
			})
		this.tail = task.catch(() => undefined)
		await task
	}
	async destroy(): Promise<void> {
		++this.generation
		this.ready = false
		this.capabilities.clear()
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		if (this.healthTimer) clearInterval(this.healthTimer)
		this.healthTimer = undefined
		this.probe = false
		this.transport.stop()
	}
}
