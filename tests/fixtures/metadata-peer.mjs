import { EventEmitter } from 'node:events'
import { MRPMessage } from 'node-appletv-remote'

/** Synthetic authenticated-message source; never opens a network connection. */
export class MetadataPeer extends EventEmitter {
	closed = false
	level = 35
	available = true
	requests = []
	/**
	 * How the synthetic TV handles an output-route request:
	 * - apply: acknowledge and change the route at once;
	 * - ignore: acknowledge without changing the route;
	 * - reject: reply with an MRP error;
	 * - late: change the route after routeApplyMs and acknowledge after routeAckMs (a slow takeover);
	 * - never: change the route after routeApplyMs and never acknowledge.
	 */
	routeMode = 'apply'
	routeAckMs = 5000
	routeApplyMs = 0
	routeRequests = []
	timers = new Set()
	async connect() {
		this.route()
		this.capability()
		this.volume(35)
	}
	message(type, name, fields) {
		this.emit('mrp-message', { type, [`.${name}`]: fields })
	}
	route(extraOutputs = []) {
		this.message(37, 'deviceInfoMessage', {
			clusterID: 'shared-volume-output',
			uniqueIdentifier: 'tv-output',
			name: 'Synthetic TV',
			isGroupLeader: true,
			isProxyGroupPlayer: false,
			groupedDevices: extraOutputs.map((output) =>
				typeof output === 'string' ? { deviceUID: output, name: output } : { deviceUID: output.id, name: output.name },
			),
		})
	}
	capability(available = true) {
		this.available = available
		this.message(64, 'volumeControlCapabilitiesDidChangeMessage', {
			outputDeviceUID: 'shared-volume-output',
			capabilities: { volumeControlAvailable: available, volumeCapabilities: 2 },
		})
	}
	volume(percent) {
		this.level = percent
		this.message(52, 'volumeDidChangeMessage', { outputDeviceUID: 'shared-volume-output', volume: percent / 100 })
	}
	async sendMRPMessage(data) {
		const request = await MRPMessage.decode(data)
		this.requests.push(request)
		if (request['.clientUpdatesConfigMessage']?.volumeUpdates) {
			this.capability(this.available)
			this.volume(this.level)
		}
	}
	later(ms, callback) {
		const timer = setTimeout(() => {
			this.timers.delete(timer)
			if (!this.closed) callback()
		}, ms)
		this.timers.add(timer)
	}
	/** Mirrors the patched library: a reply timeout fails the connection unless fatalTimeout is false. */
	async sendMRPMessageAndWait(data, _responseType, timeoutMs = 5000, options = {}) {
		const request = await MRPMessage.decode(data)
		this.requests.push(request)
		const route = request['.modifyOutputContextRequestMessage']
		if (request.type !== 48 || !route) return { type: 50, '.getVolumeResultMessage': { volume: this.level / 100 } }
		this.routeRequests.push(route)
		const ack = { type: 0, identifier: request.identifier }
		const apply = () => {
			const extra = route.settingDevices.filter((id) => id !== 'tv-output')
			this.route(extra.map((id) => ({ id, name: this.names?.[id] ?? id })))
		}
		if (this.routeMode === 'reject') throw new Error('AirPlay MRP error 6')
		if (this.routeMode === 'ignore') return ack
		if (this.routeMode === 'apply') {
			setImmediate(apply)
			return ack
		}
		this.later(this.routeApplyMs, apply)
		const reply = Promise.withResolvers()
		let settled = false
		this.later(timeoutMs, () => {
			if (settled) return
			settled = true
			reply.reject(new Error('AirPlay request timed out'))
			if (options.fatalTimeout !== false) this.close()
		})
		if (this.routeMode === 'late')
			this.later(this.routeAckMs, () => {
				if (settled) return // A late reply is ignored, as in the library.
				settled = true
				reply.resolve(ack)
			})
		return reply.promise
	}
	close() {
		if (this.closed) return
		this.closed = true
		for (const timer of this.timers) clearTimeout(timer)
		this.timers.clear()
		this.emit('close')
	}
}
