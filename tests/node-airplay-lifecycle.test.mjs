import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { withMetadataSession } from '../dist/prototype/metadata-session.js'

// The module's metadata session over the real library AirPlay transport, on loopback only.
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

const target = (port) => ({ address: '127.0.0.1', port })
const session = (port, signal) =>
	withMetadataSession(
		target(port),
		credentials,
		signal,
		() => {},
		async () => assert.fail('must not connect'),
	)

test('cancelling a stalled AirPlay handshake closes its socket', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const controller = new AbortController()
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(session(port, controller.signal), /cancelled/i)
		const [socket] = await accepted
		const closed = once(socket, 'close')
		controller.abort()
		await rejected
		await closed
	})
})

test('a peer that drops the AirPlay handshake fails the session', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		const accepted = once(server, 'connection')
		const rejected = assert.rejects(session(port, new AbortController().signal), /Metadata connection (failed|lost)/)
		const [socket] = await accepted
		socket.destroy()
		await rejected
	})
})

test('cancellation before connect opens no socket', { timeout: 5000 }, async () => {
	await stalledPeer(async (port, server) => {
		let accepted = 0
		server.on('connection', () => accepted++)
		await assert.rejects(session(port, AbortSignal.abort()), /aborted/i)
		await delay(20)
		assert.equal(accepted, 0)
	})
})
