import { encodePairing } from '../../dist/node-credentials.js'
export const config = { enabled: true, deviceId: 'synthetic-tv' }
export const credentials = {
	clientId: 'synthetic-client',
	serverId: 'synthetic-server',
	clientLTSK: Buffer.alloc(32, 1),
	clientLTPK: Buffer.alloc(32, 2),
	serverLTPK: Buffer.alloc(32, 3),
}
export const saved = (deviceId = config.deviceId) => ({ pairing: encodePairing(deviceId, credentials) })
export const device = (deviceId = config.deviceId) => ({
	deviceId,
	name: 'Synthetic TV',
	model: 'AppleTV14,1',
	address: '127.0.0.1',
	port: 1,
	companionPort: 2,
})
export const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
export class SetupController {
	state = 'stopped'
	feedback = { power: 'On', volume: 35, mute: 'Unmuted' }
	nowPlaying = {
		state: 'Playing',
		app: 'synthetic.app',
		title: 'Synthetic title',
		reportedPosition: 12,
		duration: 180,
		playbackRate: 1,
		itemId: 'track-1',
	}
	listeners = new Set()
	actions = []
	starts = 0
	stops = 0
	verification = 0
	start() {
		this.starts++
		this.state = 'ready'
		this.changed()
	}
	async waitUntilReady() {
		this.verification++
	}
	async stop() {
		this.stops++
		this.state = 'stopped'
		this.changed()
	}
	observe(listener) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	changed() {
		for (const listener of this.listeners) listener()
	}
	async perform(action) {
		this.actions.push(action)
	}
	async listApps() {
		return [{ id: 'synthetic.app', name: 'Synthetic player' }]
	}
}
export function setupFixture(overrides = {}) {
	const saves = [],
		states = [],
		pairs = [],
		controllers = [],
		controllerIds = [],
		values = {},
		appLists = [],
		scans = []
	const hooks = {
		save: (config, secrets) => saves.push({ config: structuredClone(config), secrets: structuredClone(secrets) }),
		status: (state, message) => states.push({ state, message }),
		values: (update) => Object.assign(values, update),
		apps: (apps) => appLists.push(apps),
	}
	const options = {
		discover: async (options) => {
			scans.push(options)
			return [device()]
		},
		pairing: (target) => {
			const closure = Promise.withResolvers()
			const pair = {
				closed: closure.promise,
				stage: 'proof',
				target,
				starts: 0,
				finishes: [],
				destroys: 0,
				signal: undefined,
				async start({ signal }) {
					this.signal = signal
					this.starts++
				},
				async finish(pin) {
					this.finishes.push(pin)
					return credentials
				},
				destroy() {
					this.destroys++
					closure.resolve()
				},
			}
			pairs.push(pair)
			return pair
		},
		controller: (id) => {
			const controller = new SetupController()
			controllers.push(controller)
			controllerIds.push(id)
			return controller
		},
		...overrides,
	}
	return { hooks, options, saves, states, pairs, controllers, controllerIds, values, appLists, scans }
}
