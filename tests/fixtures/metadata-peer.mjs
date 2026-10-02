import { EventEmitter } from 'node:events'
import { MRPMessage } from 'node-appletv-remote'

/** Synthetic authenticated-message source; never opens a network connection. */
export class MetadataPeer extends EventEmitter {
	closed = false
	level = 35
	available = true
	requests = []
	/** How the synthetic TV handles an output-route request: apply, ignore, reject, or silent (no reply). */
	routeMode = 'apply'
	routeRequests = []
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
	async sendMRPMessageAndWait(data, _responseType, timeoutMs) {
		const request = await MRPMessage.decode(data)
		this.requests.push(request)
		const route = request['.modifyOutputContextRequestMessage']
		if (request.type === 48 && route) {
			this.routeRequests.push(route)
			if (this.routeMode === 'reject') throw new Error('AirPlay MRP error 6')
			if (this.routeMode === 'silent') throw new Error(`AirPlay MRP request timed out after ${timeoutMs}`)
			if (this.routeMode === 'apply') {
				const extra = route.settingDevices.filter((id) => id !== 'tv-output')
				setImmediate(() => this.route(extra.map((id) => ({ id, name: this.names?.[id] ?? id }))))
			}
			return { type: 0, identifier: request.identifier }
		}
		return { type: 50, '.getVolumeResultMessage': { volume: this.level / 100 } }
	}
	close() {
		if (this.closed) return
		this.closed = true
		this.emit('close')
	}
}
