import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { AirPlayConnection } from 'node-appletv-remote'

// Public API integration tests against the installed npm patch, on loopback only.
const credentials = {
	clientId: 'synthetic-client',
	serverId: 'synthetic-server',
	clientLTSK: Buffer.alloc(32, 1),
	clientLTPK: Buffer.alloc(32, 2),
	serverLTPK: Buffer.alloc(32, 3),
}

async function stalledPeer(operation) {
	const sockets = new Set()
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.on('data', () => {})
		socket.on('error', () => {})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	let timer
	try {
		await Promise.race([
			operation(server.address().port, server, sockets),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('Loopback test deadline exceeded')), 1500)
			}),
		])
	} finally {
		clearTimeout(timer)
		for (const socket of sockets) socket.destroy()
		await new Promise((resolve) => server.close(resolve))
	}
}

test('installed AirPlay patch closes a stalled handshake on native cancellation', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const connection = new AirPlayConnection('127.0.0.1', port, credentials, { logger: () => {} })
		const controller = new AbortController()
		let closes = 0
		connection.on('close', () => closes++)
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(connection.connect({ signal: controller.signal }), /cancel/i)
		const [socket] = await accepted
		const closed = once(socket, 'close')
		controller.abort()
		await rejected
		await closed
		connection.close()
		assert.equal(closes, 1)
		await assert.rejects(connection.connect(), /closed/i)
	})
})

test('installed AirPlay patch times out and releases a peer that never replies', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const connection = new AirPlayConnection('127.0.0.1', port, credentials, { timeoutMs: 100, logger: () => {} })
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(connection.connect(), /timed out/i)
		const [socket] = await accepted
		const closed = once(socket, 'close')
		await rejected
		await closed
		connection.close()
	})
})

test('installed AirPlay patch rejects a handshake when the peer disconnects', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const connection = new AirPlayConnection('127.0.0.1', port, credentials, { logger: () => {} })
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(connection.connect(), /closed|ECONNRESET|EPIPE/i)
		const [socket] = await accepted
		socket.destroy()
		await rejected
		connection.close()
	})
})

test('cancellation before connect opens no socket', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		let accepted = 0
		server.on('connection', () => accepted++)
		const connection = new AirPlayConnection('127.0.0.1', port, credentials, { logger: () => {} })
		await assert.rejects(connection.connect({ signal: AbortSignal.abort() }), /cancel/i)
		await delay(20)
		assert.equal(accepted, 0)
	})
})
