import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { NodeController } from '../dist/prototype/controller.js'
import { withCompanionSession } from '../dist/prototype/session.js'
import { CommandNotSent } from '../dist/prototype/queue.js'

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
	let discoveries = 0
	const controller = new NodeController('synthetic', credentials, {
		reconnectDelayMs: 5,
		healthIntervalMs: 30000,
		discover: async () => {
			discoveries++
			return { address: 'unused.invalid', companionPort: 1 }
		},
		session: async (target, keys, signal, operation) => {
			const peer = new Peer()
			peers.push(peer)
			return withCompanionSession(target, keys, signal, operation, () => peer)
		},
		...options,
	})
	return { controller, peers, discoveries: () => discoveries }
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
	const { controller, peers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		await assert.rejects(controller.perform({ kind: 'button', button: 'invalid' }), RangeError)
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

test('pushed power and volume capability changes update feedback while idle', async () => {
	const { controller, peers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].push('TVSystemStatus', [['state', 1]])
		assert.equal(controller.feedback.power, 'Off')
		peers[0].push('_iMC', [['_mcF', 0x100]])
		await until(() => controller.feedback.volume === 20)
		peers[0].push('_iMC', [['_mcF', 0]])
		assert.equal(controller.feedback.volume, null)
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

test('stopping an idle session discards a queued volume refresh', async () => {
	const { controller, peers } = fixture()
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
		assert.equal(await query, 20)
		assert.equal(peers[0].requests.at(-2).content.get('_hBtS'), 2)
		assert.equal(peers[0].requests.at(-1).id, '_mcc')
		assert.equal(await controller.queryPower(), 'On')
		assert.equal((await controller.listApps())[0].id, 'com.example.app')
		await controller.perform({ kind: 'power', state: 'On' })
		assert.equal(peers[0].requests.at(-1).content.get('_hidC'), 13)
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
					: Promise.resolve()
			if (source === 'volume') peers[0].push('_iMC', [['_mcF', 0x100]])
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
