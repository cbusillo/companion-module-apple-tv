import { AirPlayConnection, type HAPCredentials } from 'node-appletv-remote'
import { MetadataState, type MetadataSnapshot } from './metadata.js'
import { bounded } from './session.js'

export type MetadataTarget = { address: string; port: number }
export type MetadataConnection = Pick<AirPlayConnection, 'connect' | 'close' | 'on' | 'off'>

/** One authenticated lifetime. The operation must honor its signal and finish cleanup before returning. */
export async function withMetadataSession<T>(
	target: MetadataTarget,
	credentials: HAPCredentials,
	ownerSignal: AbortSignal,
	onSnapshot: (snapshot: MetadataSnapshot) => void,
	operation: (signal: AbortSignal) => Promise<T>,
	createConnection: (target: MetadataTarget, credentials: HAPCredentials) => MetadataConnection = (device, keys) =>
		new AirPlayConnection(device.address, device.port, keys, { logger: () => {} }),
): Promise<T> {
	ownerSignal.throwIfAborted()
	const state = new MetadataState()
	const stop = new AbortController()
	const signal = AbortSignal.any([ownerSignal, stop.signal])
	let connection: MetadataConnection | undefined
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
			onSnapshot(snapshot)
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
	let result: T
	try {
		connection = createConnection(target, credentials)
		connection.on('mrp-message', onMessage)
		connection.on('error', onLost)
		connection.on('close', onLost)
		await bounded(async () => connection!.connect({ signal }), 10000, signal)
		signal.throwIfAborted()
		state.setConnected()
		publish()
		signal.throwIfAborted()
		result = await operation(signal)
	} catch {
		if (reportFailed) throw new Error('Metadata report failed')
		if (ownerSignal.aborted) throw new Error('Metadata observation cancelled')
		if (stop.signal.reason instanceof Error) throw stop.signal.reason
		throw new Error('Metadata connection failed')
	} finally {
		closing = true
		stop.abort()
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
	return result
}
