import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanionPrototype, UnsupportedCommand } from '../dist/prototype/companion.js'
import { CommandQueue, CommandNotSent } from '../dist/prototype/queue.js'

const reply = (entries = []) =>
	new Map([
		['_t', 3],
		['_c', new Map(entries)],
	])
const event = (identifier, entries) => ({
	identifier,
	data: new Map([
		['_t', 1],
		['_c', new Map(entries)],
	]),
})

function fixture() {
	let time = 0n
	let volume = 0.4
	let power = 3
	const requests = []
	const events = []
	const pauses = []
	const client = {
		async sendCompanionRequest(id, envelope) {
			const content = envelope.get('_c')
			requests.push({ id, content, time })
			if (id === 'FetchAttentionState') return reply([['state', power]])
			if (id === '_mcc' && content.get('_mcc') === 5) return reply([['_vol', volume]])
			if (id === '_mcc' && content.get('_mcc') === 6) volume = content.get('_vol').value
			return reply()
		},
		sendCompanionMessage(id, envelope) {
			events.push({ id, content: envelope.get('_c'), time })
		},
	}
	const controls = new CompanionPrototype(client, {
		now: () => time,
		pause: async (ms) => {
			pauses.push(ms)
			time += BigInt(Math.round(ms * 1e6))
		},
	})
	return {
		controls,
		client,
		requests,
		events,
		pauses,
		advance: (ms) => {
			time += BigInt(ms) * 1000000n
		},
		setPower: (value) => {
			power = value
		},
		setVolume: (value) => {
			volume = value
		},
		getVolume: () => volume,
	}
}

test('remote buttons send one down/up pair, including direct Control Center and play/pause', async () => {
	const { controls, requests } = fixture()
	for (const [button, code] of [
		['up', 1],
		['down', 2],
		['left', 3],
		['right', 4],
		['back', 5],
		['select', 6],
		['home', 7],
		['volumeUp', 8],
		['volumeDown', 9],
		['screensaver', 11],
		['playPause', 14],
		['controlCenter', 19],
	]) {
		requests.length = 0
		await controls.press(button)
		assert.deepEqual(
			requests.map(({ id, content }) => [id, content.get('_hBtS'), content.get('_hidC')]),
			[
				['_hidC', 1, code],
				['_hidC', 2, code],
			],
		)
	}
})

test('Home hold and App Switcher retain distinct hold and double-tap gestures', async () => {
	const { controls, requests, pauses } = fixture()
	await controls.press('homeHold')
	assert.deepEqual(pauses, [1000])
	assert.equal(requests[1].time - requests[0].time, 1000000000n)
	requests.length = 0
	await controls.press('appSwitcher')
	assert.deepEqual(
		requests.map(({ content }) => [content.get('_hBtS'), content.get('_hidC')]),
		[
			[1, 7],
			[2, 7],
			[1, 7],
			[2, 7],
		],
	)
})

test('a failed down request gets one release attempt and no repeated down', async () => {
	const { controls, client, requests } = fixture()
	const original = client.sendCompanionRequest
	client.sendCompanionRequest = async (id, body) => {
		const response = await original(id, body)
		if (body.get('_c').get('_hBtS') === 1) throw new Error('down response lost')
		return response
	}
	await assert.rejects(controls.press('select'), /down response lost/)
	assert.deepEqual(
		requests.map(({ content }) => content.get('_hBtS')),
		[1, 2],
	)
})

test('a rejected release cannot hide uncertain delivery of the initial button down', async () => {
	const { controls, client, requests } = fixture()
	const original = client.sendCompanionRequest
	const failure = new Error('down response lost')
	client.sendCompanionRequest = async (id, body) => {
		await original(id, body)
		if (body.get('_c').get('_hBtS') === 1) throw failure
		return new Map([['_ec', 58822]])
	}
	await assert.rejects(controls.press('select'), (error) => error === failure)
	assert.deepEqual(
		requests.map(({ content }) => content.get('_hBtS')),
		[1, 2],
	)
})

