import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { bounded, withCompanionSession } from '../dist/prototype/session.js'
import { loadTestCredentials, prepareCredentialFile, saveTestCredentials } from '../dist/prototype/credentials.js'

const credentials = {
	clientId: 'synthetic-controller',
	serverId: 'synthetic-tv',
	clientLTSK: Buffer.alloc(32, 1),
	clientLTPK: Buffer.alloc(32, 2),
	serverLTPK: Buffer.alloc(32, 3),
}
const target = { address: 'unused.invalid', companionPort: 1 }
const response = (entries = []) =>
	new Map([
		['_t', 3],
		['_c', new Map(entries)],
	])

class FakeConnection extends EventEmitter {
	requests = []
	closed = false
	connect = async () => {}
	async sendRequest(identifier, envelope) {
		assert.equal(envelope.get('_t'), 2)
		assert.ok(envelope.get('_c') instanceof Map)
		this.requests.push({ identifier, content: envelope.get('_c') })
		if (identifier === '_sessionStart') return response([['_sid', 0xfedcba98]])
		if (identifier === 'FetchLaunchableApplicationsEvent') return response([['com.example.player', 'Player']])
		if (identifier === 'FetchAttentionState') return response([['state', 3]])
		return response()
	}
	close() {
		this.closed = true
		this.emit('close')
	}
}

function run(connection, operation, signal = new AbortController().signal) {
	return withCompanionSession(target, credentials, signal, operation, () => connection)
}

test('realistic read-only session initializes, discovers apps, and stops its combined session ID', async () => {
	const connection = new FakeConnection()
	const result = await run(connection, async (commands) => ({
		apps: await commands.listApps(),
		power: await commands.readPower(),
	}))
	assert.deepEqual(result, { apps: [{ id: 'com.example.player', name: 'Player' }], power: 'On' })
	assert.deepEqual(
		connection.requests.map((r) => r.identifier),
		[
			'_systemInfo',
			'_sessionStart',
			'TVRCSessionStart',
			'FetchLaunchableApplicationsEvent',
			'FetchAttentionState',
			'_sessionStop',
		],
	)
	const start = connection.requests.find((r) => r.identifier === '_sessionStart').content.get('_sid')
	const stop = connection.requests.at(-1).content.get('_sid')
	assert.equal(stop, (0xfedcba98n << 32n) | BigInt(start))
	assert.deepEqual(connection.requests[0].content.get('_idsID'), Buffer.from(credentials.clientId))
	assert.equal(connection.closed, true)
})

test('operation failure still stops the session, preserving the original error', async () => {
	const connection = new FakeConnection()
	await assert.rejects(
		run(connection, async () => {
			throw new Error('operation failed')
		}),
		/operation failed/,
	)
	assert.equal(connection.requests.at(-1).identifier, '_sessionStop')
	assert.equal(connection.closed, true)
})

test('optional TVRC registration rejection permits app discovery, but transport failure does not', async () => {
	for (const rejected of [true, false]) {
		const connection = new FakeConnection()
		const original = connection.sendRequest.bind(connection)
		connection.sendRequest = async (id, body) => {
			if (id !== 'TVRCSessionStart') return original(id, body)
			if (rejected) return new Map([['_ec', 58822]])
			throw new Error('transport failed')
		}
		const operation = run(connection, (commands) => commands.listApps())
		if (rejected) assert.equal((await operation).length, 1)
		else await assert.rejects(operation, /transport failed/)
		assert.equal(connection.closed, true)
	}
})

test('failed authentication closes without issuing commands', async () => {
	const connection = new FakeConnection()
	connection.connect = async () => {
		throw new Error('authentication failed')
	}
	await assert.rejects(
		run(connection, (commands) => commands.listApps()),
		/authentication failed/,
	)
	assert.deepEqual(connection.requests, [])
	assert.equal(connection.closed, true)
})

test('invalid session identifiers fail before controls and always close', async () => {
	for (const invalid of [-1, 2 ** 32, 0.5, undefined]) {
		const connection = new FakeConnection()
		const original = connection.sendRequest.bind(connection)
		connection.sendRequest = (id, body) =>
			id === '_sessionStart' ? Promise.resolve(response([['_sid', invalid]])) : original(id, body)
		await assert.rejects(
			run(connection, () => {
				throw new Error('must not reach controls')
			}),
			/Invalid session identifier/,
		)
		assert.equal(connection.closed, true)
	}
})

test('cancellation closes a pending authentication without waiting for its timeout', async () => {
	const controller = new AbortController()
	const connection = new FakeConnection()
	connection.connect = () => new Promise(() => {})
	const pending = run(connection, () => assert.fail('must not run'), controller.signal)
	controller.abort()
	await assert.rejects(pending, /cancelled/)
	assert.equal(connection.closed, true)
})

test('unexpected socket error aborts a pending request without an unhandled EventEmitter error', async () => {
	const connection = new FakeConnection()
	connection.sendRequest = () =>
		new Promise(() => {
			queueMicrotask(() => connection.emit('error', new Error('socket lost')))
		})
	await assert.rejects(
		run(connection, () => assert.fail('must not run')),
		/cancelled or connection closed/,
	)
	assert.equal(connection.closed, true)
})

test('failed session stop cannot be reported as successful teardown', async () => {
	const connection = new FakeConnection()
	const original = connection.sendRequest.bind(connection)
	connection.sendRequest = (id, body) =>
		id === '_sessionStop' ? Promise.reject(new Error('stop failed')) : original(id, body)
	await assert.rejects(
		run(connection, (commands) => commands.listApps()),
		/stop failed/,
	)
	assert.equal(connection.closed, true)
})

test('bounded operation times out and rejects a pre-cancelled operation before calling it', async () => {
	await assert.rejects(
		bounded(() => new Promise(() => {}), 10, new AbortController().signal),
		/timed out/,
	)
	await assert.rejects(bounded(() => assert.fail('must not run'), 10, AbortSignal.abort()))
})

test('test credentials are private, round-trip independently, and never overwrite an existing file', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'node-companion-'))
	try {
		await chmod(directory, 0o700)
		const path = join(directory, 'test.json')
		const record = { deviceId: 'synthetic-device', credentials }
		await prepareCredentialFile(path)
		await saveTestCredentials(path, record)
		const before = await readFile(path)
		assert.equal((await stat(path)).mode & 0o777, 0o600)
		assert.deepEqual(await loadTestCredentials(path), record)
		await assert.rejects(prepareCredentialFile(path), /already exists/)
		await assert.rejects(saveTestCredentials(path, record), { code: 'EEXIST' })
		assert.deepEqual(await readFile(path), before)
		await chmod(path, 0o644)
		await assert.rejects(loadTestCredentials(path), /private credential file/)
		await chmod(path, 0o600)
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				deviceId: record.deviceId,
				credentials: { ...record.credentials, clientLTSK: 'bad' },
			}),
		)
		await assert.rejects(loadTestCredentials(path), /Invalid test credentials/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
