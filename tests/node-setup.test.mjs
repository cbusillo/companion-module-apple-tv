import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { NodeBackend } from '../dist/node-backend.js'
import { decodePairing, encodePairing } from '../dist/node-credentials.js'
import { CommandNotSent } from '../dist/prototype/queue.js'
import { UnsupportedCommand, CompanionRequestRejected } from '../dist/prototype/companion.js'
import {
	config,
	credentials,
	saved,
	device,
	nextTurn,
	SetupController,
	setupFixture,
} from './fixtures/node-setup-peer.mjs'

function fixture(overrides) {
	const f = setupFixture(overrides)
	f.backend = new NodeBackend(f.hooks, f.options)
	return f
}

test('discovery lists only usable TVs without starting pairing or opening a controller', async () => {
	const f = fixture({
		discover: async () => [
			device(),
			{ ...device('speaker'), model: 'AudioAccessory' },
			{ ...device('missing'), companionPort: undefined },
		],
	})
	try {
		await f.backend.configure({ ...config, deviceId: '' })
		assert.deepEqual(
			f.backend.devices.map((d) => d.id),
			[config.deviceId],
		)
		assert.equal(f.pairs.length, 0)
		assert.equal(f.controllers.length, 0)
		assert.equal(f.states.at(-1).state, 'unpaired')
	} finally {
		await f.backend.stop()
	}
})

test('pairing saves only after fresh verification, clears the PIN and keeps keys out of config/display', async () => {
	const verification = Promise.withResolvers()
	const candidate = new SetupController()
	candidate.waitUntilReady = async () => verification.promise
	const f = fixture({ controller: () => candidate })
	try {
		await f.backend.configure({ ...config, pair: true })
		assert.equal(f.pairs[0].starts, 1)
		assert.equal(f.states.at(-1).state, 'pin')
		assert.equal(f.saves.at(-1).config.pair, false)
		const finish = f.backend.configure(config, { pin: '0123' })
		await nextTurn()
		assert.equal(f.states.at(-1).state, 'verifying')
		assert.ok(f.saves.every((call) => !call.secrets.pairing && !Object.hasOwn(call.secrets, 'pin')))
		verification.resolve(undefined)
		await finish
		assert.deepEqual(f.pairs[0].finishes, ['0123'])
		assert.equal(f.states.at(-1).state, 'ready')
		const stored = f.saves.at(-1)
		assert.equal(stored.secrets.pairing.deviceId, config.deviceId)
		assert.deepEqual(decodePairing(stored.secrets.pairing).credentials, credentials)
		const publicState = JSON.stringify([stored.config, f.states, f.values])
		for (const privateValue of ['0123', credentials.clientId, credentials.clientLTSK.toString('hex')])
			assert.equal(publicState.includes(privateValue), false)
	} finally {
		await f.backend.stop()
	}
	assert.equal(candidate.stops, 1)
})

test('verification failure retains previous credentials and closes the candidate without automatic PIN retry', async () => {
	const candidate = new SetupController()
	candidate.waitUntilReady = async () => {
		throw new Error('provider-private-payload')
	}
	const f = fixture({ controller: () => candidate })
	try {
		await f.backend.configure({ ...config, pair: true }, saved())
		await f.backend.configure(config, { ...saved(), pin: '1234' })
		assert.equal(f.states.at(-1).state, 'error')
		assert.match(f.states.at(-1).message, /new connection could not be verified/)
		assert.deepEqual(f.saves.at(-1).secrets, saved())
		assert.equal(candidate.stops, 1)
		assert.equal(f.pairs.length, 1)
		assert.equal(JSON.stringify([f.states, f.values]).includes('provider-private-payload'), false)
	} finally {
		await f.backend.stop()
	}
})

test('a closed PIN session stops prompting immediately and a late PIN cannot finish or re-pair', async () => {
	const f = fixture()
	try {
		await f.backend.configure({ ...config, pair: true }, saved())
		f.pairs[0].destroy()
		await nextTurn()
		assert.equal(f.states.at(-1).state, 'error')
		assert.match(f.states.at(-1).message, /closed the pairing session/)
		await f.backend.configure(config, { ...saved(), pin: '1234' })
		assert.deepEqual(f.pairs[0].finishes, [])
		assert.equal(f.pairs.length, 1)
		assert.deepEqual(f.saves.at(-1).secrets, saved())
	} finally {
		await f.backend.stop()
	}
})