test('media commands use Companion codes and obey updated capabilities', async () => {
	const { controls, requests } = fixture()
	for (const command of ['play', 'pause', 'next', 'previous']) await controls.media(command)
	assert.deepEqual(
		requests.map(({ content }) => content.get('_mcc')),
		[1, 2, 3, 4],
	)
	controls.receiveEvent(event('_iMC', [['_mcF', 0]]))
	requests.length = 0
	await assert.rejects(controls.media('play'), UnsupportedCommand)
	await assert.rejects(controls.seek(10), UnsupportedCommand)
	await assert.rejects(controls.setVolume(25), UnsupportedCommand)
	assert.equal(requests.length, 0)
	controls.receiveEvent(event('_iMC', [['_mcF', 0x200]]))
	await controls.seek(10)
	await assert.rejects(controls.seek(-10), UnsupportedCommand)
})

test('power toggles use an actual query and never guess from Unknown', async () => {
	const { controls, requests, setPower } = fixture()
	await controls.togglePower()
	assert.equal(requests.at(-1).content.get('_hidC'), 12)
	assert.equal(requests.at(-1).content.get('_hBtS'), 2)
	assert.equal(controls.state.power, 'Unknown')
	setPower(1)
	await controls.togglePower()
	assert.equal(requests.at(-1).content.get('_hidC'), 13)
	setPower(99)
	requests.length = 0
	await assert.rejects(controls.togglePower(), /Unknown power state/)
	assert.deepEqual(
		requests.map(({ id }) => id),
		['FetchAttentionState'],
	)
})

test('explicit sleep and wake preserve their requested direction regardless of cached power', async () => {
	const { controls, requests } = fixture()
	controls.receiveEvent(event('SystemStatus', [['state', 3]]))
	await controls.setPower('On')
	controls.receiveEvent(event('SystemStatus', [['state', 1]]))
	await controls.setPower('Off')
	assert.deepEqual(
		requests.map(({ id, content }) => [id, content.get('_hidC'), content.get('_hBtS')]),
		[
			['_hidC', 13, 2],
			['_hidC', 12, 2],
		],
	)
	await assert.rejects(controls.setPower('Unknown'), RangeError)
	assert.equal(requests.length, 2)
})

test('fresh pushed power can replace an unsupported query, but expires and accepts Unknown', async () => {
	const { controls, client, advance } = fixture()
	client.sendCompanionRequest = async () => new Map([['_ec', 58822]])
	controls.receiveEvent(event('TVSystemStatus', [['state', 3]]))
	assert.equal(await controls.readPower(), 'On')
	advance(31000)
	assert.equal(await controls.readPower(), 'Unknown')
	controls.receiveEvent(event('SystemStatus', [['state', 1]]))
	assert.equal(await controls.readPower(), 'Off')
	controls.receiveEvent(event('SystemStatus', [['state', 'invalid']]))
	assert.equal(await controls.readPower(), 'Unknown')
})

test('late power query results cannot overwrite a newer pushed state', async () => {
	const { controls, client } = fixture()
	const deferred = Promise.withResolvers()
	client.sendCompanionRequest = async () => deferred.promise
	const pending = controls.readPower()
	controls.receiveEvent(event('SystemStatus', [['state', 1]]))
	deferred.resolve(reply([['state', 3]]))
	assert.equal(await pending, 'Off')
})

