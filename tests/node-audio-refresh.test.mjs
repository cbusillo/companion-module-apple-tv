import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { MRPMessage } from 'node-appletv-remote'
import { MetadataPeer } from './fixtures/metadata-peer.mjs'
import { withMetadataSession } from '../dist/prototype/metadata-session.js'
import { MetadataState } from '../dist/prototype/metadata.js'

class ReadPeer extends MetadataPeer {
	reads = []
	async sendMRPMessageAndWait(data) {
		const request = await MRPMessage.decode(data)
		this.requests.push(request)
		const pending = Promise.withResolvers()
		this.reads.push(pending)
		this.emit('read')
		return pending.promise
	}
	close() {
		for (const pending of this.reads) pending.reject(new Error('Closed'))
		super.close()
	}
}
const reply = (volume) => ({ type: 50, '.getVolumeResultMessage': { volume } })
async function until(check) {
	const deadline = Date.now() + 2000
	while (!check()) {
		assert.ok(Date.now() < deadline, 'Expected metadata change')
		await delay(1)
	}
}
async function session(peer, operation, signal = new AbortController().signal) {
	const snapshots = []
	return withMetadataSession(
		{ address: '127.0.0.1', port: 1 },
		{},
		signal,
		(snapshot) => snapshots.push(snapshot),
		(active) => operation(snapshots, active),
		() => peer,
	)
}

test('output changes recover capability and correlated volume without device controls', async () => {
	const peer = new ReadPeer()
	await session(peer, async (snapshots) => {
		assert.equal(snapshots.at(-1).audio.volume, 35)
		peer.volume(50) // A transitional report arrives before the output identity.
		const reading = once(peer, 'read')
		peer.route(['headphones'])
		await reading
		assert.equal(snapshots.at(-1).audio.volume, undefined)
		assert.equal(snapshots.at(-1).audio.absolute, false)
		assert.deepEqual(
			peer.requests.map((message) => message.type),
			[16, 16, 49],
		)
		assert.deepEqual(
			peer.requests.slice(0, 2).map((message) => message['.clientUpdatesConfigMessage'].volumeUpdates),
			[false, true],
		)
		for (const request of peer.requests.slice(0, 2)) {
			const config = request['.clientUpdatesConfigMessage']
			for (const key of ['artworkUpdates', 'nowPlayingUpdates', 'keyboardUpdates', 'outputDeviceUpdates'])
				assert.equal(config[key], true)
		}
		peer.reads[0].resolve(reply(0.625))
		await until(() => snapshots.at(-1).audio.volume === 62.5)
		assert.equal(snapshots.at(-1).audio.absolute, true)
		const count = peer.requests.length
		peer.route(['headphones'])
		await delay(5)
		assert.equal(peer.requests.length, count, 'Repeated identity must not renew the subscription')
	})
	assert.equal(peer.closed, true)
	assert.equal(peer.listenerCount('mrp-message'), 0)
})

test('a late read cannot cross an output round trip or start concurrent renewals', async () => {
	const peer = new ReadPeer()
	await session(peer, async (snapshots) => {
		const first = once(peer, 'read')
		peer.route(['headphones'])
		await first
		peer.route()
		peer.route(['headphones'])
		assert.equal(peer.reads.length, 1)
		const second = once(peer, 'read')
		peer.reads[0].resolve(reply(0.9))
		await second
		assert.ok(!snapshots.some((snapshot) => snapshot.audio.volume === 90))
		assert.equal(snapshots.at(-1).audio.volume, undefined)
		peer.reads[1].resolve(reply(0.2))
		await until(() => snapshots.at(-1).audio.volume === 20)
	})
})

test('an output transition during startup is refreshed after authentication completes', async () => {
	const peer = new ReadPeer()
	peer.connect = async () => {
		peer.route()
		peer.capability()
		peer.volume(50)
		peer.route(['headphones'])
		assert.equal(peer.requests.length, 0)
	}
	await session(peer, async (snapshots) => {
		await until(() => peer.reads.length === 1)
		assert.equal(snapshots.at(-1).audio.volume, undefined)
		peer.reads[0].resolve(reply(0.6))
		await until(() => snapshots.at(-1).audio.volume === 60)
	})
})

test('missing, invalid or inherited query fields never restore a transitional volume', () => {
	for (const response of [
		undefined,
		{},
		{ type: 50 },
		reply(NaN),
		reply(-1),
		reply(2),
		reply(Infinity),
		{ type: 50, '.getVolumeResultMessage': Object.create({ volume: 0 }) },
		{ ...reply(0.4), type: 52 },
	]) {
		const peer = new MetadataPeer()
		const state = new MetadataState()
		peer.on('mrp-message', (message) => state.receive(message))
		peer.route()
		state.setConnected()
		const read = state.beginAudioRead()
		peer.capability()
		peer.volume(50)
		state.finishAudioRead(read, response)
		assert.equal(state.snapshot().audio.volume, undefined)
	}
})

test('fresh zero is retained but a query without fresh capability stays unavailable', async () => {
	for (const available of [true, false]) {
		const peer = new ReadPeer()
		await session(peer, async (snapshots) => {
			peer.available = available
			const reading = once(peer, 'read')
			peer.route(['headphones'])
			await reading
			peer.reads[0].resolve(reply(0))
			await delay(5)
			assert.equal(snapshots.at(-1).audio.volume, available ? 0 : undefined)
			assert.equal(snapshots.at(-1).audio.absolute, available)
		})
	}
})

test('failed recovery and cancellation release the session without replaying the read', async () => {
	for (const cancel of [false, true]) {
		const peer = new ReadPeer()
		const owner = new AbortController()
		const reading = once(peer, 'read')
		const run = session(
			peer,
			async (_snapshots, signal) => {
				peer.route(['headphones'])
				await delay(10000, undefined, { signal })
			},
			owner.signal,
		)
		const rejected = assert.rejects(run, /cancelled|lost/)
		await reading
		if (cancel) owner.abort()
		else peer.reads[0].reject(new Error('Request failed'))
		await rejected
		assert.equal(peer.closed, true)
		assert.equal(peer.reads.length, 1)
		assert.equal(peer.listenerCount('mrp-message'), 0)
	}
})
