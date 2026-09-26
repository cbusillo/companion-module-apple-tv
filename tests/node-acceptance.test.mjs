import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { runAcceptance } from '../dist/prototype/acceptance.js'

function fixture(initialPower = 'On') {
	const actions = []
	const events = []
	const pauses = []
	const cancel = new AbortController()
	let power = initialPower
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
		mode: 'remaining',
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

test('default focused pilot closes the selected app and stops without volume or power controls', async () => {
	const { controller, options, actions } = fixture()
	delete options.mode
	controller.queryVolume = async () => assert.fail('The focused test must not require volume support')
	await runAcceptance(controller, options)
	assert.deepEqual(actions, [
		{ kind: 'launch', bundleId: 'com.example.player' },
		{ kind: 'button', button: 'appSwitcher' },
		{ kind: 'swipe', direction: 'up' },
	])
})

test('volume-only pilot records each level and sends just one down/up pair without an app prerequisite', async () => {
	const { controller, options, actions, events, pauses } = fixture()
	options.mode = 'volume'
	options.appName = ''
	controller.listApps = async () => assert.fail('Volume pilot must not require an app')
	await runAcceptance(controller, options)
	assert.deepEqual(actions, [
		{ kind: 'button', button: 'volumeDown' },
		{ kind: 'button', button: 'volumeUp' },
	])
	assert.deepEqual(pauses, [5000, 5000])
	assert.deepEqual(
		events.filter((event) => 'volume' in event).map((event) => event.volume),
		[50, 49, 50],
	)
})

test('volume-only preflight refuses sleeping/unknown power and unavailable or end-stop volume', async () => {
	for (const state of ['Off', 'Unknown', 'unavailable', 0, 100, NaN]) {
		const { controller, options, actions } = fixture()
		options.mode = 'volume'
		if (state === 'Off' || state === 'Unknown') controller.queryPower = async () => state
		else
			controller.queryVolume = async () => {
				if (state === 'unavailable') throw new Error('Synthetic unavailable volume')
				return state
			}
		await assert.rejects(runAcceptance(controller, options))
		assert.equal(actions.length, 0)
	}
})

test('volume query failure, cancellation, or reconnect after down prevents up or compensating controls', async () => {
	for (const interruption of ['query failure', 'cancel', 'reconnect']) {
		const { controller, options, actions, cancel } = fixture()
		options.mode = 'volume'
		controller.queryVolume = async () => {
			if (actions.length) {
				if (interruption === 'query failure') throw new Error('Synthetic volume response loss')
				if (interruption === 'cancel') cancel.abort()
				else controller.reconnects++
			}
			return 50
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.deepEqual(actions, [{ kind: 'button', button: 'volumeDown' }])
	}
})

test('power pilot checks sleep, wake, and already-awake Wake without app or volume prerequisites', async () => {
	const { controller, options, actions, pauses } = fixture()
	options.mode = 'power'
	options.appName = ''
	controller.listApps = async () => assert.fail('Power pilot must not require an app')
	controller.queryVolume = async () => assert.fail('Power pilot must not require volume support')
	await runAcceptance(controller, options)
	assert.deepEqual(actions, [
		{ kind: 'power', state: 'Off' },
		{ kind: 'power', state: 'On' },
		{ kind: 'power', state: 'On' },
	])
	assert.deepEqual(pauses, [5000, 5000, 5000])
})

test('configured Sleep wait blocks Wake until it finishes and leaves other pauses unchanged', async () => {
	const { controller, options, actions, pauses } = fixture()
	options.mode = 'power'
	options.sleepSeconds = 20
	const waiting = Promise.withResolvers()
	const release = Promise.withResolvers()
	options.pause = async (ms) => {
		pauses.push(ms)
		if (pauses.length === 1) {
			waiting.resolve(ms)
			await release.promise
		}
	}
	const pending = runAcceptance(controller, options)
	assert.equal(await waiting.promise, 20000)
	assert.deepEqual(actions, [{ kind: 'power', state: 'Off' }])
	release.resolve(undefined)
	await pending
	assert.deepEqual(pauses, [20000, 5000, 5000])
	assert.deepEqual(actions, [
		{ kind: 'power', state: 'Off' },
		{ kind: 'power', state: 'On' },
		{ kind: 'power', state: 'On' },
	])
})

test('invalid Sleep waits or modes fail before querying or controlling the TV', async () => {
	for (const [mode, seconds] of [
		...[-1, 0, 4, 31, 20.5, NaN, Infinity].map((seconds) => ['power', seconds]),
		['wake', 20],
		['close-app', 20],
		['volume', 20],
	]) {
		const { controller, options, actions } = fixture()
		options.mode = mode
		options.sleepSeconds = seconds
		controller.queryPower = async () => assert.fail('Invalid wait must fail before a query')
		controller.listApps = async () => assert.fail('Invalid wait must fail before discovery')
		await assert.rejects(runAcceptance(controller, options), RangeError)
		assert.equal(actions.length, 0)
	}
})

test('cancellation or connection loss during the longer Sleep wait prevents Wake', async () => {
	for (const interruption of ['cancel', 'disconnect', 'reconnect']) {
		const { controller, options, actions, cancel } = fixture()
		options.mode = 'power'
		options.sleepSeconds = 20
		options.pause = async () => {
			if (interruption === 'cancel') cancel.abort()
			else if (interruption === 'disconnect') controller.state = 'reconnecting'
			else controller.reconnects++
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.deepEqual(actions, [{ kind: 'power', state: 'Off' }])
	}
})

test('CLI validates Sleep wait without credential access or a connection', () => {
	for (const [mode, seconds, status] of [
		['power', '20', 0],
		['power', 'NaN', 1],
		['power', '31', 1],
		['wake', '20', 1],
	]) {
		const result = spawnSync(
			process.execPath,
			[
				'dist/prototype/acceptance-live.js',
				'--mode',
				mode,
				'--sleep-seconds',
				seconds,
				'--credentials',
				'/nonexistent/preview-only.json',
			],
			{ encoding: 'utf8', timeout: 2000 },
		)
		assert.equal(result.status, status, result.stderr)
		if (status === 0) assert.equal(JSON.parse(result.stdout).mode, 'offline preview')
		else assert.equal(result.stdout, '')
	}
})

test('wake-only pilot starts from Off and checks already-On Wake without sending Sleep or other controls', async () => {
	const { controller, options, actions, events, pauses } = fixture('Off')
	options.mode = 'wake'
	options.appName = ''
	controller.listApps = async () => assert.fail('Wake pilot must not require an app')
	controller.queryVolume = async () => assert.fail('Wake pilot must not require volume support')
	await runAcceptance(controller, options)
	assert.deepEqual(actions, [
		{ kind: 'power', state: 'On' },
		{ kind: 'power', state: 'On' },
	])
	assert.deepEqual(pauses, [5000, 5000])
	assert.deepEqual(
		events.filter((event) => event.stage === 'initial power').map((event) => event.result),
		['Off'],
	)
})

test('wake-only preflight rejects On, Unknown, failed queries, cancellation, and reconnect without a control', async () => {
	for (const state of ['On', 'Unknown', 'query failure', 'cancel', 'reconnect']) {
		const { controller, options, actions, cancel } = fixture('Off')
		options.mode = 'wake'
		controller.queryPower = async () => {
			if (state === 'query failure') throw new Error('Synthetic status failure')
			if (state === 'cancel') cancel.abort()
			if (state === 'reconnect') controller.reconnects++
			return state === 'On' || state === 'Unknown' ? state : 'Off'
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.equal(actions.length, 0)
	}
})

test('failed wake-only observation stops after one Wake without a retry or second check', async () => {
	for (const result of ['Off', 'Unknown', 'query failure']) {
		const { controller, options, actions } = fixture('Off')
		options.mode = 'wake'
		controller.queryPower = async () => {
			if (!actions.length) return 'Off'
			if (result === 'query failure') throw new Error('Synthetic status failure')
			return result
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.deepEqual(actions, [{ kind: 'power', state: 'On' }])
	}
})

test('unconfirmed wake stops without a repeated Wake or extra Home recovery', async () => {
	for (const observed of ['Off', 'Unknown']) {
		const { controller, options, actions, events } = fixture()
		options.mode = 'power'
		controller.queryPower = async () => {
			const last = actions.at(-1)
			return last?.state === 'On' ? observed : (last?.state ?? 'On')
		}
		await assert.rejects(runAcceptance(controller, options), /Power did not report On/)
		assert.deepEqual(actions, [
			{ kind: 'power', state: 'Off' },
			{ kind: 'power', state: 'On' },
		])
		assert.equal(events.filter((event) => event.expected === 'On').length, 10)
	}
})

test('cancellation or reconnect during wake confirmation prevents the already-awake check', async () => {
	for (const interruption of ['cancel', 'reconnect']) {
		const { controller, options, actions, cancel } = fixture()
		options.mode = 'power'
		controller.queryPower = async () => {
			const last = actions.at(-1)
			if (last?.state === 'On') {
				if (interruption === 'cancel') cancel.abort()
				else controller.reconnects++
			}
			return last?.state ?? 'On'
		}
		await assert.rejects(runAcceptance(controller, options))
		assert.equal(actions.length, 2)
	}
})

test('uncertain wake delivery stops without retry or Home compensation', async () => {
	const { controller, options, actions } = fixture()
	options.mode = 'power'
	const perform = controller.perform
	controller.perform = async (action) => {
		await perform(action)
		if (action.state === 'On') throw new Error('Synthetic wake response loss')
	}
	await assert.rejects(runAcceptance(controller, options), /Synthetic wake response loss/)
	assert.equal(actions.length, 2)
})

for (const mode of ['power', 'wake', 'volume'])
	test(`${mode} CLI previews offline with no app or credentials`, () => {
		const result = spawnSync(
			process.execPath,
			[
				'dist/prototype/acceptance-live.js',
				'--mode',
				mode,
				'--app',
				'',
				'--credentials',
				'/nonexistent/preview-only.json',
			],
			{ encoding: 'utf8', timeout: 2000 },
		)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(JSON.parse(result.stdout).mode, 'offline preview')
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

test('a wake acknowledgement without reported On retains every poll and never triggers another wake', async () => {
	const { controller, options, actions, events } = fixture()
	controller.queryPower = async () => {
		const lastPower = actions.filter((action) => action.kind === 'power').at(-1)
		return lastPower?.state === 'On' ? 'Unknown' : (lastPower?.state ?? 'On')
	}
	await assert.rejects(runAcceptance(controller, options), /Power did not report On/)
	assert.equal(actions.filter((action) => action.kind === 'power' && action.state === 'On').length, 1)
	const polls = events.filter((event) => event.stage === 'power report' && event.expected === 'On')
	assert.equal(polls.length, 10)
	assert.ok(polls.every((event, index) => event.result === 'Unknown' && event.attempt === index + 1))
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
