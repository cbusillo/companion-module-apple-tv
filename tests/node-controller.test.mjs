import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { NodeController } from '../dist/prototype/controller.js'
import { withCompanionSession } from '../dist/prototype/session.js'
import { CommandNotSent } from '../dist/prototype/queue.js'
import { withMetadataSession } from '../dist/prototype/metadata-session.js'
import { MetadataPeer } from './fixtures/metadata-peer.mjs'

const credentials = {
	clientId: 'synthetic',
	serverId: 'synthetic',
	clientLTSK: Buffer.alloc(32),
	clientLTPK: Buffer.alloc(32),
	serverLTPK: Buffer.alloc(32),
}
const reply = (entries = []) =>
	new Map([
		['_t', 3],
		['_c', new Map(entries)],
	])

class Peer extends EventEmitter {
	constructor(metadata) {
		super()
		this.metadata = metadata
	}
	requests = []
	events = []
	closed = false
	onRequest = undefined
	async connect() {}
	async sendRequest(id, envelope) {
		const content = envelope.get('_c')
		this.requests.push({ id, content })
		if (this.onRequest) await this.onRequest(id, content)
		if (id === '_sessionStart') return reply([['_sid', 0xfedcba98]])
		if (id === 'FetchLaunchableApplicationsEvent') return reply([['com.example.app', 'Synthetic app']])
		if (id === 'FetchAttentionState') return reply([['state', 3]])
		if (id === '_mcc' && content.get('_mcc') === 5) return reply([['_vol', 0.2]])
		if (id === '_mcc' && content.get('_mcc') === 6) this.metadata.volume(content.get('_vol').value * 100)
		return reply()
	}
	sendMessage(id, envelope) {
		this.events.push({ id, content: envelope.get('_c') })
	}
	close() {
		if (!this.closed) {
			this.closed = true
			this.emit('close')
		}
	}
	push(identifier, entries) {
		this.emit('event', {
			identifier,
			data: new Map([
				['_t', 1],
				['_c', new Map(entries)],
			]),
		})
	}
}

function fixture(options = {}) {
	const peers = []
	const metadataPeers = []
	let discoveries = 0
	const controller = new NodeController('synthetic', credentials, {
		reconnectDelayMs: 5,
		healthIntervalMs: 30000,
		discover: async () => {
			discoveries++
			return { address: 'unused.invalid', companionPort: 1, airplayPort: 2 }
		},
		metadataSession: (target, keys, signal, snapshot, operation) => {
			const peer = new MetadataPeer()
			metadataPeers.push(peer)
			return withMetadataSession(target, keys, signal, snapshot, operation, () => peer)
		},
		session: async (target, keys, signal, operation) => {
			const peer = new Peer(metadataPeers.at(-1))
			peers.push(peer)
			return withCompanionSession(target, keys, signal, operation, () => peer)
		},
		...options,
	})
	return { controller, peers, metadataPeers, discoveries: () => discoveries }
}

async function until(predicate) {
	const deadline = Date.now() + 2000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Condition did not arrive')
		await delay(5)
	}
}

test('controller accepts input only after a real health round trip and keeps gestures atomic', async () => {
	const { controller, peers } = fixture()
	await assert.rejects(controller.perform({ kind: 'button', button: 'select' }), CommandNotSent)
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		assert.equal(controller.feedback.power, 'On')
		await Promise.all([
			controller.perform({ kind: 'button', button: 'appSwitcher' }),
			controller.perform({ kind: 'button', button: 'left' }),
		])
		const buttons = peers[0].requests.filter(({ id }) => id === '_hidC')
		assert.deepEqual(
			buttons.map(({ content }) => [content.get('_hidC'), content.get('_hBtS')]),
			[
				[7, 1],
				[7, 2],
				[7, 1],
				[7, 2],
				[3, 1],
				[3, 2],
			],
		)
	} finally {
		await controller.stop()
	}
	assert.equal(controller.state, 'stopped')
	assert.equal(peers[0].closed, true)
	assert.equal(peers[0].requests.at(-1).id, '_sessionStop')
})

test('idle connection loss clears feedback, rediscovers, and reconnects without input replay', async () => {
	const { controller, peers, discoveries } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].close()
		await until(() => controller.state === 'reconnecting')
		assert.ok(!controller.feedback || controller.feedback.power === 'Unknown')
		await controller.waitUntilReady(2000)
		assert.equal(controller.reconnects, 1)
		assert.equal(discoveries(), 2)
		assert.equal(peers.flatMap((peer) => peer.requests).filter(({ id }) => id === '_hidC').length, 0)
	} finally {
		await controller.stop()
	}
})