test('failed pairing reports its stage without exposing the PIN or provider payload', async () => {
	for (const [stage, message] of [
		['proof', /PIN could not be verified/],
		['identity', /identity verification failed/],
	]) {
		const f = fixture()
		try {
			await f.backend.configure({ ...config, pair: true }, saved())
			f.pairs[0].stage = stage
			f.pairs[0].finish = async () => {
				throw new Error('provider-private-payload 9876')
			}
			await f.backend.configure(config, { ...saved(), pin: '9876' })
			assert.equal(f.states.at(-1).state, 'error')
			assert.match(f.states.at(-1).message, message)
			assert.equal(JSON.stringify([f.states, f.values]).includes('provider-private-payload'), false)
			assert.equal(JSON.stringify([f.states, f.values]).includes('9876'), false)
			assert.deepEqual(f.saves.at(-1).secrets, saved())
			assert.equal(f.controllers.length, 0)
		} finally {
			await f.backend.stop()
		}
	}
})

test('disabled, changed-target and expired PIN sessions close without finishing or retaining PIN input', async () => {
	for (const mode of ['disabled', 'changed-target', 'expired']) {
		const f = fixture({ pinTimeoutMs: 15 })
		try {
			await f.backend.configure({ ...config, pair: true })
			if (mode === 'expired') await delay(25)
			else
				await f.backend.configure(
					mode === 'disabled' ? { ...config, enabled: false } : { ...config, deviceId: 'other-tv' },
					{ pin: '1234' },
				)
			assert.ok(f.pairs[0].destroys >= 1)
			assert.equal(f.pairs[0].signal.aborted, true)
			assert.deepEqual(f.pairs[0].finishes, [])
			assert.ok(f.saves.every((call) => !Object.hasOwn(call.secrets, 'pin')))
		} finally {
			await f.backend.stop()
		}
	}
})

test('invalid PIN preserves the pending attempt and duplicate submissions do not send a second finish', async () => {
	const gate = Promise.withResolvers()
	const candidate = new SetupController()
	candidate.waitUntilReady = async () => gate.promise
	const f = fixture({ controller: () => candidate })
	try {
		await f.backend.configure({ ...config, pair: true })
		await f.backend.configure(config, { pin: '123' })
		assert.equal(f.pairs[0].finishes.length, 0)
		const first = f.backend.configure(config, { pin: '0123' })
		await nextTurn()
		await f.backend.configure(config, { pin: '0123' })
		assert.deepEqual(f.pairs[0].finishes, ['0123'])
		gate.resolve(undefined)
		await first
	} finally {
		gate.resolve(undefined)
		await f.backend.stop()
	}
})

test('stopping during verification waits for candidate cleanup and rejects a late saved pairing', async () => {
	const gate = Promise.withResolvers()
	const candidate = new SetupController()
	candidate.waitUntilReady = async () => gate.promise
	const f = fixture({ controller: () => candidate })
	await f.backend.configure({ ...config, pair: true })
	const finishing = f.backend.configure(config, { pin: '1234' })
	await nextTurn()
	await f.backend.stop()
	assert.equal(candidate.stops, 1)
	gate.resolve(undefined)
	await finishing
	assert.ok(f.saves.every((call) => !call.secrets.pairing))
	assert.equal(candidate.listeners.size, 0)
})