test('all cardinal swipes use bounded coordinates, monotonic timestamps, and one release', async () => {
	for (const [direction, start, end] of [
		['up', [500, 900], [500, 100]],
		['down', [500, 100], [500, 900]],
		['left', [900, 500], [100, 500]],
		['right', [100, 500], [900, 500]],
	]) {
		const { controls, requests, events } = fixture()
		await controls.swipe(direction)
		const touches = events.filter(({ id }) => id === '_hidT').map(({ content }) => content)
		assert.deepEqual([touches[0].get('_cx'), touches[0].get('_cy')], start)
		assert.deepEqual([touches.at(-1).get('_cx'), touches.at(-1).get('_cy')], end)
		assert.equal(touches[0].get('_tPh'), 1)
		assert.equal(touches.filter((content) => content.get('_tPh') === 4).length, 1)
		assert.ok(touches.at(-1).get('_ns') >= 100000000n)
		assert.ok(touches.at(-1).get('_ns') < 120000000n)
		assert.ok(touches.every((content, index) => index === 0 || content.get('_ns') >= touches[index - 1].get('_ns')))
		await controls.stopTouch()
		assert.deepEqual(
			requests.map(({ id }) => id),
			['_touchStart', '_touchStop'],
		)
	}
})

test('mute requires known output and never invents a restore volume', async () => {
	const { controls, requests, setVolume } = fixture()
	await assert.rejects(controls.toggleMute(), /output identity/)
	assert.equal(requests.length, 0)
	controls.observeOutput(['synthetic-output'])
	setVolume(0)
	await assert.rejects(controls.toggleMute(), /No saved volume/)
	assert.equal(requests.filter(({ id, content }) => id === '_mcc' && content.get('_mcc') === 6).length, 0)
})

test('mute restores only its captured output and is forgotten after external volume or disconnect', async () => {
	const { controls, getVolume, setVolume } = fixture()
	controls.observeOutput(['speaker-a'])
	await controls.toggleMute()
	assert.equal(getVolume(), 0)
	assert.equal(controls.state.mute, 'Muted')
	await controls.toggleMute()
	assert.equal(getVolume(), 0.4)
	await controls.toggleMute()
	controls.observeOutput(['speaker-b'])
	await assert.rejects(controls.toggleMute(), /No saved volume/)
	setVolume(0.2)
	await controls.toggleMute()
	setVolume(0.3)
	await controls.readVolume()
	assert.notEqual(controls.state.mute, 'Muted')
	controls.invalidate()
	assert.equal(controls.state.mute, 'Unavailable')
	assert.equal(controls.active, false)
})

test('changing output while the mute request is pending cannot arm restoration on the new output', async () => {
	const { controls, client } = fixture()
	const original = client.sendCompanionRequest
	client.sendCompanionRequest = async (id, body) => {
		const value = await original(id, body)
		if (id === '_mcc' && body.get('_c').get('_mcc') === 6) controls.observeOutput(['speaker-b'])
		return value
	}
	controls.observeOutput(['speaker-a'])
	await controls.toggleMute()
	assert.notEqual(controls.state.mute, 'Muted')
	await assert.rejects(controls.toggleMute(), /No saved volume/)
})

test('queue keeps complete gestures together and expires stale input before dispatch', async () => {
	let clock = 0
	const queue = new CommandQueue(() => clock)
	const held = Promise.withResolvers()
	const log = []
	const first = queue.run(async () => {
		log.push('down')
		await held.promise
		log.push('up')
	})
	const second = queue.run(async () => {
		log.push('late')
	})
	const rejected = assert.rejects(second, /expired/)
	await Promise.resolve()
	clock = 501
	held.resolve(undefined)
	await first
	await rejected
	assert.deepEqual(log, ['down', 'up'])
})

test('queue capacity is bounded and an invalidated queue cannot replay into another session', async () => {
	const queue = new CommandQueue()
	const held = Promise.withResolvers()
	const first = queue.run(async () => held.promise)
	await Promise.resolve()
	const queued = Array.from({ length: 7 }, () => queue.run(async () => assert.fail('must not dispatch')))
	const rejections = queued.map((pending) => assert.rejects(pending, /Session changed/))
	await assert.rejects(
		queue.run(async () => assert.fail('must not dispatch')),
		CommandNotSent,
	)
	queue.invalidate()
	held.resolve(undefined)
	await first
	await Promise.all(rejections)
})
