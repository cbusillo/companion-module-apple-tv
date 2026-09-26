import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanionPrototype } from '../dist/prototype/companion.js'
import { MetadataState } from '../dist/prototype/metadata.js'
import { MetadataPeer } from './fixtures/metadata-peer.mjs'

async function fixture() {
	const state = new MetadataState()
	state.setConnected()
	const peer = new MetadataPeer()
	const cancel = new AbortController()
	const writes = []
	/** @type {(percent: number) => void | Promise<void>} */
	let onWrite = (percent) => peer.volume(percent)
	const commands = new CompanionPrototype(
		{
			async sendCompanionRequest(id, envelope) {
				const content = envelope.get('_c')
				assert.equal(id, '_mcc')
				assert.equal(content.get('_mcc'), 6, 'Live audio must not read the Companion volume placeholder')
				const percent = content.get('_vol').value * 100
				writes.push(percent)
				await onWrite(percent)
				return new Map([
					['_t', 3],
					['_c', new Map()],
				])
			},
		},
		{ signal: cancel.signal, volumeConfirmationMs: 30 },
	)
	peer.on('mrp-message', (message) => {
		state.receive(message)
		commands.observeMetadata(state.snapshot())
	})
	peer.on('close', () => {
		state.invalidate()
		commands.observeMetadata(state.snapshot())
	})
	await peer.connect()
	return {
		commands,
		peer,
		state,
		writes,
		cancel,
		setWrite: (callback) => {
			onWrite = callback
		},
	}
}

test('absolute volume and mute require both the request reply and a fresh matching volume report', async () => {
	const { commands, writes } = await fixture()
	assert.equal(await commands.readVolume(), 35)
	await commands.setVolume(30)
	assert.equal(await commands.readVolume(), 30)
	await commands.toggleMute()
	assert.equal(commands.state.mute, 'Muted')
	assert.equal(await commands.readVolume(), 0)
	await commands.toggleMute()
	assert.equal(await commands.readVolume(), 30)
	assert.equal(commands.state.mute, 'Unmuted')
	assert.deepEqual(writes, [30, 0, 30])
})

test('an ACK or a cached snapshot cannot confirm mute or arm restoration', async () => {
	for (const cached of [false, true]) {
		const { commands, state, writes, setWrite } = await fixture()
		setWrite(() => {
			if (cached) {
				const snapshot = state.snapshot()
				snapshot.audio.volume = 0
				commands.observeMetadata(snapshot)
			}
		})
		await assert.rejects(commands.toggleMute(), /did not confirm/)
		assert.notEqual(commands.state.mute, 'Muted')
		assert.deepEqual(writes, [0])
	}
})

test('a new volume packet is distinguishable even when its numeric value repeats', async () => {
	const { peer, state } = await fixture()
	const first = state.snapshot().audio
	peer.volume(first.volume)
	const second = state.snapshot().audio
	assert.equal(first.volume, second.volume)
	assert.ok(second.volumeRevision > first.volumeRevision)
})

test('AirPods changes discard mute restoration even when the primary volume ID stays constant', async () => {
	const { commands, peer, state, writes } = await fixture()
	const outputId = state.snapshot().audio.outputId
	await commands.toggleMute()
	peer.route(['headphones'])
	assert.equal(state.snapshot().audio.outputId, outputId)
	assert.equal(commands.state.mute, 'Unavailable')
	peer.capability()
	peer.volume(0)
	assert.equal(commands.state.mute, 'Unavailable')
	await assert.rejects(commands.toggleMute(), /No saved volume/)
	assert.deepEqual(writes, [0])
	peer.route()
	peer.capability()
	peer.volume(0)
	await assert.rejects(commands.toggleMute(), /No saved volume/)
})

test('output-list reordering preserves a valid mute restore', async () => {
	const { commands, peer, writes } = await fixture()
	peer.route(['one', 'two'])
	peer.capability()
	peer.volume(40)
	await commands.toggleMute()
	peer.route(['two', 'one'])
	assert.equal(commands.state.mute, 'Muted')
	await commands.toggleMute()
	assert.deepEqual(writes, [0, 40])
})

test('route loss, capability loss and cancellation during a write never arm restoration', async () => {
	for (const change of ['route', 'capability', 'close', 'cancel']) {
		const { commands, peer, cancel, writes, setWrite } = await fixture()
		setWrite(() => {
			if (change === 'route') peer.route(['headphones'])
			if (change === 'capability') peer.capability(false)
			if (change === 'close') peer.close()
			if (change === 'cancel') cancel.abort()
			peer.volume(0)
		})
		await assert.rejects(commands.toggleMute())
		assert.notEqual(commands.state.mute, 'Muted')
		assert.deepEqual(writes, [0])
	}
})

test('an external volume change replaces the prior mute level', async () => {
	const { commands, peer, writes } = await fixture()
	await commands.toggleMute()
	peer.volume(15)
	assert.equal(commands.state.mute, 'Unmuted')
	await commands.toggleMute()
	await commands.toggleMute()
	assert.deepEqual(writes, [0, 0, 15])
})

test('a matching event before a failed reply cannot report a successful mute', async () => {
	const { commands, peer, setWrite } = await fixture()
	setWrite((percent) => {
		peer.volume(percent)
		throw new Error('Reply lost')
	})
	await assert.rejects(commands.toggleMute(), /Reply lost/)
	assert.notEqual(commands.state.mute, 'Muted')
})

test('a route change between validation and dispatch sends no absolute-volume request', async () => {
	const { commands, peer, writes } = await fixture()
	const pending = commands.setVolume(25)
	peer.route(['headphones'])
	peer.capability()
	peer.volume(50)
	await assert.rejects(pending, /output changed/)
	assert.deepEqual(writes, [])
})

test('a confirmed level that changes before the reply arrives cannot arm mute restoration', async () => {
	for (const change of ['route', 'volume']) {
		const { commands, peer, setWrite } = await fixture()
		const sent = Promise.withResolvers()
		const reply = Promise.withResolvers()
		setWrite((percent) => {
			peer.volume(percent)
			sent.resolve(undefined)
			return reply.promise
		})
		const pending = commands.toggleMute()
		const rejected = assert.rejects(pending, /changed before completion/)
		await sent.promise
		if (change === 'route') {
			peer.route(['headphones'])
			peer.capability()
			peer.volume(0)
		} else peer.volume(20)
		reply.resolve(undefined)
		await rejected
		assert.notEqual(commands.state.mute, 'Muted')
	}
})
