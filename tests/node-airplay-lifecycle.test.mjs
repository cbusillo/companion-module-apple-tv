import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { AirPlayConnection } from 'node-appletv-remote'

// Public API integration tests against the installed library build, on loopback only.
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

// The library logs setup progress to stderr; keep test output clean.
class QuietAirPlayConnection extends AirPlayConnection {
	log() {}
}

test('close() during a stalled handshake rejects connect and releases the peer socket', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const connection = new QuietAirPlayConnection('127.0.0.1', port, credentials)
		let closes = 0
		connection.on('close', () => closes++)
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(connection.connect(), /closed/i)
		const [socket] = await accepted
		const closed = once(socket, 'close')
		connection.close()
		await rejected
		await closed
		connection.close()
		assert.equal(closes, 1)
	})
})

test('a handshake rejects when the peer disconnects', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const connection = new QuietAirPlayConnection('127.0.0.1', port, credentials)
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(connection.connect(), /closed|ECONNRESET|EPIPE/i)
		const [socket] = await accepted
		socket.destroy()
		await rejected
		connection.close()
	})
})
