import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CommandNotSent } from '../dist/prototype/queue.js'
import { OutputRouteRejected } from '../dist/prototype/metadata-session.js'
import { NodeBackend } from '../dist/node-backend.js'
import { saved } from './fixtures/node-setup-peer.mjs'
import { fixture, until } from './fixtures/controller-peer.mjs'
import { runAcceptance } from '../dist/prototype/acceptance.js'

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

test('output pilot observes a slow round trip and sends only the initial mute', async () => {
	const { controller, peers, metadataPeers } = fixture()
	const events = []
	const cancel = new AbortController()
	let elapsed = 0
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const original = controller.audioOutputIdentity
		assert.ok(original)
		await runAcceptance(controller, {
			appName: '',
			mode: 'audio-output',
			signal: cancel.signal,
			record: (event) => events.push(event),
			pause: async (ms) => {
				elapsed += ms
				if (elapsed === 140000) {
					metadataPeers[0].route(['headphones'])
					metadataPeers[0].capability()
					metadataPeers[0].volume(20)
					assert.notEqual(controller.audioOutputIdentity, original)
				}
				if (elapsed === 160000) {
					metadataPeers[0].route()
					metadataPeers[0].capability()
					metadataPeers[0].volume(0)
				}
				if (elapsed === 165000) await until(() => controller.feedback.volume === 0)
			},
		})
		assert.equal(elapsed, 165000)
		assert.equal(controller.audioOutputIdentity, original)
		assert.equal(controller.feedback.mute, 'Unavailable')
		assert.equal(events.at(-1).clearedBeforeOutputChange, false)
		await until(() => controller.feedback.volume === 0)
		await assert.rejects(controller.perform({ kind: 'mute' }), /No saved volume/)
		assert.deepEqual(
			peers[0].requests.filter(({ id }) => id === '_mcc').map(({ content }) => content.get('_vol').value),
			[0],
		)
		assert.deepEqual(
			events.filter((event) => event.result.includes('cleared')).map((event) => event.stage),
			['changed output', 'original output returned', 'output round trip complete'],
		)
		assert.equal(controller.reconnects, 0)
		assert.equal(
			peers[0].requests.some(({ id }) => id === '_hidC'),
			false,
		)
		assert.equal(
			peers[0].events.some(({ id }) => id === '_hidC'),
			false,
		)
	} finally {
		await controller.stop()
	}
	assert.equal(controller.audioOutputIdentity, undefined)
})

test('output pilot keeps tracing when volume arrives before output identity', async () => {
	const { controller, peers, metadataPeers } = fixture()
	const events = []
	let pauses = 0
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		await runAcceptance(controller, {
			appName: '',
			mode: 'audio-output',
			signal: new AbortController().signal,
			record: (event) => events.push(event),
			pause: async () => {
				pauses++
				const peer = metadataPeers[0]
				if (pauses === 1) peer.volume(20)
				if (pauses === 2) {
					peer.route(['headphones'])
					peer.capability()
					peer.volume(20)
				}
				if (pauses === 3) peer.volume(25)
				if (pauses === 4) {
					peer.route()
					peer.capability()
					peer.volume(0)
				}
				if (pauses === 5) await until(() => controller.feedback.volume === 0)
			},
		})
		const earlyVolume = events.findIndex(
			(event) => event.stage === 'audio observation' && event.output === 'original' && event.volume === 20,
		)
		const departure = events.findIndex((event) => event.stage === 'changed output')
		assert.ok(earlyVolume >= 0 && departure > earlyVolume)
		assert.equal(events.find((event) => event.stage === 'saved mute level cleared').clearedBeforeOutputChange, true)
		assert.equal(events.at(-1).clearedBeforeOutputChange, true)
		assert.equal(controller.feedback.mute, 'Unavailable')
		await until(() => controller.feedback.volume === 0)
		await assert.rejects(controller.perform({ kind: 'mute' }), /No saved volume/)
		assert.deepEqual(
			peers[0].requests.filter(({ id }) => id === '_mcc').map(({ content }) => content.get('_vol').value),
			[0],
		)
	} finally {
		await controller.stop()
	}
})