test('losing an in-flight command discards queued commands and permits only new input after reconnect', async () => {
	const { controller, peers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const held = Promise.withResolvers()
		peers[0].onRequest = async (id) => {
			if (id === '_hidC') await held.promise
		}
		const first = controller.perform({ kind: 'button', button: 'select' })
		const second = controller.perform({ kind: 'button', button: 'right' })
		const failures = Promise.all([assert.rejects(first), assert.rejects(second)])
		await until(() => peers[0].requests.some(({ id }) => id === '_hidC'))
		peers[0].close()
		await failures
		held.resolve(undefined)
		await until(() => controller.reconnects === 1)
		assert.equal(peers[1].requests.filter(({ id }) => id === '_hidC').length, 0)
		await controller.perform({ kind: 'button', button: 'left' })
		assert.deepEqual(
			peers[1].requests.filter(({ id }) => id === '_hidC').map(({ content }) => content.get('_hidC')),
			[3, 3],
		)
	} finally {
		await controller.stop()
	}
})

test('local validation and unsupported features do not reconnect a healthy session', async () => {
	const { controller, peers, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		await assert.rejects(controller.perform({ kind: 'button', button: 'invalid' }), RangeError)
		metadataPeers[0].capability(false)
		await assert.rejects(controller.perform({ kind: 'mute' }), /output identity/)
		assert.equal(controller.state, 'ready')
		assert.equal(peers.length, 1)
		assert.equal(peers[0].requests.filter(({ id }) => id === '_hidC').length, 0)
	} finally {
		await controller.stop()
	}
})

test('health checks do not interleave with an active button gesture', async () => {
	const { controller, peers } = fixture({ healthIntervalMs: 5 })
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const held = Promise.withResolvers()
		peers[0].onRequest = async (id, content) => {
			if (id === '_hidC' && content.get('_hBtS') === 1) await held.promise
		}
		const pending = controller.perform({ kind: 'button', button: 'select' })
		await until(() => peers[0].requests.some(({ id }) => id === '_hidC'))
		const before = peers[0].requests.length
		await delay(20)
		assert.equal(peers[0].requests.length, before)
		held.resolve(undefined)
		await pending
		const lastButtons = peers[0].requests.slice(before - 1, before + 1)
		assert.deepEqual(
			lastButtons.map(({ id, content }) => [id, content.get('_hBtS')]),
			[
				['_hidC', 1],
				['_hidC', 2],
			],
		)
	} finally {
		await controller.stop()
	}
})

test('metadata volume is authoritative and Companion capability changes do not replace it', async () => {
	const { controller, peers, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].push('TVSystemStatus', [['state', 1]])
		assert.equal(controller.feedback.power, 'Off')
		peers[0].push('_iMC', [['_mcF', 0x100]])
		assert.equal(controller.feedback.volume, 35)
		peers[0].push('_iMC', [['_mcF', 0]])
		assert.equal(controller.feedback.volume, 35)
		metadataPeers[0].volume(30)
		assert.equal(await controller.queryVolume(), 30)
		metadataPeers[0].capability(false)
		assert.equal(controller.feedback.volume, null)
		assert.equal(peers[0].requests.filter(({ id }) => id === '_mcc').length, 0)
	} finally {
		await controller.stop()
	}
})

test('stopping during discovery cancels readiness and cannot open a late session', async () => {
	const discovery = Promise.withResolvers()
	const { controller, peers } = fixture({ discover: async () => discovery.promise })
	controller.start()
	const waiting = assert.rejects(controller.waitUntilReady(2000))
	await controller.stop()
	discovery.resolve({ address: 'unused.invalid', companionPort: 1 })
	await waiting
	await Promise.resolve()
	assert.equal(controller.state, 'stopped')
	assert.equal(peers.length, 0)
})

test('stopping an idle session closes both connections without a Companion volume query', async () => {
	const { controller, peers, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].push('_iMC', [['_mcF', 0x100]])
	} finally {
		await controller.stop()
	}
	assert.equal(controller.state, 'stopped')
	assert.equal(peers[0].requests.filter(({ id }) => id === '_mcc').length, 0)
	assert.equal(peers[0].requests.at(-1).id, '_sessionStop')
	assert.equal(metadataPeers[0].closed, true)
})

