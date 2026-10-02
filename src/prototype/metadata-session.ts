import { AirPlayConnection, MRPMessage, MessageType, type HAPCredentials } from 'node-appletv-remote'
import { MetadataState, type MetadataSnapshot } from './metadata.js'
import { bounded } from './session.js'

export type MetadataTarget = { address: string; port: number }
/** Sends one system-audio route request; resolves true when the TV acknowledged it. */
export type RouteAudio = (outputDeviceUIDs: readonly string[]) => Promise<boolean>
export class OutputRouteRejected extends Error {}
const ROUTE_ACKNOWLEDGEMENT_MS = 3000
export type MetadataConnection = Pick<
	AirPlayConnection,
	'connect' | 'close' | 'on' | 'off' | 'sendMRPMessage' | 'sendMRPMessageAndWait'
>

/**
 * One authenticated lifetime. The operation must honor its signal and finish cleanup before returning.
 * The connection is read-only except for the explicit audio-route sender passed to the operation.
 */
export async function withMetadataSession<T>(
	target: MetadataTarget,
	credentials: HAPCredentials,
	ownerSignal: AbortSignal,
	onSnapshot: (snapshot: MetadataSnapshot) => void,
	operation: (signal: AbortSignal, routeAudio: RouteAudio) => Promise<T>,
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
	let started = false
	let refresh: Promise<void> | undefined
	let refreshRequested = false
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
	const refreshAudio = (): void => {
		refreshRequested = true
		if (refresh) return
		refresh = Promise.resolve()
			.then(async () => {
				while (refreshRequested && !signal.aborted && !closing) {
					refreshRequested = false
					const read = state.beginAudioRead()
					if (!read) continue
					publish()
					signal.throwIfAborted()
					// Repeating true does not refresh tvOS reports. Toggle only this session's
					// volume subscription; the other subscriptions stay enabled throughout.
					for (const volumeUpdates of [false, true]) {
						const request = await MRPMessage.clientUpdatesConfig({
							artworkUpdates: true,
							nowPlayingUpdates: true,
							volumeUpdates,
							keyboardUpdates: true,
							outputDeviceUpdates: true,
						})
						signal.throwIfAborted()
						await connection!.sendMRPMessage(request)
					}
					const request = await MRPMessage.getVolume(read.outputId)
					signal.throwIfAborted()
					const response = await connection!.sendMRPMessageAndWait(request, MessageType.GetVolumeResult, 3000)
					if (signal.aborted || closing) return
					state.finishAudioRead(read, response)
					publish()
				}
			})
			.catch(() => onLost())
			.finally(() => {
				refresh = undefined
				if (refreshRequested && !signal.aborted && !closing) refreshAudio()
			})
	}
	const onMessage = (message: Record<string, unknown>): void => {
		if (closing || signal.aborted) return
		const generation = state.audioGeneration
		state.receive(message)
		if (generation !== state.audioGeneration && (started || generation > 0)) {
			if (started) refreshAudio()
			else refreshRequested = true
		}
		publish()
	}
	// One write and no retry. The acknowledgement only proves receipt; callers confirm the
	// route from later reported output devices. tvOS can take well over the acknowledgement
	// wait to answer while it takes AirPods over from another device, so a late or missing
	// acknowledgement must reject only this wait, never fail the shared connection.
	const routeAudio: RouteAudio = async (outputDeviceUIDs) => {
		signal.throwIfAborted()
		const request = await MRPMessage.setSystemAudioOutputs(outputDeviceUIDs)
		if (closing || signal.aborted || !connection) throw new Error('Metadata connection closed')
		try {
			await connection.sendMRPMessageAndWait(request, undefined, ROUTE_ACKNOWLEDGEMENT_MS, { fatalTimeout: false })
			return true
		} catch (error) {
			if (closing || signal.aborted) throw new Error('Metadata connection closed', { cause: error })
			if (error instanceof Error && error.message.startsWith('AirPlay MRP error'))
				throw new OutputRouteRejected('Apple TV rejected the output change')
			return false
		}
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
		started = true
		if (refreshRequested) refreshAudio()
		publish()
		signal.throwIfAborted()
		result = await operation(signal, routeAudio)
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
			await refresh
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