for (const [scenario, expected] of [
	['no switch', /No complete output round trip/],
	['capability loss only', /No complete output round trip/],
	['no return', /No complete output round trip/],
	['volume report without switch', /No complete output round trip/],
	['connection loss', /Connection changed/],
	['cancel', /abort/i],
	['stale saved level', /Saved mute level survived/],
	['reappearing saved level', /Saved mute level reappeared/],
	['nonzero retained saved level', /Saved mute level survived a nonzero/],
	['report failure', /Synthetic report failure/],
	['switch after return', /changed again after returning/],
]) {
	test(`output pilot stops on ${scenario} without another volume write`, async () => {
		const { controller, peers, metadataPeers } = fixture()
		const cancel = new AbortController()
		let pauses = 0
		let observers = 0
		controller.start()
		try {
			await controller.waitUntilReady(2000)
			const subscribe = controller.observe.bind(controller)
			controller.observe = (listener) => {
				observers++
				const unsubscribe = subscribe(listener)
				return () => {
					observers--
					unsubscribe()
				}
			}
			await assert.rejects(
				runAcceptance(controller, {
					appName: '',
					mode: 'audio-output',
					signal: cancel.signal,
					record: (event) => {
						if (scenario === 'report failure' && event.stage === 'changed output')
							throw new Error('Synthetic report failure')
					},
					pause: async () => {
						pauses++
						const peer = metadataPeers[0]
						if (pauses === 1) {
							if (scenario === 'capability loss only') peer.capability(false)
							if (scenario === 'volume report without switch') peer.volume(15)
							if (scenario === 'connection loss') peer.close()
							if (scenario === 'cancel') cancel.abort()
							if (scenario === 'stale saved level') {
								const feedback = controller.feedback
								Object.defineProperty(controller, 'feedback', { get: () => feedback })
							}
							if (scenario === 'reappearing saved level' || scenario === 'nonzero retained saved level') {
								const feedback = controller.feedback
								if (scenario === 'reappearing saved level') peer.volume(15)
								Object.defineProperty(controller, 'feedback', {
									get: () => ({ ...feedback, volume: scenario === 'nonzero retained saved level' ? 15 : 0 }),
								})
								peer.volume(15)
							}
							if (['no return', 'stale saved level', 'report failure', 'switch after return'].includes(scenario))
								peer.route(['headphones'])
						}
						if (scenario === 'switch after return') {
							if (pauses === 2) peer.route()
							if (pauses === 3) peer.route(['headphones'])
						}
					},
				}),
				expected,
			)
			assert.equal(observers, 0, 'Pilot observation must be detached on every exit')
			assert.ok(pauses <= 360)
			assert.deepEqual(
				peers[0].requests.filter(({ id }) => id === '_mcc').map(({ content }) => content.get('_vol').value),
				[0],
			)
		} finally {
			await controller.stop()
		}
	})
}

test('system audio routing sends one SharedSystemAudio request on the metadata session', async () => {
	const { controller, peers, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const before = controller.audioOutputs
		assert.deepEqual(before.outputs, [{ id: 'tv-output', name: 'Synthetic TV' }])
		assert.equal(before.routable, true)
		assert.equal(await controller.routeAudio(before.epoch, ['synthetic-airpods']), true)
		const [request] = metadataPeers[0].requests.filter((message) => message.type === 48)
		assert.equal(request['.modifyOutputContextRequestMessage'].type, 2)
		assert.deepEqual(request['.modifyOutputContextRequestMessage'].settingDevices, ['synthetic-airpods'])
		assert.deepEqual(request['.modifyOutputContextRequestMessage'].clusterAwareSettingDevices, ['synthetic-airpods'])
		assert.deepEqual(request['.modifyOutputContextRequestMessage'].addingDevices, [])
		await until(() => controller.audioOutputs?.outputs.length === 2)
		metadataPeers[0].routeMode = 'ignore'
		assert.equal(await controller.routeAudio(before.epoch, ['tv-output']), true)
		metadataPeers[0].routeMode = 'reject'
		await assert.rejects(controller.routeAudio(before.epoch, ['tv-output']), OutputRouteRejected)
		assert.equal(metadataPeers[0].routeRequests.length, 3)
		assert.equal(controller.state, 'ready', 'a rejected or unacknowledged route does not reconnect')
		assert.equal(peers.length, 1)
		assert.equal(peers[0].requests.filter(({ id }) => id === '_hidC').length, 0)
	} finally {
		await controller.stop()
	}
})

test('a route request from a previous session is rejected after reconnect and never replayed', async () => {
	const { controller, metadataPeers } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const { epoch } = controller.audioOutputs
		metadataPeers[0].close()
		assert.equal(controller.audioOutputs, undefined)
		await until(() => controller.reconnects === 1)
		await assert.rejects(controller.routeAudio(epoch, ['synthetic-airpods']), CommandNotSent)
		assert.ok(controller.audioOutputs.epoch > epoch)
		assert.equal(metadataPeers.flatMap((peer) => peer.routeRequests).length, 0)
	} finally {
		await controller.stop()
	}
	await assert.rejects(controller.routeAudio(1, ['synthetic-airpods']), CommandNotSent)
})

