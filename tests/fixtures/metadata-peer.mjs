import { EventEmitter } from 'node:events'

/** Synthetic authenticated-message source; never opens a network connection. */
export class MetadataPeer extends EventEmitter {
	closed = false
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
		this.message(64, 'volumeControlCapabilitiesDidChangeMessage', {
			outputDeviceUID: 'shared-volume-output',
			capabilities: { volumeControlAvailable: available, volumeCapabilities: 2 },
		})
	}
	volume(percent) {
		this.message(52, 'volumeDidChangeMessage', { outputDeviceUID: 'shared-volume-output', volume: percent / 100 })
	}
	close() {
		if (this.closed) return
		this.closed = true
		this.emit('close')
	}
}
