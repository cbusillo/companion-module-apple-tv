/** Candidate command layer: callers supply an initialized Companion session. */
import { OpackFloat, type AppleTV, type OpackDict, type OpackValue } from 'node-appletv-remote'
import { setTimeout as delay } from 'node:timers/promises'

type Client = Pick<AppleTV, 'sendCompanionRequest'> & Partial<Pick<AppleTV, 'sendCompanionMessage'>>
export type Power = 'On' | 'Off' | 'Unknown'
export type Direction = 'up' | 'down' | 'left' | 'right'
const BUTTONS = {
	up: 1,
	down: 2,
	left: 3,
	right: 4,
	back: 5,
	select: 6,
	home: 7,
	volumeUp: 8,
	volumeDown: 9,
	screensaver: 11,
	playPause: 14,
	controlCenter: 19,
}
export type Button = keyof typeof BUTTONS | 'appSwitcher' | 'homeHold'
const MEDIA = { play: [1, 1], pause: [2, 2], next: [3, 4], previous: [4, 8] } as const
export type MediaCommand = keyof typeof MEDIA
export type CommandState = {
	power: Power
	mediaFlags: number | null
	volume: number | null
	mute: 'Muted' | 'Unmuted' | 'Unavailable'
	outputKnown: boolean
}
type Options = { signal?: AbortSignal; now?: () => bigint; pause?: (ms: number) => Promise<void> }

export class CompanionRequestRejected extends Error {}
export class UnsupportedCommand extends Error {}

function powerState(state: unknown): Power {
	return state === 1 ? 'Off' : state === 2 || state === 3 || state === 4 ? 'On' : 'Unknown'
}

export async function companionRequest(
	client: Client,
	identifier: string,
	entries: [string, OpackValue][] = [],
): Promise<OpackDict> {
	const envelope: OpackDict = new Map<OpackValue, OpackValue>([
		['_t', 2],
		['_c', new Map<OpackValue, OpackValue>(entries)],
	])
	// One request, no retry: a timeout cannot prove a command was not delivered.
	const reply = await client.sendCompanionRequest(identifier, envelope, 3000)
	if (reply.has('_em') || reply.has('_ec')) throw new CompanionRequestRejected('Apple TV rejected the request')
	if (reply.get('_t') !== 3) throw new Error('Invalid Companion response type')
	const content = reply.get('_c')
	if (!(content instanceof Map)) throw new Error('Missing Companion response content')
	return content
}

/** High-level commands composed through the library's public messaging API. */
export class CompanionPrototype {
	private power: Power = 'Unknown'
	private powerAt = 0n
	private powerRevision = 0
	private mediaFlags: number | null = null
	private volume: number | null = null
	private output: string | undefined
	private outputRevision = 0
	private savedVolume: number | undefined
	private touchStart: bigint | undefined
	private valid = true
	private readonly listeners = new Set<() => void>()
	private readonly now: () => bigint
	private readonly pause: (ms: number) => Promise<void>
	constructor(
		private readonly client: Client,
		private readonly options: Options = {},
	) {
		this.now = options.now ?? (() => process.hrtime.bigint())
		this.pause = options.pause ?? (async (ms) => delay(ms, undefined, { signal: options.signal }))
	}

