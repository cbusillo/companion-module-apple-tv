import { randomInt } from 'node:crypto'
import { CompanionConnection, type HAPCredentials } from 'node-appletv-remote'
import { CompanionPrototype, CompanionRequestRejected, companionRequest } from './companion.js'

type Connection = Pick<CompanionConnection, 'connect' | 'sendRequest' | 'close' | 'on' | 'off'>
type Target = { address: string; companionPort: number }

/** Bounds an operation even when the candidate library leaves a socket pending. */
export async function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: () => void = () => {}
	try {
		return await Promise.race([
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error('Test cancelled or connection closed'))
				signal.addEventListener('abort', onAbort, { once: true })
				timer = setTimeout(() => reject(new Error('Test operation timed out')), timeoutMs)
			}),
			operation(),
		])
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', onAbort)
	}
}

/** One authenticated session, with no reconnect or automatic command retries. */
export async function withCompanionSession<T>(
	target: Target,
	credentials: HAPCredentials,
	signal: AbortSignal,
	operation: (commands: CompanionPrototype) => Promise<T>,
	createConnection: (target: Target, credentials: HAPCredentials) => Connection = (device, keys) =>
		new CompanionConnection(device.address, device.companionPort, keys),
	onStage: (stage: string) => void = () => {},
): Promise<T> {
	const connection = createConnection(target, credentials)
	const lost = new AbortController()
	const active = AbortSignal.any([signal, lost.signal])
	const onLost = (): void => lost.abort()
	connection.on('error', onLost)
	connection.on('close', onLost)
	const client = {
		sendCompanionRequest: async (
			identifier: string,
			content: Parameters<Connection['sendRequest']>[1],
			timeoutMs: number,
		) => bounded(async () => connection.sendRequest(identifier, content, timeoutMs), timeoutMs, active),
	}
	let sessionId: bigint | undefined
	let result: T | undefined
	let failed = false
	let failure: unknown
	try {
		onStage('session authentication')
		await bounded(async () => connection.connect(), 10000, active)
		// A stable, separate controller identity; never borrow the production pairing.
		const publicId = credentials.clientLTPK.subarray(0, 6).toString('hex').match(/../g)!.join(':')
		onStage('session system information')
		await companionRequest(client, '_systemInfo', [
			['_bf', 0],
			['_cf', 512],
			['_clFl', 128],
			['_i', publicId.replaceAll(':', '')],
			['_idsID', Buffer.from(credentials.clientId)],
			['_pubID', publicId],
			['_sf', 256],
			['_sv', '170.18'],
			['model', 'iPhone10,6'],
			['name', 'Companion Node Test'],
		])
		// Keep the client half positive when a TV treats it as a signed int32.
		const localId = randomInt(1, 0x80000000)
		onStage('session start')
		const started = await companionRequest(client, '_sessionStart', [
			['_srvT', 'com.apple.tvremoteservices'],
			['_sid', localId],
		])
		const remoteId = started.get('_sid')
		if (typeof remoteId !== 'number' || !Number.isInteger(remoteId) || remoteId < 0 || remoteId > 0xffffffff) {
			throw new Error('Invalid session identifier')
		}
		sessionId = (BigInt(remoteId) << 32n) | BigInt(localId)
		try {
			onStage('TV remote session registration')
			await companionRequest(client, 'TVRCSessionStart', [['ProtocolVersionKey', '1.2']])
		} catch (error) {
			// Older TVs may reject this optional power-query registration.
			if (!(error instanceof CompanionRequestRejected)) throw error
		}
		result = await operation(new CompanionPrototype(client))
	} catch (error) {
		failed = true
		failure = error
	} finally {
		try {
			if (!failed && active.aborted) {
				failed = true
				failure = new Error('Test cancelled or connection closed')
			}
			if (sessionId !== undefined && !active.aborted) {
				try {
					if (!failed) onStage('session teardown')
					await companionRequest(client, '_sessionStop', [
						['_srvT', 'com.apple.tvremoteservices'],
						['_sid', sessionId],
					])
				} catch (error) {
					if (!failed) {
						failed = true
						failure = error
					}
				}
			}
		} finally {
			// Keep the error handler attached through socket destruction.
			connection.close()
		}
	}
	if (failed) throw failure
	return result as T
}
