// Real encrypted transport, synthetic peer only; no real device data or keys.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { CompanionPairSetup } from 'node-appletv-remote'
import { NodeController } from '../../dist/prototype/controller.js'

const target = { address: '127.0.0.1', companionPort: Number(process.argv[2]) }
const pair = new CompanionPairSetup(target.address, target.companionPort)
let credentials
try {
	await pair.start()
	credentials = await pair.finish(process.argv[3])
} finally {
	pair.destroy()
}
const controller = new NodeController('synthetic', credentials, {
	discover: async () => target,
	reconnectDelayMs: 10,
	healthIntervalMs: 500,
})
controller.start()
try {
	await controller.waitUntilReady(5000)
	// The peer records this down event and closes TCP before acknowledging it.
	await assert.rejects(controller.perform({ kind: 'button', button: 'right' }))
	const deadline = Date.now() + 5000
	while (controller.reconnects < 1) {
		if (Date.now() > deadline) throw new Error('Reconnect did not finish')
		await delay(5)
	}
	await controller.perform({ kind: 'button', button: 'left' })
	assert.equal(controller.state, 'ready')
} finally {
	await controller.stop()
}
assert.equal(controller.state, 'stopped')
console.log('Independent pyatv peer: TCP loss, reconnect, no action replay and new input passed.')
