import { setTimeout as delay } from 'node:timers/promises'
import { AirPlayConnection, scan, type DiscoveredDevice, type HAPCredentials } from 'node-appletv-remote'
import { loadTestCredentials } from './credentials.js'
import { MetadataState, type MetadataSnapshot } from './metadata.js'
import { bounded } from './session.js'

type Connection = Pick<AirPlayConnection, 'connect' | 'close' | 'on' | 'off'>
type Dependencies = {
	load?: typeof loadTestCredentials
	discover?: () => Promise<DiscoveredDevice[]>
	createConnection?: (target: DiscoveredDevice, credentials: HAPCredentials) => Connection
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
	if (!Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 60)
		throw new Error('Observation duration must be 5-60 seconds')
	options.signal.throwIfAborted()
	const state = new MetadataState()
	const stop = new AbortController()
	const signal = AbortSignal.any([options.signal, stop.signal])
	const startup = setTimeout(() => stop.abort(new Error('Metadata startup timed out')), startupMs)
	let connection: Connection | undefined
	let closing = false
	let reportFailed = false
	let lastSnapshot = ''
	const publish = (): void => {
		if (reportFailed) return
		const snapshot = state.snapshot()
		const encoded = JSON.stringify(snapshot)
		if (encoded === lastSnapshot) return
		lastSnapshot = encoded
		try {
			options.onSnapshot(snapshot)
		} catch {
			reportFailed = true
			stop.abort(new Error('Metadata report failed'))
		}
	}
	const onLost = (): void => {
		if (closing || signal.aborted) return
		state.invalidate()
		publish()
		stop.abort(new Error('Metadata connection lost'))
	}
	const onMessage = (message: Record<string, unknown>): void => {
		if (closing || signal.aborted) return
		state.receive(message)
		publish()
	}
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
		if (matches.length !== 1) throw new Error('Selected TV not uniquely discovered')
		connection = dependencies.createConnection
			? dependencies.createConnection(matches[0], saved.credentials)
			: new AirPlayConnection(matches[0].address, matches[0].port, saved.credentials, { logger: () => {} })
		connection.on('mrp-message', onMessage)
		connection.on('error', onLost)
		connection.on('close', onLost)
		await bounded(async () => connection!.connect({ signal }), undefined, signal)
		signal.throwIfAborted()
		clearTimeout(startup)
		state.setConnected()
		publish()
		await delay(options.seconds * 1000, undefined, { signal })
	} catch {
		if (reportFailed) throw new Error('Metadata report failed')
		if (options.signal.aborted) throw new Error('Metadata observation cancelled')
		if (stop.signal.reason instanceof Error) throw stop.signal.reason
		throw new Error('Metadata connection failed')
	} finally {
		clearTimeout(startup)
		closing = true
		try {
			connection?.close()
		} finally {
			connection?.off('mrp-message', onMessage)
			connection?.off('error', onLost)
			connection?.off('close', onLost)
			state.invalidate()
			publish()
		}
	}
	if (reportFailed) throw new Error('Metadata report failed')
}