test('status queries share the gesture queue and reject offline calls', async () => {
	const { controller, peers } = fixture()
	await assert.rejects(controller.queryPower(), CommandNotSent)
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const held = Promise.withResolvers()
		peers[0].onRequest = async (id, content) => {
			if (id === '_hidC' && content.get('_hBtS') === 1) await held.promise
		}
		const gesture = controller.perform({ kind: 'button', button: 'select' })
		await until(() => peers[0].requests.some(({ id }) => id === '_hidC'))
		const query = controller.queryVolume()
		await delay(10)
		assert.equal(peers[0].requests.at(-1).id, '_hidC')
		held.resolve(undefined)
		await gesture
		assert.equal(await query, 35)
		assert.equal(peers[0].requests.at(-1).content.get('_hBtS'), 2)
		assert.equal(peers[0].requests.filter(({ id }) => id === '_mcc').length, 0)
		assert.equal(await controller.queryPower(), 'On')
		assert.equal((await controller.listApps())[0].id, 'com.example.app')
		const beforeWake = peers[0].requests.length
		await controller.perform({ kind: 'power', state: 'On' })
		assert.deepEqual(
			peers[0].requests.slice(beforeWake).map(({ id }) => id),
			['FetchAttentionState'],
		)
	} finally {
		await controller.stop()
	}
})

for (const source of ['control', 'volume', 'health']) {
	test(`a ${source} timeout invalidates pending input before the queue advances`, async () => {
		const { controller, peers } = fixture({ healthIntervalMs: source === 'health' ? 5 : 30000 })
		const started = Promise.withResolvers()
		const gate = Promise.withResolvers()
		controller.start()
		try {
			await controller.waitUntilReady(2000)
			peers[0].onRequest = async (id, content) => {
				const target =
					source === 'control'
						? id === '_hidC' && content.get('_hBtS') === 1
						: source === 'volume'
							? id === '_mcc'
							: id === 'FetchLaunchableApplicationsEvent'
				if (target) {
					started.resolve(undefined)
					await gate.promise
					throw new Error('Synthetic response timeout')
				}
			}
			const failed =
				source === 'control'
					? assert.rejects(controller.perform({ kind: 'button', button: 'select' }), /Synthetic response timeout/)
					: source === 'volume'
						? assert.rejects(controller.perform({ kind: 'volume', percent: 25 }), /Synthetic response timeout/)
						: Promise.resolve()
			await started.promise
			const queued = assert.rejects(controller.perform({ kind: 'button', button: 'right' }), CommandNotSent)
			gate.resolve(undefined)
			await Promise.all([failed, queued])
			assert.equal(
				peers[0].requests.filter(({ id, content }) => id === '_hidC' && content.get('_hidC') === 4).length,
				0,
			)
		} finally {
			gate.resolve(undefined)
			await controller.stop()
		}
	})
}

test('metadata loss closes both sessions and rejects late feedback from the old connection', async () => {
	const { controller, peers, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		metadataPeers[0].close()
		assert.equal(controller.state, 'reconnecting')
		assert.equal(controller.feedback.volume, null)
		await until(() => controller.reconnects === 1)
		assert.equal(peers[0].closed, true)
		metadataPeers[0].volume(99)
		assert.equal(await controller.queryVolume(), 35)
		assert.equal(
			peers[1].requests.some(({ id }) => id === '_mcc'),
			false,
		)
	} finally {
		await controller.stop()
	}
	assert.ok(metadataPeers.every((peer) => peer.closed))
})

test('a queued absolute-volume command cannot cross a same-ID output-list change', async () => {
	const { controller, peers, metadataPeers } = fixture()
	const held = Promise.withResolvers()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].onRequest = async (id, content) => {
			if (id === '_hidC' && content.get('_hBtS') === 1) await held.promise
		}
		const first = controller.perform({ kind: 'button', button: 'select' })
		await until(() => peers[0].requests.some(({ id }) => id === '_hidC'))
		const volume = assert.rejects(controller.perform({ kind: 'volume', percent: 25 }), /output changed while/)
		metadataPeers[0].route(['headphones'])
		metadataPeers[0].capability()
		metadataPeers[0].volume(50)
		held.resolve(undefined)
		await Promise.all([first, volume])
		assert.equal(
			peers[0].requests.some(({ id }) => id === '_mcc'),
			false,
		)
		assert.equal(controller.reconnects, 0)
	} finally {
		held.resolve(undefined)
		await controller.stop()
	}
})

test('controller volume and mute use confirmed metadata through one paired lifetime', async () => {
	const { controller, peers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		await controller.perform({ kind: 'volume', percent: 30 })
		assert.equal(await controller.queryVolume(), 30)
		await controller.perform({ kind: 'mute' })
		assert.equal(controller.feedback.mute, 'Muted')
		await controller.perform({ kind: 'mute' })
		assert.equal(await controller.queryVolume(), 30)
		assert.deepEqual(
			peers[0].requests.filter(({ id }) => id === '_mcc').map(({ content }) => content.get('_mcc')),
			[6, 6, 6],
		)
		assert.equal(controller.reconnects, 0)
	} finally {
		await controller.stop()
	}
})
