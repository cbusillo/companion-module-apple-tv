import type { HAPCredentials } from 'node-appletv-remote'

export type SavedPairing = {
	version: 1
	deviceId: string
	credentials: { clientId: string; serverId: string; clientLTSK: string; clientLTPK: string; serverLTPK: string }
}
export type ModuleSecrets = {
	pairing?: SavedPairing
	pin?: string
	/** Personal output learned from the TV's reported outputs by name match. */
	personalOutput?: { match: string; id: string; name: string }
}

/** Values belong only in Companion's secret store, never in its public config. */
export function decodePairing(value: unknown): { deviceId: string; credentials: HAPCredentials } {
	if (!value || typeof value !== 'object') throw new Error('Invalid saved pairing')
	const record = value as Record<string, unknown>
	const keys = record.credentials as Record<string, unknown> | undefined
	const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 255
	if (record.version !== 1 || !validId(record.deviceId) || !keys || !validId(keys.clientId) || !validId(keys.serverId))
		throw new Error('Invalid saved pairing')
	const decode = (name: string): Buffer => {
		const text = keys[name]
		if (typeof text !== 'string' || !/^[a-f0-9]{64}$/i.test(text)) throw new Error('Invalid saved pairing')
		return Buffer.from(text, 'hex')
	}
	return {
		deviceId: record.deviceId,
		credentials: {
			clientId: keys.clientId,
			serverId: keys.serverId,
			clientLTSK: decode('clientLTSK'),
			clientLTPK: decode('clientLTPK'),
			serverLTPK: decode('serverLTPK'),
		},
	}
}

export function encodePairing(deviceId: string, credentials: HAPCredentials): SavedPairing {
	const record: SavedPairing = {
		version: 1,
		deviceId,
		credentials: {
			clientId: credentials.clientId,
			serverId: credentials.serverId,
			clientLTSK: credentials.clientLTSK.toString('hex'),
			clientLTPK: credentials.clientLTPK.toString('hex'),
			serverLTPK: credentials.serverLTPK.toString('hex'),
		},
	}
	decodePairing(record)
	return record
}
