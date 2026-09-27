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
	})
}
console.log('Independent pyatv peer: pairing, two encrypted sessions, app discovery and teardown passed.')
