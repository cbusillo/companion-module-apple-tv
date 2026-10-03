import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { NodeBackend } from '../dist/node-backend.js'
import { saved } from './fixtures/node-setup-peer.mjs'
import { fixture, until } from './fixtures/controller-peer.mjs'

// A slow AirPods takeover: tvOS answers the route request after the module's 3 s
// acknowledgement wait, or never. The shared session must stay up and the reported
// output list alone must decide the result inside the 20 s confirmation window.
async function slowTakeover(configure) {
	const f = fixture()
	const states = []
	const values = {}
	const routes = []
	const backend = new NodeBackend(
		{
			save: () => {},
			status: (state) => states.push(state),
			values: (update) => {
				Object.assign(values, update)
				if (update.personal_output_route) routes.push(update.personal_output_route)
			},
			apps: () => {},
		},
		{ controller: () => f.controller },
	)
	await backend.configure(
		{ enabled: true, deviceId: 'synthetic-tv', personalOutputId: 'synthetic-airpods' },
		saved('synthetic-tv'),
	)
	await until(() => values.connection === 'ready' && values.personal_output_route === 'Default')
	const readyAt = states.length
	configure(f.metadataPeers[0])
	return { f, states, values, routes, backend, readyAt }
}

function assertSessionKept({ f, states, readyAt }) {
	assert.deepEqual(states.slice(readyAt), [], 'the connection never left ready')
	assert.equal(f.controller.state, 'ready')
	assert.equal(f.controller.reconnects, 0)
	assert.equal(f.metadataPeers.length, 1)
	assert.equal(f.metadataPeers[0].closed, false)
	assert.equal(f.peers.length, 1)
	assert.equal(f.metadataPeers[0].routeRequests.length, 1, 'nothing was resent')
}

test('an acknowledgement after 5 s keeps the connection and the route confirms from the list', async () => {
	const t = await slowTakeover((peer) => {
		peer.routeMode = 'late'
		peer.routeAckMs = 5000
		peer.routeApplyMs = 6000
	})
	try {
		const press = t.backend.selectPersonalOutput('toggle')
		assert.equal(t.values.personal_output_route, 'Connecting')
		await press
		assert.match(t.values.last_result, /without acknowledgement; waiting/)
		assert.equal(t.values.personal_output_route, 'Connecting')
		await until(() => t.values.personal_output_route === 'Personal', 8000)
		assert.deepEqual(t.routes.slice(-2), ['Connecting', 'Personal'])
		assert.match(t.values.last_result, /personal output confirmed/)
		await delay(200)
		assertSessionKept(t)
	} finally {
		await t.backend.stop()
	}
})

test('a missing acknowledgement keeps the connection and a later route change still confirms', async () => {
	const t = await slowTakeover((peer) => {
		peer.routeMode = 'never'
		peer.routeApplyMs = 4000
	})
	try {
		await t.backend.selectPersonalOutput('toggle')
		assert.match(t.values.last_result, /without acknowledgement; waiting/)
		assert.equal(t.values.personal_output_route, 'Connecting')
		await until(() => t.values.personal_output_route === 'Personal', 6000)
		assert.ok(!t.routes.includes('Failed'))
		assertSessionKept(t)
	} finally {
		await t.backend.stop()
	}
})
