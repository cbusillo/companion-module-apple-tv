// Run against the extracted, bundled module with package-only filesystem access.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { default: AppleTV } = await import(pathToFileURL(resolve(process.argv[2], 'main.js')))
const settle = () => new Promise((resolve) => setImmediate(resolve))
const values = {}
const states = []
const saves = []
const controllers = []
let actions
let prompts = 0
const config = { enabled: true, deviceId: 'synthetic-tv' }
const credentials = {
	clientId: 'synthetic-client',
	serverId: 'synthetic-server',
	clientLTSK: Buffer.alloc(32, 1),
	clientLTPK: Buffer.alloc(32, 2),
	serverLTPK: Buffer.alloc(32, 3),
}
const context = {
	_isInstanceContext: true,
	id: 'packaged-smoke',
	label: 'Packaged smoke',
	setVariableDefinitions() {},
	setVariableValues: (update) => Object.assign(values, update),
	setActionDefinitions: (definitions) => {
		actions = definitions
	},
	updateStatus: (status, message) => states.push({ status, message }),
	saveConfig: (config, secrets) => saves.push(structuredClone({ config, secrets })),
}
const options = {
	discover: async () => [
		{
			deviceId: config.deviceId,
			name: 'Synthetic TV',
			model: 'AppleTV14,1',
			address: '127.0.0.1',
			port: 1,
			companionPort: 2,
		},
	],
	pairing: () => ({
		closed: new Promise(() => {}),
		stage: 'proof',
		async start() {
			prompts++
		},
		async finish(pin) {
			assert.equal(pin, '0123')
			return credentials
		},
		destroy() {},
	}),
	controller: () => {
		const controller = {
			state: 'stopped',
			feedback: { power: 'On', volume: 40, mute: 'Unmuted' },
			nowPlaying: { state: 'Playing', title: 'Package test', reportedPosition: 12, duration: 90 },
			listeners: new Set(),
			actions: [],
			start() {
				this.state = 'ready'
				for (const listener of this.listeners) listener()
			},
			async waitUntilReady() {},
			async stop() {
				this.state = 'stopped'
			},
			observe(listener) {
				this.listeners.add(listener)
				return () => this.listeners.delete(listener)
			},
			async listApps() {
				return [{ id: 'synthetic.app', name: 'Player' }]
			},
			async perform(action) {
				this.actions.push(action)
			},
		}
		controllers.push(controller)
		return controller
	},
}

const module = new AppleTV(context, options)
try {
	// This executes the real bundled MRP codec and loads its packaged schemas before discovery.
	await module.init({ enabled: true, deviceId: '' }, true, {})
	await settle()
	assert.equal(values.connection, 'unpaired', JSON.stringify(states))
	assert.ok(
		module
			.getConfigFields()
			.find((field) => field.id === 'deviceId')
			.choices.some((choice) => choice.id === config.deviceId),
	)
	assert.equal(prompts, 0)
	await module.configUpdated({ ...config, pair: true }, {})
	await settle()
	assert.equal(values.connection, 'pin')
	await module.configUpdated(config, { pin: '0123' })
	await settle()
	assert.equal(values.connection, 'ready')
	assert.equal(values.title, 'Package test')
	assert.equal(prompts, 1)
	assert.ok(saves.at(-1).secrets.pairing)
	assert.ok(saves.every((save) => !Object.hasOwn(save.secrets, 'pin') && !Object.hasOwn(save.config, 'pin')))
	await actions.command.callback({ options: { command: 'select' } })
	assert.deepEqual(controllers[0].actions, [{ kind: 'button', button: 'select' }])
} finally {
	await module.destroy()
}
const restarted = new AppleTV(context, options)
try {
	await restarted.init(saves.at(-1).config, false, saves.at(-1).secrets)
	await settle()
	assert.equal(values.connection, 'ready')
	assert.equal(prompts, 1)
} finally {
	await restarted.destroy()
}
assert.ok(controllers.every((controller) => controller.state === 'stopped' && controller.listeners.size === 0))
console.log(
	'Packaged runtime: schema loading, discovery, PIN setup, secret persistence, saved restart and one dispatch passed.',
)
