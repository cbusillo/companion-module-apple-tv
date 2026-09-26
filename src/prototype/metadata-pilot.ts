import { setTimeout as delay } from 'node:timers/promises'
import { scan, type DiscoveredDevice, type HAPCredentials } from 'node-appletv-remote'
import { loadTestCredentials } from './credentials.js'
import type { MetadataSnapshot } from './metadata.js'
import { withMetadataSession, type MetadataConnection } from './metadata-session.js'
import { bounded } from './session.js'

type Dependencies = {
	load?: typeof loadTestCredentials
	discover?: () => Promise<DiscoveredDevice[]>
	createConnection?: (target: DiscoveredDevice, credentials: HAPCredentials) => MetadataConnection
}
export type MetadataPilotOptions = {
	credentialsPath: string
	seconds: number
	signal: AbortSignal
	onSnapshot: (snapshot: MetadataSnapshot) => void
}

/** Bounded native observation, with no controls, PIN pairing, reconnect or retry. */
export async function observeMetadata(
	options: MetadataPilotOptions,
	dependencies: Dependencies = {},
	startupMs = 20000,
): Promise<void> {
	if (!Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 180)
		throw new Error('Observation duration must be 5-180 seconds')
	options.signal.throwIfAborted()
	const stop = new AbortController()
	const signal = AbortSignal.any([options.signal, stop.signal])
	const startup = setTimeout(() => stop.abort(new Error('Metadata startup timed out')), startupMs)
	try {
		const saved = await bounded(
			async () => (dependencies.load ?? loadTestCredentials)(options.credentialsPath),
			undefined,
			signal,
		)
		const devices = await bounded(
			dependencies.discover ?? (async () => scan({ timeout: 5000, signal })),
			undefined,
			signal,
		)
		const matches = devices.filter((device) => device.deviceId === saved.deviceId && device.model.startsWith('AppleTV'))
		if (matches.length !== 1) throw new Error('Metadata connection failed: selected TV not uniquely discovered')
		await withMetadataSession(
			matches[0],
			saved.credentials,
			signal,
			options.onSnapshot,
			async (active) => {
				clearTimeout(startup)
				await delay(options.seconds * 1000, undefined, { signal: active })
			},
			dependencies.createConnection ? () => dependencies.createConnection!(matches[0], saved.credentials) : undefined,
		)
	} catch (error) {
		if (options.signal.aborted) throw new Error('Metadata observation cancelled', { cause: error })
		if (stop.signal.reason instanceof Error) throw stop.signal.reason
		throw error
	} finally {
		clearTimeout(startup)
	}
}
