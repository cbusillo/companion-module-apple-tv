import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { runAcceptance } from '../dist/prototype/acceptance.js'

function fixture() {
	const actions = []
	const events = []
	const pauses = []
	const cancel = new AbortController()
	let power = 'On'
	let volume = 50
	const controller = {
		state: 'ready',
		reconnects: 0,
		async listApps() {
			return [{ id: 'com.example.player', name: 'Player' }]
		},
		async queryPower() {
			return power
		},
		async queryVolume() {
			return volume
		},
		async perform(action) {
			actions.push(action)
			if (action.kind === 'power') power = action.state
			if (action.button === 'volumeDown') volume--
			if (action.button === 'volumeUp') volume++
		},
	}
	const options = {
		appName: 'Player',
		signal: cancel.signal,
		record: (event) => events.push(event),
		pause: async (ms) => {
			pauses.push(ms)
		},
	}
	return { controller, options, actions, events, pauses, cancel }
}

test('prepared pilot foregrounds its target, closes it, and uses explicit sleep then wake', async () => {
	const { controller, options, actions, events, pauses } = fixture()
	await runAcceptance(controller, options)
	assert.deepEqual(actions, [
		{ kind: 'button', button: 'volumeDown' },
		{ kind: 'button', button: 'volumeUp' },
		{ kind: 'launch', bundleId: 'com.example.player' },
		{ kind: 'button', button: 'appSwitcher' },
		{ kind: 'swipe', direction: 'up' },
		{ kind: 'power', state: 'Off' },
		{ kind: 'power', state: 'On' },
	])
	assert.equal(pauses.length, actions.length)
	assert.ok(pauses.every((ms) => ms >= 5000))
	assert.equal(events.filter((event) => 'volume' in event).at(-1).volume, 50)
	assert.deepEqual(
		events.filter((event) => event.stage === 'power report').map((event) => event.result),
		['Off', 'On'],
	)
})

test('preflight refuses an absent or ambiguous app before any control', async () => {
	for (const apps of [
		[],
		[
			{ id: 'one', name: 'Player' },
			{ id: 'two', name: 'Player' },
		],
	]) {
		const { controller, options, actions } = fixture()
		controller.listApps = async () => apps
		await assert.rejects(runAcceptance(controller, options), /exactly one/)
		assert.equal(actions.length, 0)
	}
})

test('preflight refuses unknown power or volume near an end stop without sending controls', async () => {
	for (const invalid of ['power', 'volume']) {
		const { controller, options, actions } = fixture()
		if (invalid === 'power') controller.queryPower = async () => 'Unknown'
		else controller.queryVolume = async () => 0
		await assert.rejects(runAcceptance(controller, options))
		assert.equal(actions.length, 0)
	}
})

test('failed dispatch stops the prepared sequence without retries or compensating controls', async () => {
	const { controller, options, actions } = fixture()
	controller.perform = async (action) => {
		actions.push(action)
		throw new Error('Synthetic response loss')
	}
	await assert.rejects(runAcceptance(controller, options), /Synthetic response loss/)
	assert.equal(actions.length, 1)
	assert.equal(actions[0].button, 'volumeDown')
})

test('connection loss, a completed reconnect, or cancellation during an observation gap stops input', async () => {
	for (const interruption of ['disconnect', 'reconnect', 'cancel']) {
		const { controller, options, actions, cancel } = fixture()
		options.pause = async () => {
			if (interruption === 'disconnect') controller.state = 'reconnecting'
			else if (interruption === 'reconnect') controller.reconnects++
			else cancel.abort()
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.equal(actions.length, 1)
	}
})

test('an unconfirmed sleep state never turns into a blind toggle or repeated sleep', async () => {
	const { controller, options, actions } = fixture()
	controller.queryPower = async () => (actions.some((action) => action.kind === 'power') ? 'Unknown' : 'On')
	await assert.rejects(runAcceptance(controller, options), /Power did not report Off/)
	assert.deepEqual(
		actions.filter((action) => action.kind === 'power'),
		[{ kind: 'power', state: 'Off' }],
	)
})

test('a wake acknowledgement without reported On does not pass or trigger another wake', async () => {
	const { controller, options, actions } = fixture()
	controller.queryPower = async () => {
		const lastPower = actions.filter((action) => action.kind === 'power').at(-1)
		return lastPower?.state === 'On' ? 'Unknown' : (lastPower?.state ?? 'On')
	}
	await assert.rejects(runAcceptance(controller, options), /Power did not report On/)
	assert.equal(actions.filter((action) => action.kind === 'power' && action.state === 'On').length, 1)
})

test('default CLI preview does not read credentials or connect to a device', () => {
	const result = spawnSync(
		process.execPath,
		[
			'dist/prototype/acceptance-live.js',
			'--app',
			'Player',
			'--credentials',
			'/nonexistent/preview-only.json',
			'--report',
			'/nonexistent/preview-report.json',
		],
		{ encoding: 'utf8', timeout: 2000 },
	)
	assert.equal(result.status, 0, result.stderr)
	assert.equal(JSON.parse(result.stdout).mode, 'offline preview')
})

test('explicit run without required file paths fails before opening a device connection', () => {
	const result = spawnSync(process.execPath, ['dist/prototype/acceptance-live.js', '--run'], {
		encoding: 'utf8',
		timeout: 2000,
	})
	assert.equal(result.status, 1)
	assert.equal(result.stdout, '')
})
