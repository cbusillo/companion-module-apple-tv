import { EventEmitter } from 'node:events'
import { MRPMessage } from 'node-appletv-remote'

/** Synthetic authenticated-message source; never opens a network connection. */
export class MetadataPeer extends EventEmitter {
	closed = false
	level = 35
	available = true
	requests = []
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
			groupedDevices: extraOutputs.map((id) => ({ deviceUID: id, name: id })),
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
	async sendMRPMessageAndWait(data) {
		this.requests.push(await MRPMessage.decode(data))
		return { type: 50, '.getVolumeResultMessage': { volume: this.level / 100 } }
	}
	close() {
		if (this.closed) return
		this.closed = true
		this.emit('close')
	}
}
