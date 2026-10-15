import { AirPlayConnection, MessageType, MRPMessage, type HAPCredentials } from 'node-appletv-remote'
import { MetadataState, type MetadataSnapshot } from './metadata.js'
import { bounded } from './session.js'

export type MetadataTarget = { address: string; port: number }
/** Sends one system-audio route request; resolves true when the TV acknowledged it. */
export type RouteAudio = (outputDeviceUIDs: readonly string[]) => Promise<boolean>
export class OutputRouteRejected extends Error {}
const ROUTE_ACKNOWLEDGEMENT_MS = 3000
/** ModifyOutputContextRequest context that also selects personal outputs such as AirPods (pyatv#2834). */
const SHARED_SYSTEM_AUDIO = 2
export type MetadataConnection = Pick<
	AirPlayConnection,
	'connect' | 'close' | 'on' | 'off' | 'sendMRPMessage' | 'sendMRPMessageAndWait'
>

/** The library logs AirPlay setup progress to stderr; this session reports through its own results. */
class QuietAirPlayConnection extends AirPlayConnection {
	protected override log(): void {}
}

/** A reply that carries a non-zero MRP errorCode is a rejection, not an answer. */
function rejected(reply: Record<string, unknown>): boolean {
	const code = Object.hasOwn(reply, 'errorCode') ? reply.errorCode : undefined
	return typeof code === 'number' && code !== 0
}

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
		new QuietAirPlayConnection(device.address, device.port, keys),
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
	const onLost = (cause?: unknown): void => {
		if (closing || signal.aborted) return
		state.invalidate()
		publish()
		stop.abort(new Error('Metadata connection lost', { cause }))
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
					// tvOS 26 may push no type 17 or 64 after the toggle; its type 63 answer carries the capabilities.
					const capabilities = await MRPMessage.sendCommand(MessageType.GetVolumeControlCapabilities)
					signal.throwIfAborted()
					await connection!.sendMRPMessage(capabilities)
					const request = await MRPMessage.getVolume(read.outputId)
					signal.throwIfAborted()
					const response = await connection!.sendMRPMessageAndWait(request, undefined, 3000)
					if (signal.aborted || closing) return
					if (rejected(response)) throw new Error(`GetVolume rejected with MRP error ${String(response.errorCode)}`)
					state.finishAudioRead(read, response)
					publish()
				}
			})
			.catch((error: unknown) => onLost(error))
			.finally(() => {
				refresh = undefined
				if (refreshRequested && !signal.aborted && !closing) refreshAudio()
			})
	}
	const onMessage = (message: Record<string, unknown>): void => {
		if (closing || signal.aborted) return
		const generation = state.audioGeneration
		state.receive(message)
		// The first output identity also needs a read: tvOS pushes no volume or capability at connect.
		if (generation !== state.audioGeneration) {
			if (started) refreshAudio()
			else refreshRequested = true
		}
		publish()
	}
	// One write and no retry. The acknowledgement only proves receipt; callers confirm the
	// route from later reported output devices. tvOS can take well over the acknowledgement
	// wait to answer while it takes AirPods over from another device, so a late or missing
	// acknowledgement must reject only this wait, never fail the shared connection. The
	// library's reply timeout does exactly that; an error reply resolves with its errorCode.
	const routeAudio: RouteAudio = async (outputDeviceUIDs) => {
		signal.throwIfAborted()
		if (
			outputDeviceUIDs.length === 0 ||
			!outputDeviceUIDs.every((uid) => typeof uid === 'string' && uid.length > 0) ||
			new Set(outputDeviceUIDs).size !== outputDeviceUIDs.length
		)
			throw new TypeError('One or more distinct output device identifiers are required')
		const request = await MRPMessage.modifyOutputDevices('set', [...outputDeviceUIDs], SHARED_SYSTEM_AUDIO)
		if (closing || signal.aborted || !connection) throw new Error('Metadata connection closed')
		let reply: Record<string, unknown>
		try {
			reply = await connection.sendMRPMessageAndWait(request, undefined, ROUTE_ACKNOWLEDGEMENT_MS)
		} catch (error) {
			if (closing || signal.aborted) throw new Error('Metadata connection closed', { cause: error })
			return false
		}
		if (closing || signal.aborted) throw new Error('Metadata connection closed')
		if (rejected(reply)) throw new OutputRouteRejected('Apple TV rejected the output change')
		return true
	}
	let result: T
	try {
		connection = createConnection(target, credentials)
		connection.on('mrp-message', onMessage)
		connection.on('error', onLost)
		connection.on('close', onLost)
		// On abort or timeout, close() in finally also cancels the library's pending setup.
		await bounded(async () => connection!.connect(), 10000, signal)
		signal.throwIfAborted()
		// The library's handshake subscribes to everything except output-device updates.
		await connection.sendMRPMessage(
			await MRPMessage.clientUpdatesConfig({
				artworkUpdates: true,
				nowPlayingUpdates: true,
				volumeUpdates: true,
				keyboardUpdates: true,
				outputDeviceUpdates: true,
			}),
		)
		signal.throwIfAborted()
		state.setConnected()
		started = true
		if (refreshRequested) refreshAudio()
		publish()
		signal.throwIfAborted()
		result = await operation(signal, routeAudio)
	} catch (error) {
		if (reportFailed) throw new Error('Metadata report failed', { cause: error })
		if (ownerSignal.aborted) throw new Error('Metadata observation cancelled', { cause: error })
		if (stop.signal.reason instanceof Error) throw stop.signal.reason
		// Keep the remote session's own reason; it is not a metadata failure.
		if (started && error instanceof Error) throw error
		throw new Error('Metadata connection failed', { cause: error })
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
