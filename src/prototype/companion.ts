/** Offline candidate: callers must establish and initialize a Companion session. */
import { OpackFloat, type AppleTV, type OpackDict, type OpackValue } from 'node-appletv-remote'

type Client = Pick<AppleTV, 'sendCompanionRequest'>

/** High-level commands composed through the library's public messaging API. */
export class CompanionPrototype {
	constructor(private readonly client: Client) {}

	private async request(identifier: string, entries: [string, OpackValue][] = []): Promise<OpackDict> {
		const envelope: OpackDict = new Map<OpackValue, OpackValue>([
			['_t', 2],
			['_c', new Map<OpackValue, OpackValue>(entries)],
		])
		// One request, no retry: a timeout cannot prove a command was not delivered.
		const reply = await this.client.sendCompanionRequest(identifier, envelope, 3000)
		if (reply.has('_em') || reply.has('_ec')) throw new Error('Apple TV rejected the request')
		if (reply.get('_t') !== 3) throw new Error('Invalid Companion response type')
		const content = reply.get('_c')
		if (!(content instanceof Map)) throw new Error('Missing Companion response content')
		return content
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
		await this.request('_mcc', [
			['_mcc', 7],
			['_skpS', new OpackFloat(seconds)],
		])
	}

	async readVolume(): Promise<number> {
		const content = await this.request('_mcc', [['_mcc', 5]])
		const volume = content.get('_vol')
		if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
			throw new Error('Volume is unavailable')
		}
		return volume * 100
	}

	async setVolume(percent: number): Promise<void> {
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('Volume must be 0–100')
		await this.request('_mcc', [
			['_mcc', 6],
			['_vol', new OpackFloat(percent / 100)],
		])
	}

	async readPower(): Promise<'On' | 'Off' | 'Unknown'> {
		const content = await this.request('FetchAttentionState')
		switch (content.get('state')) {
			case 1:
				return 'Off'
			case 2:
			case 3:
			case 4:
				return 'On'
			default:
				return 'Unknown'
		}
	}
}