test('backend toggles a learned personal output and keeps its identifier out of public config', async () => {
	const f = fixture()
	const values = {}
	const saves = []
	let feedbackChecks = 0
	const backend = new NodeBackend(
		{
			save: (config, secrets) => saves.push(structuredClone({ config, secrets })),
			status: () => {},
			values: (update) => Object.assign(values, update),
			apps: () => {},
			feedback: () => feedbackChecks++,
		},
		{ controller: () => f.controller, personalOutputConfirmationMs: 2000 },
	)
	const names = { 'synthetic-airpods': "Someone's AirPods" }
	try {
		await backend.configure(
			{ enabled: true, deviceId: 'synthetic-tv', personalOutputName: 'airpods' },
			saved('synthetic-tv'),
		)
		await until(() => values.connection === 'ready')
		assert.equal(values.personal_output_route, 'Unavailable')
		await backend.selectPersonalOutput('toggle')
		assert.match(values.last_result, /not identified/)
		// The owner selects the AirPods once on the TV; the module learns the reported UID.
		f.metadataPeers[0].names = names
		f.metadataPeers[0].route([{ id: 'synthetic-airpods', name: names['synthetic-airpods'] }])
		await until(() => values.personal_output_route === 'Personal')
		assert.equal(values.personal_output_name, names['synthetic-airpods'])
		assert.equal(backend.personalOutputActive, true)
		const learned = saves.at(-1)
		assert.equal(learned.secrets.personalOutput.id, 'synthetic-airpods')
		assert.ok(learned.secrets.pairing, 'learning keeps the saved pairing')
		assert.equal(JSON.stringify(learned.config).includes('synthetic-airpods'), false)

		await backend.selectPersonalOutput('toggle')
		await until(() => values.personal_output_route === 'Default')
		assert.deepEqual(f.metadataPeers[0].routeRequests.at(-1).settingDevices, ['tv-output'])
		assert.equal(backend.personalOutputActive, false)
		await backend.selectPersonalOutput('toggle')
		await until(() => values.personal_output_route === 'Personal')
		assert.match(values.last_result, /personal output confirmed/)
		assert.deepEqual(f.metadataPeers[0].routeRequests.at(-1).settingDevices, ['synthetic-airpods'])
		assert.equal(f.metadataPeers[0].routeRequests.length, 2)
		assert.ok(feedbackChecks >= 3)
	} finally {
		await backend.stop()
	}
	assert.equal(values.personal_output_route, 'Unavailable')
})

test('a burst of navigation presses survives one unanswered key acknowledgement', async () => {
	const { controller, peers } = fixture({ requestTimeoutMs: 50 })
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		let silent = true
		peers[0].onRequest = async (id, content) => {
			if (id === '_hidC' && content.get('_hBtS') === 1 && silent) {
				silent = false
				await new Promise(() => {})
			}
		}
		const burst = ['down', 'down', 'down', 'right'].map((button) =>
			controller.perform({ kind: 'button', button }).then(
				() => 'sent',
				() => 'dropped',
			),
		)
		const results = await Promise.all(burst)
		assert.equal(results[0], 'dropped')
		assert.equal(controller.state, 'ready')
		await controller.perform({ kind: 'button', button: 'down' })
		assert.equal(peers.length, 1)
		assert.equal(controller.reconnects, 0)
	} finally {
		await controller.stop()
	}
})

test('repeated unanswered commands still end a silent session and log why', async () => {
	const { controller, peers, logs } = fixture({ requestTimeoutMs: 20 })
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].onRequest = async (id) => {
			if (id === '_hidC') await new Promise(() => {})
		}
		let attempts = 0
		let failure
		while (controller.state === 'ready' && attempts++ < 10)
			failure = await controller.perform({ kind: 'button', button: 'down' }).catch((error) => error)
		await until(() => controller.reconnects === 1)
		assert.ok(attempts > 1)
		assert.ok(logs.some(({ level, message }) => level === 'warn' && message.includes(failure.message)))
	} finally {
		await controller.stop()
	}
})

test('an idle session that stops answering is detected by the health check', async () => {
	const { controller, peers } = fixture({ requestTimeoutMs: 20, healthIntervalMs: 10 })
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].onRequest = async () => new Promise(() => {})
		await until(() => controller.reconnects === 1)
	} finally {
		await controller.stop()
	}
})

test('a failed session logs one line with the underlying error', async () => {
	const { controller, peers, logs } = fixture()
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		const failure = new Error('synthetic transport failure')
		peers[0].onRequest = async (id) => {
			if (id === '_hidC') throw failure
		}
		await assert.rejects(controller.perform({ kind: 'button', button: 'select' }))
		await until(() => controller.reconnects === 1)
		const reasons = logs.filter(({ message }) => message.includes(failure.message))
		assert.equal(reasons.length, 1)
	} finally {
		await controller.stop()
	}
})

test('a closed transport still reconnects immediately and logs the reason', async () => {
	const { controller, peers, logs } = fixture({ requestTimeoutMs: 1000 })
	controller.start()
	try {
		await controller.waitUntilReady(2000)
		peers[0].onRequest = async (id) => {
			if (id === '_hidC') {
				peers[0].close()
				await new Promise(() => {})
			}
		}
		const failure = await controller.perform({ kind: 'button', button: 'down' }).catch((error) => error)
		assert.ok(failure instanceof Error)
		await until(() => controller.reconnects === 1)
		assert.ok(logs.some(({ level, message }) => level === 'warn' && message.includes(failure.message)))
	} finally {
		await controller.stop()
	}
})
