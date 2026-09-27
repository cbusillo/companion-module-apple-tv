import { setTimeout as delay } from 'node:timers/promises'
import { scan, type HAPCredentials } from 'node-appletv-remote'
import {
	CompanionPrototype,
	CompanionRequestRejected,
	UnsupportedCommand,
	type Button,
	type CommandState,
	type Direction,
	type MediaCommand,
	type Power,
} from './companion.js'
import { bounded, withCompanionSession, type Target } from './session.js'
import { CommandNotSent, CommandQueue } from './queue.js'
import { withMetadataSession } from './metadata-session.js'
import type { MetadataSnapshot } from './metadata.js'

export type RemoteAction =
	| { kind: 'button'; button: Button }
	| { kind: 'media'; command: MediaCommand }
	| { kind: 'seek'; seconds: number }
	| { kind: 'volume'; percent: number }
	| { kind: 'swipe'; direction: Direction }
	| { kind: 'launch'; bundleId: string }
	| { kind: 'power'; state?: 'On' | 'Off' }
	| { kind: 'mute' }

type State = 'stopped' | 'connecting' | 'ready' | 'reconnecting'
type ControllerTarget = Target & { airplayPort: number }
type Options = {
	discover?: () => Promise<ControllerTarget>
	session?: typeof withCompanionSession
	metadataSession?: typeof withMetadataSession
	reconnectDelayMs?: number
	healthIntervalMs?: number
}

/** Owns a Companion/metadata pair. Reconnect restores state, never past user input. */
export class NodeController {
	private phase: State = 'stopped'
	private commands: CompanionPrototype | undefined
	private queue = new CommandQueue()
	private stopSignal = new AbortController()
	private stopRequested = true
	private running: Promise<void> | undefined
	private endSession: { resolve(): void; reject(error: Error): void } | undefined
	private healthTimer: ReturnType<typeof setInterval> | undefined
	private readonly listeners = new Set<() => void>()
	private readonly discover: () => Promise<ControllerTarget>
	private epoch = 0
	private playing: MetadataSnapshot['nowPlaying'] = { state: 'Unknown' }
	reconnects = 0
	constructor(
		private readonly deviceId: string,
		private readonly credentials: HAPCredentials,
		private readonly options: Options = {},
	) {
		this.discover =
			options.discover ??
			(async () => {
				const devices = (await scan({ timeout: 5000, signal: this.stopSignal.signal })).filter(
					(device) => device.deviceId === this.deviceId && device.model.startsWith('AppleTV'),
				)
				if (devices.length !== 1 || !devices[0].companionPort || !devices[0].port)
					throw new Error('Selected Companion or metadata service unavailable')
				return { address: devices[0].address, companionPort: devices[0].companionPort, airplayPort: devices[0].port }
			})
	}
	get state(): State {
		return this.phase
	}
	get feedback(): CommandState | undefined {
		return this.commands?.state
	}
	get nowPlaying(): MetadataSnapshot['nowPlaying'] {
		return { ...this.playing }
	}
	get audioRevision(): number {
		return this.commands?.audioRevision ?? -1
	}
	get audioOutputIdentity(): string | undefined {
		return this.commands?.audioOutputIdentity
	}
	observe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private changed(): void {
		for (const listener of this.listeners) listener()
	}
	private setState(state: State): void {
		this.phase = state
		this.changed()
	}

	start(): void {
		if (this.running) return
		this.stopRequested = false
		this.stopSignal = new AbortController()
		this.running = this.run().finally(() => {
			this.running = undefined
			this.setState('stopped')
		})
	}

	async waitUntilReady(timeoutMs = 20000): Promise<void> {
		if (this.phase === 'ready') return
		if (!this.running) throw new CommandNotSent('Controller is stopped')
		let unsubscribe = (): void => {}
		try {
			await bounded(
				async () =>
					new Promise<void>((resolve) => {
						unsubscribe = this.observe(() => {
							if (this.phase === 'ready') resolve()
						})
					}),
				timeoutMs,
				this.stopSignal.signal,
			)
		} finally {
			unsubscribe()
		}
	}

	async perform(action: RemoteAction): Promise<void> {
		const commands = this.commands
		const session = this.endSession
		if (this.stopRequested || this.phase !== 'ready' || !commands?.active || !session)
			throw new CommandNotSent('Not connected; command not sent')
		const audioRevision = commands.audioRevision
		await this.queueCommand(session, 'Control failed; delivery uncertain', async () => {
			if ((action.kind === 'volume' || action.kind === 'mute') && audioRevision !== commands.audioRevision)
				throw new UnsupportedCommand('Audio output changed while the command was queued')
			switch (action.kind) {
				case 'button':
					return commands.press(action.button)
				case 'media':
					return commands.media(action.command)
				case 'seek':
					return commands.seek(action.seconds)
				case 'volume':
					return commands.setVolume(action.percent)
				case 'swipe':
					return commands.swipe(action.direction)
				case 'launch':
					return commands.launchApp(action.bundleId)
				case 'power':
					return action.state === undefined ? commands.togglePower() : commands.setPower(action.state)
				case 'mute':
					return commands.toggleMute()
				default:
					throw new RangeError('Unknown action')
			}
		})
	}