	get state(): CommandState {
		return {
			power: this.power,
			mediaFlags: this.mediaFlags,
			volume: this.volume,
			outputKnown: this.output !== undefined,
			mute:
				this.savedVolume !== undefined
					? 'Muted'
					: this.output === undefined || this.volume === null
						? 'Unavailable'
						: 'Unmuted',
		}
	}
	get active(): boolean {
		return this.valid && !this.options.signal?.aborted
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

	/** Only the authenticated metadata connection may supply an output identity. */
	observeOutput(devices: readonly string[] | undefined): void {
		const next =
			devices?.length && devices.every((id) => typeof id === 'string' && id.length > 0)
				? JSON.stringify([...new Set(devices)].sort())
				: undefined
		if (next !== this.output) {
			this.output = next
			this.volume = null
			this.outputRevision++
			this.savedVolume = undefined
			this.changed()
		}
	}

	receiveEvent(event: { identifier?: string; data: OpackDict }): void {
		const content = event.data.get('_c')
		if (event.data.get('_t') !== 1 || !(content instanceof Map)) return
		if (event.identifier === 'SystemStatus' || event.identifier === 'TVSystemStatus') {
			this.power = powerState(content.get('state'))
			this.powerAt = this.now()
			this.powerRevision++
		} else if (event.identifier === '_iMC') {
			const flags = content.get('_mcF')
			this.mediaFlags =
				typeof flags === 'number' && Number.isInteger(flags) && flags >= 0 && flags <= 0xffffffff ? flags : null
			this.volume = null
			if (this.mediaFlags === null || !(this.mediaFlags & 0x100)) {
				this.savedVolume = undefined
				this.outputRevision++
			}
		} else return
		this.changed()
	}

	invalidate(): void {
		this.valid = false
		this.power = 'Unknown'
		this.powerRevision++
		this.mediaFlags = null
		this.volume = null
		this.output = undefined
		this.outputRevision++
		this.savedVolume = undefined
		this.changed()
	}

	private event(identifier: string, entries: [string, OpackValue][]): void {
		this.options.signal?.throwIfAborted()
		if (!this.client.sendCompanionMessage) throw new UnsupportedCommand('Companion events are unavailable')
		this.client.sendCompanionMessage(
			identifier,
			new Map<OpackValue, OpackValue>([
				['_t', 1],
				['_c', new Map(entries)],
			]),
		)
	}

	subscribe(): void {
		this.event('_interest', [['_regEvents', ['SystemStatus', 'TVSystemStatus', '_iMC']]])
	}
	unsubscribe(): void {
		this.event('_interest', [['_deregEvents', ['SystemStatus', 'TVSystemStatus', '_iMC']]])
	}

	private supported(flag: number): void {
		if (this.mediaFlags !== null && !(this.mediaFlags & flag))
			throw new UnsupportedCommand('Unavailable for current playback or output')
	}

	private async request(identifier: string, entries: [string, OpackValue][] = []): Promise<OpackDict> {
		this.options.signal?.throwIfAborted()
		return companionRequest(this.client, identifier, entries)
	}

	async listApps(): Promise<{ id: string; name: string }[]> {
		const content = await this.request('FetchLaunchableApplicationsEvent')
		return [...content].map(([id, name]) => {
			if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Invalid app-list response')
			return { id, name }
		})
	}

	async launchApp(bundleId: string): Promise<void> {
		if (!bundleId.trim() || bundleId.length > 255) throw new RangeError('An app bundle identifier is required')
		await this.request('_launchApp', [['_bundleID', bundleId]])
	}

	async seek(seconds: number): Promise<void> {
		if (!Number.isFinite(seconds) || seconds === 0 || Math.abs(seconds) > 60) {
			throw new RangeError('Seek must be nonzero and within sixty seconds')
		}
		this.supported(seconds > 0 ? 0x200 : 0x400)
		await this.request('_mcc', [
			['_mcc', 7],
			['_skpS', new OpackFloat(seconds)],
		])
	}

	async readVolume(): Promise<number> {
		this.supported(0x100)
		const content = await this.request('_mcc', [['_mcc', 5]])
		const volume = content.get('_vol')
		if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
			throw new UnsupportedCommand('Volume is unavailable')
		}
		this.volume = volume * 100
		if (volume > 0) this.savedVolume = undefined
		this.changed()
		return this.volume
	}

	async setVolume(percent: number): Promise<void> {
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('Volume must be 0–100')
		this.supported(0x100)
		this.savedVolume = undefined
		this.changed()
		await this.writeVolume(percent)
	}

	private async writeVolume(percent: number): Promise<void> {
		this.volume = null
		this.changed()
		await this.request('_mcc', [
			['_mcc', 6],
			['_vol', new OpackFloat(percent / 100)],
		])
	}

	async readPower(): Promise<Power> {
		const revision = this.powerRevision
		try {
			const content = await this.request('FetchAttentionState')
			if (revision === this.powerRevision) {
				this.power = powerState(content.get('state'))
				this.powerAt = this.now()
			}
		} catch (error) {
			if (!(error instanceof CompanionRequestRejected)) throw error
			if (this.now() - this.powerAt > 30_000_000_000n) this.power = 'Unknown'
		}
		this.changed()
		return this.power
	}

	async togglePower(): Promise<void> {
		const state = await this.readPower()
		if (state === 'Unknown') throw new UnsupportedCommand('Unknown power state; no power command sent')
		await this.setPower(state === 'On' ? 'Off' : 'On')
	}

