import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { readFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { Transport } from './transport.js'
export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: { command: { options: { command: string } } }
	feedbacks: Record<string, never>
	variables: { connection: string; last_result: string }
}
export const UpgradeScripts = []
const commands: Record<string, { capability: string; action: Record<string, unknown> }> = {
	up: { capability: 'navigation', action: { action: 'navigate', direction: 'up' } },
	down: { capability: 'navigation', action: { action: 'navigate', direction: 'down' } },
	left: { capability: 'navigation', action: { action: 'navigate', direction: 'left' } },
	right: { capability: 'navigation', action: { action: 'navigate', direction: 'right' } },
	...Object.fromEntries(
		['select', 'back', 'home', 'playPause', 'previous', 'next'].map((key) => [
			key,
			{ capability: key, action: { action: key } },
		]),
	),
	volumeUp: { capability: 'relativeVolume', action: { action: 'relativeVolume', delta: 1 } },
	volumeDown: { capability: 'relativeVolume', action: { action: 'relativeVolume', delta: -1 } },
	seekForward: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: 10 } },
	seekBackward: { capability: 'relativeSeek', action: { action: 'relativeSeek', delta: -10 } },
}
export default class AppleTV extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	private generation = 0
	private transport = new Transport(() => this.offline())
	private capabilities = new Set<string>()
	private timer: NodeJS.Timeout | undefined
	private tail: Promise<void> = Promise.resolve()
	private queued = 0
	private ready = false
	async init(config: ModuleConfig): Promise<void> {
		this.setVariableDefinitions({
			connection: { name: 'Connection state' },
			last_result: { name: 'Last dispatch result (not physical confirmation)' },
		})
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
		})
		await this.configUpdated(config)
	}
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}
	async configUpdated(config: ModuleConfig): Promise<void> {
		await this.destroy()
		this.config = config
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
			const stat = await lstat(this.config.credentialFile)
			if (
				!stat.isFile() ||
				stat.size > 8192 ||
				(stat.mode & 0o077) !== 0 ||
				(process.getuid && stat.uid !== process.getuid())
			)
				throw new Error('credential_permissions')
			const secret: unknown = JSON.parse(await readFile(this.config.credentialFile, 'utf8'))
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
			this.capabilities = new Set(response.capabilities)
			this.ready = true
			this.updateStatus(InstanceStatus.Ok)
			this.setVariableValues({ connection: 'ready', last_result: '' })
		} catch {
			if (this.generation === generation) this.offline()
		}
	}
	private offline(): void {
		++this.generation
		this.ready = false
		this.capabilities.clear()
		this.transport.stop()
		this.updateStatus(InstanceStatus.ConnectionFailure, 'Offline or unconfigured; no input replay')
		this.setVariableValues({ connection: 'offline', last_result: 'not confirmed' })
		if (!this.timer && this.config?.enabled)
			this.timer = setTimeout(() => {
				this.timer = undefined
				void this.connect()
			}, 5000)
	}
	private async dispatch(key: string): Promise<void> {
		const command = commands[key]
		if (!this.ready || !command || !this.capabilities.has(command.capability) || this.queued >= 8) {
			this.setVariableValues({ last_result: 'unavailable or busy' })
			return
		}
		const generation = this.generation
		const submitted = Date.now()
		this.queued++
		const task = this.tail
			.then(async () => {
				if (generation !== this.generation || Date.now() - submitted > 1000) {
					this.setVariableValues({ last_result: 'expired; not sent' })
					return
				}
				try {
					const reply = await this.transport.request({ operation: 'action', action: command.action }, 3000)
					if (generation !== this.generation) return
					if (reply.error) {
						this.setVariableValues({ last_result: 'rejected' })
						if (reply.state !== 'ready') this.offline()
					} else this.setVariableValues({ last_result: 'dispatched; not state-confirmed' })
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
		this.transport.stop()
	}
}
