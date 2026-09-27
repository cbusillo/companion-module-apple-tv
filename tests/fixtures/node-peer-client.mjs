// Public synthetic peer only. Real PINs are never command-line arguments.
import assert from 'node:assert/strict'
import { CompanionPairSetup } from 'node-appletv-remote'
import { withCompanionSession } from '../../dist/prototype/session.js'

const target = { address: '127.0.0.1', companionPort: Number(process.argv[2]) }
const pair = new CompanionPairSetup(target.address, target.companionPort)
let credentials
try {
	await pair.start()
	credentials = await pair.finish(process.argv[3])
} finally {
	pair.destroy()
}
// Prove credentials can establish two fresh encrypted sessions without re-pairing.
for (let i = 0; i < 2; i++) {
	await withCompanionSession(target, credentials, new AbortController().signal, async (commands) => {
		assert.deepEqual(await commands.listApps(), [
			{ id: 'com.example.one', name: 'Player' },
			{ id: 'com.example.two', name: 'Player' },
		])
		assert.equal(await commands.readPower(), 'On')
		if (i === 0) {
			await commands.press('select')
			await commands.press('appSwitcher')
			await commands.press('homeHold')
			await commands.press('controlCenter')
			for (const media of ['play', 'pause', 'next', 'previous']) await commands.media(media)
			for (const seconds of [-30, -10, 10, 30]) await commands.seek(seconds)
			for (const direction of ['up', 'down', 'left', 'right']) await commands.swipe(direction)
			assert.equal(await commands.readVolume(), 40)
			await commands.setVolume(25)
			assert.equal(await commands.readVolume(), 25)
			commands.observeOutput(['synthetic-output'])
			await commands.toggleMute()
			assert.equal(await commands.readVolume(), 0)
			await commands.toggleMute()
			assert.equal(await commands.readVolume(), 25)
			await commands.togglePower()
			assert.equal(await commands.readPower(), 'Off')
			await commands.togglePower()
			assert.equal(await commands.readPower(), 'On')
		}
	})
}
console.log('Independent pyatv peer: pairing, encrypted sessions, controls, events, gestures and teardown passed.')
