import test from 'node:test'
import assert from 'node:assert/strict'
import { displayValues, timeText } from '../dist/display.js'

test('long playback durations remain readable', () => {
	assert.equal(timeText(3661), '1:01:01')
	assert.equal(timeText(61), '1:01')
	const result = displayValues({ position: '1854', duration: '5639' })
	assert.equal(result.elapsed, '30:54')
	assert.equal(result.remaining, '1:03:05')
})
test('live and completed playback never show negative remaining time', () => {
	assert.equal(displayValues({ position: '100', duration: '0' }).remaining, '')
	const result = displayValues({ position: '101', duration: '100' })
	assert.equal(result.remaining, '0:00')
	assert.equal(result.progress, '100')
})
test('partial status retains existing metadata and filters unknown fields', () => {
	assert.deepEqual(displayValues({ metadata_state: 'Stale', credentials: 'private' }), { metadata_state: 'Stale' })
})
