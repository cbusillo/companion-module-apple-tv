import { CompanionPairSetup, scan, type DiscoveredDevice, type HAPCredentials } from 'node-appletv-remote'
import { NodeController, type RemoteAction } from './prototype/controller.js'
import { bounded } from './prototype/session.js'
import { CommandNotSent } from './prototype/queue.js'
import { CompanionRequestRejected, UnsupportedCommand } from './prototype/companion.js'
import { decodePairing, encodePairing, type ModuleSecrets, type SavedPairing } from './node-credentials.js'
import { displayDefaults, displayValues, type DisplayValues } from './display.js'
import { PlaybackClock } from './playback.js'
import type { DeviceChoice, ModuleConfig } from './config.js'

type Controller = Pick<
	NodeController,
	'state' | 'feedback' | 'nowPlaying' | 'start' | 'stop' | 'waitUntilReady' | 'observe' | 'perform' | 'listApps'
>
type Pairing = Pick<CompanionPairSetup, 'start' | 'finish' | 'destroy' | 'closed' | 'stage'>
export type SetupState =
	| 'disabled'
	| 'unpaired'
	| 'discovering'
	| 'pairing'
	| 'pin'
	| 'verifying'
	| 'connecting'
	| 'ready'
	| 'reconnecting'
	| 'error'
export type BackendHooks = {
	save(config: ModuleConfig, secrets: ModuleSecrets): void
	status(state: SetupState, message: string): void
	values(values: Partial<DisplayValues> & { connection?: string; last_result?: string }): void
	apps(apps: { id: string; name: string }[]): void
}
export type BackendOptions = {
	discover?: typeof scan
	pairing?: (device: DiscoveredDevice) => Pairing
	controller?: (deviceId: string, credentials: HAPCredentials) => Controller
	pinTimeoutMs?: number
}

type PendingPair = {
	deviceId: string
	pair: Pairing
	abort: AbortController
	timer?: NodeJS.Timeout
	finishing: boolean
}

/** Owns setup and the connection; only explicit Pair starts a TV PIN prompt. */
export class NodeBackend {
	devices: DeviceChoice[] = []
	private config: ModuleConfig = { enabled: false, deviceId: '' }
	private secrets: ModuleSecrets = {}
	private generation = 0
	private abort = new AbortController()
	private pending?: PendingPair
	private controller?: Controller
	private unsubscribe?: () => void
	private timer?: NodeJS.Timeout
	private clock = new PlaybackClock()
	private state: SetupState = 'disabled'
	private lastValues = ''
	private activeRecord?: string
	private appsGeneration = 0
	private verification?: Promise<void>
	constructor(
		private readonly hooks: BackendHooks,
		private readonly options: BackendOptions = {},
	) {}

