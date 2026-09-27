import assert from 'node:assert/strict'
import test from 'node:test'
import { PlaybackClock } from '../dist/playback.js'
import { MetadataState } from '../dist/prototype/metadata.js'
import { displayValues } from '../dist/display.js'
const playing = {
	state: 'Playing',
	app: 'synthetic.app',
	itemId: 'one',
	title: 'Track',
	reportedPosition: 10,
	duration: 60,
	playbackRate: 1,
}
function fixture() {
	let mono = 0,
		wall = 1000000
	return {
		clock: new PlaybackClock(
			() => mono,
			() => wall,
		),
		step: (n) => {
			mono += n
			wall += n
		},
		wall: (n) => {
			wall = n
		},
	}
}

test('playing time advances monotonically, accounts for reported timestamp age, and clamps at duration', () => {
	const f = fixture()
	f.clock.observe({ ...playing, positionTimestamp: 998 })
	assert.equal(f.clock.value(), 12)
	f.step(3000)
	assert.equal(f.clock.value(), 15)
	f.wall(6000000)
	assert.equal(f.clock.value(), 15)
	f.step(90000)
	assert.equal(f.clock.value(), 60)
})
test('pause, resume, repeated metadata and seek preserve the correct position', () => {
	const f = fixture()
	f.clock.observe(playing)
	f.step(2000)
	f.clock.observe({ ...playing, artist: 'New artist' })
	assert.equal(f.clock.value(), 12)
	f.clock.observe({ ...playing, state: 'Paused' })
	f.step(10000)
	assert.equal(f.clock.value(), 12)
	f.clock.observe(playing)
	f.step(3000)
	assert.equal(f.clock.value(), 15)
	f.clock.observe({ ...playing, reportedPosition: 5 })
	assert.equal(f.clock.value(), 5)
})
test('missing position, metadata loss and a new item do not inherit an old playback clock', () => {
	const f = fixture()
	f.clock.observe(playing)
	f.step(1000)
	f.clock.observe({ ...playing, itemId: 'two', reportedPosition: undefined })
	assert.equal(f.clock.value(), undefined)
	f.clock.observe({ ...playing, itemId: 'two', reportedPosition: 0 })
	assert.equal(f.clock.value(), 0)
	f.clock.observe({ state: 'Unknown' })
	f.step(10000)
	assert.equal(f.clock.value(), undefined)
	assert.equal(displayValues({ position: '', duration: '' }).elapsed, undefined)
})
test('zero or unreported rate does not invent progress; valid non-unit rates scale elapsed time', () => {
	for (const rate of [undefined, 0, NaN, Infinity, -1]) {
		const f = fixture()
		f.clock.observe({ ...playing, playbackRate: rate })
		f.step(5000)
		assert.equal(f.clock.value(), 10)
	}
	const f = fixture()
	f.clock.observe({ ...playing, playbackRate: 2 })
	f.step(3000)
	assert.equal(f.clock.value(), 16)
})
test('the metadata reducer retains explicit Cocoa timestamp and rate without treating defaults as observations', () => {
	const state = new MetadataState()
	state.setConnected()
	const path = { client: { bundleIdentifier: 'synthetic.app' }, player: { identifier: 'player' } }
	state.receive({ type: 46, '.setNowPlayingClientMessage': { client: path.client } })
	state.receive({ type: 47, '.setNowPlayingPlayerMessage': { playerPath: path } })
	state.receive({
		type: 4,
		'.setStateMessage': {
			playerPath: path,
			playbackState: 1,
			playbackQueue: {
				location: 0,
				contentItems: [
					{ identifier: 'item', metadata: { elapsedTime: 12, elapsedTimeTimestamp: 800000000, playbackRate: 1 } },
				],
			},
		},
	})
	assert.equal(state.snapshot().nowPlaying.positionTimestamp, 1778307200)
	assert.equal(state.snapshot().nowPlaying.playbackRate, 1)
	state.receive({
		type: 4,
		'.setStateMessage': {
			playerPath: path,
			playbackQueue: {
				location: 0,
				contentItems: [
					{
						identifier: 'other',
						metadata: Object.create({ elapsedTime: 0, elapsedTimeTimestamp: 0, playbackRate: 1 }),
					},
				],
			},
		},
	})
	assert.equal(state.snapshot().nowPlaying.reportedPosition, undefined)
	assert.equal(state.snapshot().nowPlaying.playbackRate, undefined)
})

test('changing the selected player resets a matching item to its own report', () => {
	const f = fixture()
	f.clock.observe({ ...playing, playerId: 'one' })
	f.step(5000)
	f.clock.observe({ ...playing, playerId: 'two' })
	assert.equal(f.clock.value(), 10)
})

test('an elapsed-time update without a new timestamp cannot reuse the previous timestamp', () => {
	const state = new MetadataState()
	state.setConnected()
	const path = { client: { bundleIdentifier: 'synthetic.app' }, player: { identifier: 'player' } }
	state.receive({ type: 46, '.setNowPlayingClientMessage': { client: path.client } })
	state.receive({ type: 47, '.setNowPlayingPlayerMessage': { playerPath: path } })
	state.receive({
		type: 4,
		'.setStateMessage': {
			playerPath: path,
			playbackState: 1,
			playbackQueue: {
				location: 0,
				contentItems: [
					{ identifier: 'item', metadata: { elapsedTime: 12, elapsedTimeTimestamp: 800000000, playbackRate: 1 } },
				],
			},
		},
	})
	state.receive({
		type: 56,
		'.updateContentItemMessage': {
			playerPath: path,
			contentItems: [{ identifier: 'item', metadata: { elapsedTime: 5 } }],
		},
	})
	assert.equal(state.snapshot().nowPlaying.reportedPosition, 5)
	assert.equal(state.snapshot().nowPlaying.positionTimestamp, undefined)
})
