// Public synthetic peer only. Real PINs are never command-line arguments.
import assert from 'node:assert/strict'
import { CompanionPairSetup } from 'node-appletv-remote'

const pair = new CompanionPairSetup('127.0.0.1', Number(process.argv[2]))
try {
	await pair.start()
	await assert.rejects(pair.finish(process.argv[3]), /M6 signature verification failed/)
	await assert.rejects(pair.finish(process.argv[3]), /start\(\) must be called/)
} finally {
	pair.destroy()
}
console.log('Independent pyatv peer: invalid M6 signature rejected; no credentials returned.')
