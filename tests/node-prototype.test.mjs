import test from 'node:test'
import assert from 'node:assert/strict'
import { opackEncode, opackDecode, CompanionSession, CompanionConnection, FrameType } from 'node-appletv-remote'
import { CompanionPrototype } from '../dist/prototype/companion.js'

function fixture(reply = new Map()) {
	const requests = []
	const prototype = new CompanionPrototype({
		async sendCompanionRequest(identifier, envelope, timeout) {
			const bytes = opackEncode(envelope)
			requests.push({ identifier, bytes, envelope: opackDecode(bytes), timeout })
			if (reply instanceof Error) throw reply
			return new Map([
				['_t', 3],
				['_c', reply],
			])
		},
	})
	return { prototype, requests }
}

test('app discovery decodes an independently generated compressed device reply', async () => {
	// Generated with the locked pyatv codec, not with the Node encoder being tested.
	const packet = Buffer.from(
		'e2425f740b425f63e24f636f6d2e6578616d706c652e6f6e654b4578616d706c65204170704f636f6d2e6578616d706c652e74776fa3',
		'hex',
	)
	const { prototype, requests } = fixture(opackDecode(packet).get('_c'))
	assert.deepEqual(await prototype.listApps(), [
		{ id: 'com.example.one', name: 'Example App' },
		{ id: 'com.example.two', name: 'Example App' },
	])
	assert.equal(requests[0].identifier, 'FetchLaunchableApplicationsEvent')
	assert.equal(requests[0].envelope.get('_t'), 2)
})

test('app launching uses a nested Companion request through the public API', async () => {
	const { prototype, requests } = fixture()
	await prototype.launchApp('com.example.player')
	assert.deepEqual(
		requests.map(({ identifier, envelope }) => [identifier, envelope]),
		[
			[
				'_launchApp',
				new Map([
					['_t', 2],
					['_c', new Map([['_bundleID', 'com.example.player']])],
				]),
			],
		],
	)
})

for (const seconds of [-30, -10, 10, 30]) {
	test(`seeking ${seconds} seconds preserves a floating-point wire value`, async () => {
		const { prototype, requests } = fixture()
		await prototype.seek(seconds)
		const request = requests[0]
		const expected = Buffer.alloc(9)
		expected[0] = 0x36 // Published OPACK float64 tag.
		expected.writeDoubleLE(seconds, 1)
		assert.ok(request.bytes.subarray(-9).equals(expected))
		assert.equal(request.identifier, '_mcc')
		assert.equal(request.envelope.get('_c').get('_mcc'), 7)
		assert.equal(request.envelope.get('_c').get('_skpS'), seconds)
	})
}

test('volume read/write preserves the zero and full-volume floating-point endpoints', async () => {
	const { prototype, requests } = fixture(new Map([['_vol', 0.42]]))
	assert.equal(await prototype.readVolume(), 42)
	for (const percent of [0, 42, 100]) {
		await prototype.setVolume(percent)
		const request = requests.at(-1)
		assert.equal(request.envelope.get('_c').get('_mcc'), 6)
		assert.equal(request.envelope.get('_c').get('_vol'), percent / 100)
		assert.equal(request.bytes.at(-9), 0x36)
	}
})

test('power feedback uses reported state and preserves unknown values', async () => {
	for (const [state, expected] of [
		[1, 'Off'],
		[2, 'On'],
		[3, 'On'],
		[4, 'On'],
		[0, 'Unknown'],
		[99, 'Unknown'],
	]) {
		const { prototype, requests } = fixture(new Map([['state', state]]))
		assert.equal(await prototype.readPower(), expected)
		assert.deepEqual(
			requests.map((r) => r.identifier),
			['FetchAttentionState'],
		)
	}
})

test('invalid local input is rejected before any request is sent', async () => {
	const { prototype, requests } = fixture()
	for (const seconds of [0, 61, -61, Infinity, NaN]) await assert.rejects(prototype.seek(seconds), RangeError)
	for (const volume of [-1, 101, NaN]) await assert.rejects(prototype.setVolume(volume), RangeError)
	await assert.rejects(prototype.launchApp(' '), RangeError)
	assert.equal(requests.length, 0)
})

test('a timeout never retries a possibly delivered command', async () => {
	const { prototype, requests } = fixture(new Error('timeout'))
	await assert.rejects(prototype.launchApp('com.example.player'), /timeout/)
	assert.equal(requests.length, 1)
})

test('malformed or rejected replies are not presented as successful controls', async () => {
	for (const reply of [
		new Map([['_em', 'rejected']]),
		new Map([
			['_t', 3],
			['_c', 'invalid'],
		]),
		new Map([
			['_t', 1],
			['_c', new Map()],
		]),
	]) {
		const prototype = new CompanionPrototype({ sendCompanionRequest: async () => reply })
		await assert.rejects(prototype.launchApp('com.example.player'))
	}
	const { prototype } = fixture(new Map([['_vol', 2]]))
	await assert.rejects(prototype.readVolume(), /unavailable/)
})

test('patched npm package interoperates with independently generated encrypted Companion frames', () => {
	// Synthetic pyatv 0.18.0 fixtures, nonce_length=12, key bytes(range(32)), counters 0 and 1.
	const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
	const payload = Buffer.from('e3425f7409425f694c53797374656d537461747573425f63e14573746174650b', 'hex')
	const frames = [
		'08000030fbfa1d45a4a4f9b85f322512db2623748cd0878092ef043f0dbd8f664b4110571c4015ebed81b6c162b40204067f16f7',
		'08000030777d249acda1c3433b08aa80195ab00855d984ad5ebb865e7405842d76d574c49e0fde4f7f681f246d79893979ca6ee5',
	].map((hex) => Buffer.from(hex, 'hex'))
	assert.deepEqual(new CompanionSession(key, key).encrypt(FrameType.E_OPACK, payload), frames[0])
	const connection = new CompanionConnection('unused.invalid', 1, {
		clientId: 'test',
		clientLTSK: key,
		clientLTPK: key,
		serverLTPK: key,
		serverId: 'test',
	})
	// Test-only entry into the authenticated parser; never opens a socket.
	connection.session = new CompanionSession(key, key)
	const states = []
	connection.on('event', ({ data }) => states.push(data.get('_c').get('state')))
	connection.onData(frames[0].subarray(0, 17))
	assert.deepEqual(states, [])
	connection.onData(Buffer.concat([frames[0].subarray(17), frames[1]]))
	assert.deepEqual(states, [3, 1])
})