	private status(state: SetupState, message: string): void {
		this.state = state
		this.hooks.status(state, message)
		this.hooks.values({ connection: state })
	}
	private save(): void {
		this.hooks.save({ ...this.config, pair: false, refresh: false }, { ...this.secrets })
	}
	private async discover(signal: AbortSignal): Promise<DiscoveredDevice[]> {
		const devices = (
			await bounded(async () => (this.options.discover ?? scan)({ timeout: 5000, signal }), 7000, signal)
		).filter((device) => device.model.startsWith('AppleTV') && device.deviceId && device.companionPort && device.port)
		if (signal.aborted) throw new Error('Discovery cancelled')
		this.devices = [
			...new Map(
				devices.map((device) => [
					device.deviceId,
					{ id: device.deviceId, label: `${device.name} (${device.address})` },
				]),
			).values(),
		]
		// Companion reloads configuration fields on a saved-config notification.
		// Notify after discovery, not only when consuming the Refresh checkbox.
		this.save()
		return devices
	}
	async configure(config: ModuleConfig, secrets: ModuleSecrets = {}): Promise<void> {
		const pairRequested = config.pair === true
		const refreshRequested = config.refresh === true
		const pin = typeof secrets.pin === 'string' ? secrets.pin.trim() : ''
		this.config = {
			...config,
			deviceId: typeof config.deviceId === 'string' ? config.deviceId : '',
			pair: false,
			refresh: false,
		}
		this.secrets = { ...secrets }
		delete this.secrets.pin
		if (pairRequested || refreshRequested || secrets.pin !== undefined) this.save()
		if (!config.enabled) {
			const generation = this.generation + 1
			await this.stop()
			if (generation === this.generation) this.status('disabled', 'Disabled')
			return
		}
		if (this.pending && this.pending.deviceId === this.config.deviceId && !pairRequested) {
			if (this.pending.finishing) return
			if (pin) {
				const verification = this.finishPairing(pin)
				this.verification = verification
				try {
					await verification
				} finally {
					if (this.verification === verification) this.verification = undefined
				}
			} else this.status('pin', 'Enter the PIN shown on Apple TV and Save')
			return
		}
		if (
			!pairRequested &&
			this.controller &&
			this.activeRecord === JSON.stringify(this.secrets.pairing) &&
			this.secrets.pairing?.deviceId === this.config.deviceId
		) {
			if (refreshRequested) {
				const generation = this.generation
				try {
					await this.discover(this.abort.signal)
				} catch {
					if (generation === this.generation)
						this.hooks.values({ last_result: 'Device discovery failed; connection retained' })
				}
			}
			return
		}
		const generation = this.generation + 1
		await this.stop()
		if (generation !== this.generation) return
		const signal = this.abort.signal
		if (!this.config.deviceId) {
			this.status('discovering', 'Looking for Apple TVs')
			try {
				await this.discover(signal)
			} catch {
				/* Selection remains empty and no pairing starts. */
			}
			if (generation === this.generation) this.status('unpaired', 'Select an Apple TV, check Start pairing, then Save')
			return
		}
		if (pairRequested) {
			this.status('pairing', 'Requesting a PIN from the selected Apple TV')
			try {
				const matches = (await this.discover(signal)).filter((device) => device.deviceId === this.config.deviceId)
				if (matches.length !== 1) throw new Error('Selected TV not uniquely discovered')
				signal.throwIfAborted()
				const pair =
					this.options.pairing?.(matches[0]) ?? new CompanionPairSetup(matches[0].address, matches[0].companionPort!)
				const pending: PendingPair = { deviceId: this.config.deviceId, pair, abort: this.abort, finishing: false }
				this.pending = pending
				await bounded(async () => pair.start({ signal }), 15000, signal)
				if (generation !== this.generation) return
				void pair.closed.then(() => {
					if (this.pending !== pending || pending.finishing || generation !== this.generation) return
					this.clearPairing()
					this.status('error', 'Apple TV closed the pairing session. Start pairing again to request a new PIN')
				})
				pending.timer = setTimeout(() => {
					if (this.pending !== pending) return
					pending.abort.abort()
					pending.pair.destroy()
					this.pending = undefined
					this.status('error', 'Pairing expired. Check Start pairing and Save to try again')
				}, this.options.pinTimeoutMs ?? 180000)
				this.status('pin', 'Enter the PIN shown on Apple TV and Save')
			} catch {
				if (generation !== this.generation) return
				this.clearPairing()
				this.status('error', 'Could not start pairing. Check the TV and network, then choose Start pairing again')
			}
			return
		}
		if (refreshRequested || this.devices.length === 0) {
			try {
				await this.discover(signal)
			} catch {
				/* The controller owns reconnect discovery. */
			}
			if (generation !== this.generation) return
		}
		try {
			const saved = decodePairing(this.secrets.pairing)
			if (saved.deviceId !== this.config.deviceId) throw new Error('Different TV')
			await this.connect(saved.deviceId, saved.credentials, generation)
		} catch {
			if (generation === this.generation) this.status('unpaired', 'Pair this Apple TV before connecting')
		}
	}
	private clearPairing(): void {
		if (!this.pending) return
		clearTimeout(this.pending.timer)
		this.pending.pair.destroy()
		this.pending = undefined
	}
	private async finishPairing(pin: string): Promise<void> {
		const pending = this.pending!
		if (!/^\d{4}$/.test(pin)) {
			this.status('pin', 'Enter exactly four digits from the TV')
			return
		}
		const generation = this.generation
		const previousSecrets = this.secrets
		pending.finishing = true
		clearTimeout(pending.timer)
		this.status('verifying', 'Verifying the new pairing')
		let candidate: Controller | undefined
		let verifyingConnection = false
		try {
			const credentials = await bounded(async () => pending.pair.finish(pin), 15000, pending.abort.signal)
			pending.abort.signal.throwIfAborted()
			verifyingConnection = true
			candidate = this.makeController(pending.deviceId, credentials)
			candidate.start()
			await bounded(async () => candidate!.waitUntilReady(20000), 22000, pending.abort.signal)
			if (generation !== this.generation) return
			// Save only after fresh sessions authenticate both protocols and pass read-only health.
			const pairing = encodePairing(pending.deviceId, credentials)
			this.secrets = { pairing }
			this.save()
			this.clearPairing()
			this.attach(candidate, pairing)
			candidate = undefined
		} catch {
			if (generation === this.generation) {
				this.secrets = previousSecrets
				this.clearPairing()
				const failure = verifyingConnection
					? 'The PIN exchange completed, but the new connection could not be verified.'
					: pending.pair.stage === 'identity'
						? 'Apple TV identity verification failed.'
						: pending.pair.stage === 'proof'
							? 'The PIN could not be verified with Apple TV.'
							: 'The pairing session closed before the PIN could be verified.'
				this.status('error', `${failure} Previous credentials were kept. Start pairing again to retry`)
			}
		} finally {
			await candidate?.stop()
		}
	}
	private makeController(deviceId: string, credentials: HAPCredentials): Controller {
		return this.options.controller?.(deviceId, credentials) ?? new NodeController(deviceId, credentials)
	}
	private async connect(deviceId: string, credentials: HAPCredentials, generation: number): Promise<void> {
		if (generation !== this.generation) return
		const controller = this.makeController(deviceId, credentials)
		this.attach(controller, this.secrets.pairing!)
		controller.start()
	}
	private attach(controller: Controller, pairing: SavedPairing): void {
		this.controller = controller
		this.activeRecord = JSON.stringify(pairing)
		this.unsubscribe = controller.observe(() => this.publish())
		this.timer = setInterval(() => this.publish(), 1000)
		this.publish()
	}
	private publish(): void {
		const controller = this.controller
		if (!controller) return
		const ready = controller.state === 'ready'
		const next = ready ? 'ready' : controller.state === 'reconnecting' ? 'reconnecting' : 'connecting'
		if (this.state !== next) {
			this.status(next, ready ? 'Connected' : 'Connecting to Apple TV')
			if (ready) this.loadApps(controller)
		}
		const playing = ready ? controller.nowPlaying : { state: 'Unknown' as const }
		this.clock.observe(playing)
		const position = this.clock.value()
		const feedback = ready ? controller.feedback : undefined
		const values = {
			...displayDefaults,
			metadata_state: ready ? 'Connected' : 'Offline',
			volume: feedback?.volume == null ? '' : String(feedback.volume),
			mute_state: feedback?.mute ?? 'Unavailable',
			power: feedback?.power ?? 'Unknown',
			title: playing.title ?? 'Nothing Playing',
			artist: playing.artist ?? '',
			app: playing.app ?? '',
			playback_state: playing.state,
			position: position === undefined || !Number.isFinite(position) ? '' : String(Math.floor(position)),
			duration: playing.duration === undefined ? '' : String(playing.duration),
		}
		const displayed = { ...values, ...displayValues(values) }
		const encoded = JSON.stringify(displayed)
		if (encoded !== this.lastValues) {
			this.lastValues = encoded
			this.hooks.values(displayed)
		}
	}
	private loadApps(controller: Controller): void {
		const generation = ++this.appsGeneration
		void controller
			.listApps()
			.then((apps) => {
				if (this.controller === controller && generation === this.appsGeneration) this.hooks.apps(apps)
			})
			.catch(() => {
				/* A failed health query is handled by the controller. */
			})
	}
	async perform(action: RemoteAction | undefined): Promise<void> {
		const controller = this.controller
		if (!action || !controller || controller.state !== 'ready') {
			this.hooks.values({ last_result: !action ? 'unknown command; not sent' : 'not connected; not sent' })
			return
		}
		try {
			await controller.perform(action)
			if (this.controller === controller) this.hooks.values({ last_result: 'dispatched; physical result unverified' })
		} catch (error) {
			if (this.controller !== controller) return
			this.hooks.values({
				last_result:
					error instanceof CommandNotSent
						? 'not sent; connection changed or command expired'
						: error instanceof UnsupportedCommand
							? 'unavailable for current playback or audio output'
							: error instanceof CompanionRequestRejected
								? 'rejected by Apple TV; not retried'
								: 'delivery uncertain; not retried',
			})
		}
	}
	async stop(): Promise<void> {
		this.generation++
		this.appsGeneration++
		this.abort.abort()
		this.abort = new AbortController()
		this.clearPairing()
		this.unsubscribe?.()
		this.unsubscribe = undefined
		clearInterval(this.timer)
		this.timer = undefined
		const controller = this.controller
		this.controller = undefined
		this.activeRecord = undefined
		this.clock = new PlaybackClock()
		this.lastValues = ''
		this.hooks.values({ ...displayDefaults, metadata_state: 'Offline', volume: '', position: '', duration: '' })
		this.hooks.apps([])
		await controller?.stop()
		await this.verification
	}
}
