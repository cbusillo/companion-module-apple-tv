import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { HAPCredentials } from 'node-appletv-remote'

export type TestCredentials = { deviceId: string; credentials: HAPCredentials }

/** Must run before starting pairing, so an existing file is never replaced. */
export async function prepareCredentialFile(path: string): Promise<void> {
	if (!isAbsolute(path)) throw new Error('Use an absolute credential path outside the repository')
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const directory = await lstat(dirname(path))
	if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
		throw new Error('Credential directory must be private (mode 0700)')
	}
	try {
		await lstat(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
		throw error
	}
	throw new Error('Credential file already exists; choose a new file or run check')
}

export async function saveTestCredentials(path: string, record: TestCredentials): Promise<void> {
	const { credentials } = record
	const handle = await open(path, 'wx', 0o600)
	try {
		await handle.writeFile(
			JSON.stringify({
				version: 1,
				deviceId: record.deviceId,
				credentials: {
					clientId: credentials.clientId,
					serverId: credentials.serverId,
					clientLTSK: credentials.clientLTSK.toString('hex'),
					clientLTPK: credentials.clientLTPK.toString('hex'),
					serverLTPK: credentials.serverLTPK.toString('hex'),
				},
			}),
		)
		await handle.sync()
	} finally {
		await handle.close()
	}
}

export async function loadTestCredentials(path: string): Promise<TestCredentials> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) {
			throw new Error('Expected a private credential file (mode 0600)')
		}
		const data = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
		if (data.version !== 1 || typeof data.deviceId !== 'string' || !data.deviceId)
			throw new Error('Invalid test credentials')
		const keys = data.credentials as Record<string, unknown> | undefined
		if (
			!keys ||
			typeof keys.clientId !== 'string' ||
			!keys.clientId ||
			typeof keys.serverId !== 'string' ||
			!keys.serverId
		) {
			throw new Error('Invalid test credentials')
		}
		const decode = (name: string): Buffer => {
			const value = keys[name]
			if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid test credentials')
			return Buffer.from(value, 'hex')
		}
		return {
			deviceId: data.deviceId,
			credentials: {
				clientId: keys.clientId,
				serverId: keys.serverId,
				clientLTSK: decode('clientLTSK'),
				clientLTPK: decode('clientLTPK'),
				serverLTPK: decode('serverLTPK'),
			},
		}
	} finally {
		await handle.close()
	}
}