	/** Explicit sleep/wake cannot turn into the opposite command if state changes. */
	async setPower(state: 'On' | 'Off'): Promise<void> {
		if (state !== 'On' && state !== 'Off') throw new RangeError('Power target must be On or Off')
		const revision = this.powerRevision
		await this.request('_hidC', [
			['_hBtS', 2],
			['_hidC', state === 'Off' ? 12 : 13],
		])
		if (revision === this.powerRevision) this.power = 'Unknown'
		this.changed()
	}

	async media(command: MediaCommand): Promise<void> {
		if (!Object.hasOwn(MEDIA, command)) throw new RangeError('Invalid media command')
		const [code, flag] = MEDIA[command]
		this.supported(flag)
		await this.request('_mcc', [['_mcc', code]])
	}

	/** Call through the controller queue so down/up and multi-taps stay atomic. */
	async press(button: Button): Promise<void> {
		if (button === 'volumeUp' || button === 'volumeDown') {
			this.savedVolume = undefined
			this.changed()
		}
		if (button === 'appSwitcher') {
			await this.pressCode(7)
			await this.pressCode(7)
		} else if (button === 'homeHold') await this.pressCode(7, 1000)
		else {
			if (!Object.hasOwn(BUTTONS, button)) throw new RangeError('Invalid remote button')
			await this.pressCode(BUTTONS[button])
		}
	}

	private async pressCode(code: number, holdMs = 0): Promise<void> {
		let failed = false
		let failure: unknown
		try {
			await this.request('_hidC', [
				['_hBtS', 1],
				['_hidC', code],
			])
			if (holdMs) await this.pause(holdMs)
		} catch (error) {
			failed = true
			failure = error
		}
		try {
			// Release once. A rejected release must not hide uncertain delivery of down.
			await this.request('_hidC', [
				['_hBtS', 2],
				['_hidC', code],
			])
		} catch (error) {
			if (!failed) throw error
		}
		if (failed) throw failure
	}

	async swipe(direction: Direction): Promise<void> {
		const paths = {
			up: [500, 900, 500, 100],
			down: [500, 100, 500, 900],
			left: [900, 500, 100, 500],
			right: [100, 500, 900, 500],
		}
		if (!Object.hasOwn(paths, direction)) throw new RangeError('Invalid swipe direction')
		if (this.touchStart === undefined) {
			await this.request('_touchStart', [
				['_height', new OpackFloat(1000)],
				['_width', new OpackFloat(1000)],
				['_tFl', 0],
			])
			this.touchStart = this.now()
		}
		const [x0, y0, x1, y1] = paths[direction]
		const started = this.now()
		const send = (phase: number, x: number, y: number): void =>
			this.event('_hidT', [
				['_ns', this.now() - this.touchStart!],
				['_tFg', 1],
				['_cx', Math.round(x)],
				['_cy', Math.round(y)],
				['_tPh', phase],
			])
		try {
			send(1, x0, y0)
			for (let frame = 0; frame < 7; frame++) {
				const elapsed = Number(this.now() - started) / 1e6
				if (elapsed >= 100) break
				await this.pause(Math.min(16, 100 - elapsed))
				const progress = Math.min(1, Number(this.now() - started) / 100_000_000)
				if (progress < 1) send(3, x0 + (x1 - x0) * progress, y0 + (y1 - y0) * progress)
			}
		} finally {
			send(4, x1, y1)
		}
	}

	async stopTouch(): Promise<void> {
		if (this.touchStart === undefined) return
		this.touchStart = undefined
		await this.request('_touchStop', [['_i', 1]])
	}

	async toggleMute(): Promise<void> {
		if (this.output === undefined)
			throw new UnsupportedCommand('Audio output identity is unavailable; mute restore is disabled')
		const revision = this.outputRevision
		const volume = await this.readVolume()
		if (revision !== this.outputRevision || this.output === undefined)
			throw new UnsupportedCommand('Audio output changed')
		const restore = this.savedVolume
		this.savedVolume = undefined
		if (restore !== undefined) await this.writeVolume(restore)
		else if (volume > 0) {
			await this.writeVolume(0)
			if (revision === this.outputRevision) this.savedVolume = volume
		} else throw new UnsupportedCommand('No saved volume to restore')
		this.changed()
	}
}
