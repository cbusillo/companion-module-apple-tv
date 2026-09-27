import assert from 'node:assert/strict'
import test from 'node:test'
import AppleTV, { UpgradeScripts } from '../dist/main.js'
import { config, saved, nextTurn, setupFixture } from './fixtures/node-setup-peer.mjs'

test('completed discovery notifies an open Companion editor with the new choices', async () => {
	const f = fixture()
	const fieldsAtSave = []
	f.context.saveConfig = (...args) => {
		f.hooks.save(...args)
		fieldsAtSave.push(f.module.getConfigFields().find((field) => field.id === 'deviceId').choices)
	}
	try {
		await f.module.init({ ...config, deviceId: '' }, true, {})
		await nextTurn()
		assert.ok(fieldsAtSave.at(-1).some((choice) => choice.id === config.deviceId))
		f.options.discover = async () => [
			{
				deviceId: 'newly-visible',
				name: 'New TV',
				address: '127.0.0.1',
				model: 'AppleTV14,1',
				port: 1,
				companionPort: 2,
			},
		]
		await f.module.configUpdated({ ...config, deviceId: '', refresh: true }, {})
		await nextTurn()
		assert.ok(fieldsAtSave.at(-1).some((choice) => choice.id === 'newly-visible'))
		assert.equal(f.pairs.length, 0)
	} finally {
		await f.module.destroy()
	}
})

function fixture() {
	const f = setupFixture()
	const context = {
		_isInstanceContext: true,
		id: 'synthetic-module',
		label: 'Synthetic Apple TV',
		setVariableDefinitions: (definitions) => {
			f.definitions = definitions
		},
		setVariableValues: f.hooks.values,
		setActionDefinitions: (actions) => {
			f.actions = actions
		},
		updateStatus: (status, message) => f.states.push({ status, message }),
		saveConfig: f.hooks.save,
	}
	return { ...f, module: new AppleTV(context, f.options), context, source: f }
}

test('Companion entrypoint restores saved pairing and routes existing button IDs through Node', async () => {
	const f = fixture()
	try {
		await f.module.init(config, false, saved())
		await nextTurn()
		const actions = f.source.actions
		for (const command of ['select', 'seekBackward', 'seekForward30', 'swipeUp', 'toggleMute', 'power'])
			await actions.command.callback({ options: { command } })
		await actions.launchApp.callback({ options: { appId: 'synthetic.app' } })
		assert.deepEqual(f.controllers[0].actions, [
			{ kind: 'button', button: 'select' },
			{ kind: 'seek', seconds: -10 },
			{ kind: 'seek', seconds: 30 },
			{ kind: 'swipe', direction: 'up' },
			{ kind: 'mute' },
			{ kind: 'power' },
			{ kind: 'launch', bundleId: 'synthetic.app' },
		])
		const before = f.controllers[0].actions.length
		await actions.command.callback({ options: { command: '__proto__' } })
		assert.equal(f.controllers[0].actions.length, before)
		assert.equal(f.values.last_result, 'unknown command; not sent')
		assert.equal(f.values.power, 'On')
		assert.equal(f.values.title, 'Synthetic title')
		assert.equal(f.pairs.length, 0)
	} finally {
		await f.module.destroy()
	}
	assert.equal(f.controllers[0].stops, 1)
})

test('configuration and secret callbacks complete one pairing and preserve the pending attempt across Save', async () => {
	const f = fixture()
	try {
		await f.module.init({ ...config, pair: true }, true, {})
		await nextTurn()
		assert.equal(f.pairs.length, 1)
		await f.module.configUpdated(config, {})
		await nextTurn()
		assert.equal(f.pairs.length, 1)
		await f.module.configUpdated(config, { pin: '0123' })
		await nextTurn()
		assert.equal(f.saves.at(-1).secrets.pairing.deviceId, config.deviceId)
		assert.equal(Object.hasOwn(f.saves.at(-1).config, 'pin'), false)
		assert.equal(Object.hasOwn(f.saves.at(-1).secrets, 'pin'), false)
		assert.equal(f.values.connection, 'ready')
	} finally {
		await f.module.destroy()
	}
})

test('legacy upgrade preserves button options and old paths while requiring explicit new setup', async () => {
	const old = { enabled: true, python: '/not-read/python', credentialFile: '/not-read/credentials.json' }
	const action = { id: 'old-button', controlId: 'old-control', actionId: 'command', options: { command: 'select' } }
	const result = UpgradeScripts[0]({}, { config: old, secrets: null, actions: [action], feedbacks: [] })
	assert.equal(result.updatedConfig.enabled, false)
	assert.equal(result.updatedConfig.python, old.python)
	assert.equal(result.updatedConfig.credentialFile, old.credentialFile)
	assert.deepEqual(action.options, { command: 'select' })
	const f = fixture()
	try {
		await f.module.init(result.updatedConfig, false, {})
		await nextTurn()
		assert.equal(f.controllers.length, 0)
		assert.equal(f.pairs.length, 0)
		assert.equal(f.scans.length, 0)
		assert.equal(f.values.connection, 'disabled')
	} finally {
		await f.module.destroy()
	}
	assert.equal(UpgradeScripts[0]({}, { config, secrets: saved(), actions: [], feedbacks: [] }).updatedConfig, null)
})

test('Save returns while discovery is pending and disable cancels it before late results can publish', async () => {
	const f = fixture()
	const gate = Promise.withResolvers()
	let signal
	f.options.discover = async (options) => {
		signal = options.signal
		return gate.promise
	}
	try {
		await f.module.init({ enabled: true, deviceId: '' }, true, {})
		await nextTurn()
		assert.equal(f.values.connection, 'discovering')
		await f.module.configUpdated({ enabled: false, deviceId: '' }, {})
		await nextTurn()
		assert.equal(signal.aborted, true)
		assert.equal(f.values.connection, 'disabled')
		gate.resolve([])
		await nextTurn()
		assert.equal(f.values.connection, 'disabled')
		assert.equal(f.controllers.length, 0)
	} finally {
		gate.resolve([])
		await f.module.destroy()
	}
})

test('destroy during schema preflight cannot start a late backend', async () => {
	const f = fixture()
	const starting = f.module.init(config, false, saved())
	await f.module.destroy()
	await starting
	await nextTurn()
	assert.equal(f.scans.length, 0)
	assert.equal(f.controllers.length, 0)
})
