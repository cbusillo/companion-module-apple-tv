import test from 'node:test'
import assert from 'node:assert/strict'
import { displayValues, timeText, VolumeText } from '../dist/display.js'

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
test('volume shows whole percent', () => {
	const text = new VolumeText()
	assert.equal(text.value(37.25, 'airpods', 1, 0), '37')
	assert.equal(text.value(37.5, 'airpods', 1, 0), '38')
	assert.equal(text.value(null, undefined, 1, 0), '')
})
test('a pending volume change keeps the last level only for the same output and briefly', () => {
	const text = new VolumeText(5000)
	assert.equal(text.value(40, 'airpods', 1, 0), '40')
	assert.equal(text.value(null, 'airpods', 1, 1000), '40')
	assert.equal(text.value(42, 'airpods', 1, 1500), '42')
	assert.equal(text.value(null, 'airpods', 1, 7000), '')
	text.value(40, 'airpods', 1, 0)
	assert.equal(text.value(null, 'speakers', 1, 100), '')
	text.value(40, 'airpods', 1, 0)
	assert.equal(text.value(null, 'airpods', 2, 100), '')
	text.value(40, 'airpods', 1, 0)
	assert.equal(text.value(null, undefined, 1, 100), '')
})