	private async query<T>(operation: (commands: CompanionPrototype) => Promise<T>): Promise<T> {
		const commands = this.commands
		const session = this.endSession
		if (this.stopRequested || this.phase !== 'ready' || !commands?.active || !session)
			throw new CommandNotSent('Not connected; query not sent')
		return this.queueCommand(session, 'Status query failed', async () => operation(commands))
	}

	async queryPower(): Promise<Power> {
		return this.query(async (commands) => commands.readPower())
	}

	async queryVolume(): Promise<number> {
		return this.query(async (commands) => commands.readVolume())
	}

	async listApps(): Promise<{ id: string; name: string }[]> {
		return this.query(async (commands) => commands.listApps())
	}

	private async queueCommand<T>(
		session: { reject(error: Error): void },
		failureReason: string,
		operation: () => Promise<T>,
	): Promise<T> {
		return this.queue.run(async () => {
			try {
				return await operation()
			} catch (error) {
				if (!(
					error instanceof CommandNotSent ||
					error instanceof RangeError ||
					error instanceof UnsupportedCommand ||
					error instanceof CompanionRequestRejected
				)) {
					// Invalidate before this operation settles and the next queued item starts.
					this.failSession(session, failureReason)
				}
				throw error
			}
		})
	}

	private failSession(session: { reject(error: Error): void }, reason: string): void {
		if (session !== this.endSession) return
		this.queue.invalidate()
		this.setState('reconnecting')
		session.reject(new Error(reason))
	}

	private async run(): Promise<void> {
		const signal = this.stopSignal.signal
		let delayMs = this.options.reconnectDelayMs ?? 2000
		let connectedBefore = false
		while (!this.stopRequested) {
			this.epoch++
			const epoch = this.epoch
			this.queue = new CommandQueue()
			this.setState(connectedBefore ? 'reconnecting' : 'connecting')
			try {
				const target = await bounded(this.discover, 7000, signal)
				let snapshot: MetadataSnapshot = {
					connected: false,
					nowPlaying: { state: 'Unknown' },
					audio: { absolute: false, relative: false },
				}
				await (this.options.metadataSession ?? withMetadataSession)(
					{ address: target.address, port: target.airplayPort },
					this.credentials,
					signal,
					(next) => {
						if (epoch !== this.epoch) return
						snapshot = next
						this.playing = { ...next.nowPlaying }
						this.commands?.observeMetadata(next)
						if (!next.connected && this.endSession && !this.stopRequested)
							this.failSession(this.endSession, 'Metadata connection lost')
					},
					async (metadataSignal) => {
						await (this.options.session ?? withCompanionSession)(
							target,
							this.credentials,
							metadataSignal,
							async (commands) => {
								commands.observeMetadata(snapshot)
								await commands.listApps() // Genuine read-only round trip before accepting input.
								try {
									await commands.readPower()
								} catch {
									/* Power can remain Unknown while navigation works. */
								}
								if (this.stopRequested || epoch !== this.epoch || !commands.active) return
								commands.observeMetadata(snapshot)
								this.commands = commands
								const end = Promise.withResolvers<void>()
								this.endSession = end
								if (connectedBefore) this.reconnects++
								connectedBefore = true
								delayMs = this.options.reconnectDelayMs ?? 2000
								const stopObserving = commands.observe(() => this.changed())
								this.setState('ready')
								this.healthTimer = setInterval(() => {
									if (this.queue.busy || this.stopRequested) return
									void this.queue
										.run(async () => {
											try {
												await commands.listApps()
											} catch (error) {
												this.failSession(end, 'Health check failed')
												throw error
											}
										})
										.catch(() => {
											// Failures were handled before advancing the queue; invalidated checks were not sent.
										})
								}, this.options.healthIntervalMs ?? 30000)
								try {
									await end.promise
								} finally {
									stopObserving()
								}
							},
						)
					},
				)
			} catch {
				// No command crosses this boundary. Only discovery and session setup repeat.
			} finally {
				clearInterval(this.healthTimer)
				this.healthTimer = undefined
				this.queue.invalidate()
				this.commands?.invalidate()
				this.commands = undefined
				this.playing = { state: 'Unknown' }
				this.endSession?.resolve()
				this.endSession = undefined
			}
			if (this.stopRequested) break
			this.setState('reconnecting')
			try {
				await delay(delayMs, undefined, { signal })
			} catch {
				break
			}
			delayMs = Math.min(delayMs * 2, 30000)
		}
	}

	async stop(): Promise<void> {
		this.stopRequested = true
		this.queue.invalidate()
		// Idle sessions can acknowledge cleanup. Busy/connecting sessions cancel now.
		if (this.endSession && !this.queue.busy) this.endSession.resolve()
		else this.stopSignal.abort()
		await this.running
		this.stopSignal.abort()
	}
}
