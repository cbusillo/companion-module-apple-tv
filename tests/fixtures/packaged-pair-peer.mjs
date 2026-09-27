// Real bundled pairing against a loopback-only pyatv peer with synthetic keys.
// Discovery and the later dual-protocol connection are separate test boundaries.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { default: AppleTV } = await import(pathToFileURL(resolve(process.argv[2])))
const port = Number(process.argv[3])
const mode = process.argv[5]
const values = {},
	states = [],
	saves = []
const config = { enabled: true, deviceId: 'synthetic-tv' }
let controllers = 0
const context = {
	_isInstanceContext: true,
	id: 'bundle-wire-test',
	label: 'Bundle wire test',
	setVariableDefinitions() {},
	setActionDefinitions() {},
	setVariableValues(update) {
		Object.assign(values, update)
	},
	updateStatus(status, message) {
		states.push({ status, message })
	},
	saveConfig(config, secrets) {
		saves.push(structuredClone({ config, secrets }))
	},
}
const module = new AppleTV(context, {
	discover: async () => [
		{
			deviceId: config.deviceId,
			name: 'Synthetic TV',
			model: 'AppleTV14,1',
			address: '127.0.0.1',
			port: 1,
			companionPort: port,
		},
	],
	controller: () => {
		controllers++
		return {
			state: 'ready',
			feedback: {},
			nowPlaying: { state: 'Unknown' },
			start() {},
			async waitUntilReady() {},
			async stop() {},
			observe() {
				return () => {}
			},
			async listApps() {
				return []
			},
			async perform() {
				throw new Error('No controls allowed')
			},
		}
	},
})
async function waitFor(terminal) {
	for (let i = 0; i < 300; i++) {
		if (terminal.includes(values.connection)) return
		await delay(50)
	}
	throw new Error(`Setup did not settle: ${JSON.stringify(states)}`)
}
try {
	await module.init({ ...config, pair: true }, true, {})
	if (mode === 'closed') {
		await waitFor(['error'])
		assert.match(states.at(-1).message, /closed the pairing session/)
	} else {
		await waitFor(['pin', 'error'])
		assert.equal(values.connection, 'pin', JSON.stringify(states))
		await module.configUpdated(config, { pin: process.argv[4] })
		await waitFor(['ready', 'error'])
		if (mode === 'success') {
			assert.equal(values.connection, 'ready', JSON.stringify(states))
			assert.ok(saves.at(-1).secrets.pairing)
			assert.equal(controllers, 1)
		} else {
			assert.equal(mode, 'invalid-identity')
			assert.equal(values.connection, 'error')
			assert.match(states.at(-1).message, /identity verification failed/)
		}
	}
	if (mode !== 'success') {
		assert.ok(saves.every((save) => !save.secrets.pairing))
		assert.equal(controllers, 0)
	}
	assert.ok(saves.every((save) => !Object.hasOwn(save.secrets, 'pin')))
	console.log(`Packaged pyatv pairing: ${mode} passed`)
} finally {
	await module.destroy()
}