test('restarting uses saved pairing without a PIN prompt; refreshing discovery retains the connection', async () => {
	const f = fixture()
	try {
		await f.backend.configure(config, saved())
		await nextTurn()
		assert.equal(f.controllers.length, 1)
		assert.equal(f.pairs.length, 0)
		assert.equal(f.values.power, 'On')
		assert.equal(f.values.title, 'Synthetic title')
		await f.backend.configure({ ...config, refresh: true }, saved())
		assert.equal(f.controllers.length, 1)
		assert.equal(f.controllers[0].stops, 0)
		assert.equal(f.saves.at(-1).config.refresh, false)
		f.controllers[0].state = 'reconnecting'
		f.controllers[0].changed()
		assert.equal(f.values.volume, '')
		assert.equal(f.values.title, 'Nothing Playing')
		assert.equal(f.values.metadata_state, 'Offline')
	} finally {
		await f.backend.stop()
	}
	assert.equal(f.controllers[0].listeners.size, 0)
})

test('overlapping configurations cannot revive a superseded target after slow shutdown', async () => {
	const f = fixture({ discover: async () => [device(), device('second'), device('third')] })
	const gate = Promise.withResolvers()
	try {
		await f.backend.configure(config, saved())
		f.controllers[0].stop = async () => gate.promise
		const second = f.backend.configure({ ...config, deviceId: 'second' }, saved('second'))
		await nextTurn()
		await f.backend.configure({ ...config, deviceId: 'third' }, saved('third'))
		gate.resolve(undefined)
		await second
		assert.deepEqual(f.controllerIds, [config.deviceId, 'third'])
	} finally {
		gate.resolve(undefined)
		await f.backend.stop()
	}
})

test('malformed and mismatched credentials never start a controller or an automatic PIN prompt', async () => {
	for (const pairing of [
		{},
		{ ...saved().pairing, deviceId: 'other' },
		{ ...saved().pairing, credentials: { ...saved().pairing.credentials, clientLTSK: 'bad' } },
	]) {
		const f = fixture()
		try {
			await f.backend.configure(config, { pairing })
			assert.equal(f.controllers.length, 0)
			assert.equal(f.pairs.length, 0)
			assert.equal(f.states.at(-1).state, 'unpaired')
		} finally {
			await f.backend.stop()
		}
	}
	assert.throws(() => encodePairing(config.deviceId, { ...credentials, serverLTPK: Buffer.alloc(31) }))
})

test('ambiguous discovery and cancelled discovery cannot pair a different or late TV', async () => {
	const f = fixture({ discover: async () => [device(), device()] })
	try {
		await f.backend.configure({ ...config, pair: true })
		assert.equal(f.pairs.length, 0)
	} finally {
		await f.backend.stop()
	}
	const gate = Promise.withResolvers()
	const late = fixture({ discover: async () => gate.promise })
	const pending = late.backend.configure({ ...config, pair: true })
	await nextTurn()
	await late.backend.stop()
	gate.resolve([device()])
	await pending
	assert.equal(late.pairs.length, 0)
})

test('commands dispatch once and show bounded error messages without leaking provider payloads', async () => {
	const f = fixture()
	try {
		await f.backend.perform({ kind: 'button', button: 'select' })
		assert.equal(f.values.last_result, 'not connected; not sent')
		await f.backend.configure(config, saved())
		const action = { kind: 'seek', seconds: -10 }
		await f.backend.perform(action)
		assert.deepEqual(f.controllers[0].actions, [action])
		for (const error of [
			new CommandNotSent('private'),
			new UnsupportedCommand('private'),
			new CompanionRequestRejected('private'),
			new Error('private'),
		]) {
			let sends = 0
			f.controllers[0].perform = async () => {
				sends++
				throw error
			}
			await f.backend.perform(action)
			assert.equal(sends, 1)
			assert.equal(f.values.last_result.includes('private'), false)
		}
	} finally {
		await f.backend.stop()
	}
})

test('a late disable completion cannot replace a newer ready state', async () => {
	const f = fixture(),
		gate = Promise.withResolvers()
	try {
		await f.backend.configure(config, saved())
		f.controllers[0].stop = async () => gate.promise
		const disabling = f.backend.configure({ ...config, enabled: false }, saved())
		await nextTurn()
		await f.backend.configure(config, saved())
		gate.resolve(undefined)
		await disabling
		assert.equal(f.states.at(-1).state, 'ready')
	} finally {
		gate.resolve(undefined)
		await f.backend.stop()
	}
})
