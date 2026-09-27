/** Read-only state from authenticated AirPlay/MRP messages. Never sends controls. */
type Fields = Record<string, unknown>
type Player = { state?: number; items: Fields[]; location: number }
type Output = { id: string; name: string }

export type MetadataSnapshot = {
	connected: boolean
	nowPlaying: {
		state: 'Unknown' | 'Idle' | 'Playing' | 'Paused' | 'Stopped' | 'Interrupted' | 'Seeking'
		app?: string
		title?: string
		artist?: string
		album?: string
		duration?: number
		reportedPosition?: number
	}
	audio: { volume?: number; absolute: boolean; relative: boolean; outputId?: string; outputs?: Output[] }
}

function fields(value: unknown): Fields | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : undefined
}

function own(value: Fields | undefined, key: string): unknown {
	return value && Object.hasOwn(value, key) ? value[key] : undefined
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function path(value: unknown): { client: string; player: string } | undefined {
	const record = fields(value)
	const client = text(fields(record?.client)?.bundleIdentifier)
	const player = text(fields(record?.player)?.identifier)
	return client && player ? { client, player } : undefined
}

export class MetadataState {
	private connected = false
	private selectedClient?: string
	private selectionReceived = false
	private clients = new Map<string, { selected?: string | null; players: Map<string, Player> }>()
	private outputId?: string
	private outputs?: Output[]
	private capabilities?: Fields
	private outputCapabilities = new Map<string, Fields>()
	private volumes = new Map<string, number>()

	setConnected(): void {
		this.connected = true
	}

	invalidate(): void {
		this.connected = false
		this.selectedClient = undefined
		this.selectionReceived = false
		this.clients.clear()
		this.outputId = undefined
		this.outputs = undefined
		this.capabilities = undefined
		this.outputCapabilities.clear()
		this.volumes.clear()
	}

	private client(id: string): { selected?: string | null; players: Map<string, Player> } {
		let client = this.clients.get(id)
		if (!client) {
			client = { players: new Map() }
			this.clients.set(id, client)
		}
		return client
	}

	receive(message: Fields): void {
		// Use field presence: proto2 inherited defaults are not observations.
		switch (own(message, 'type')) {
			case 15:
			case 37: {
				const info = fields(message['.deviceInfoMessage'])
				if (!info) return
				const id = text(own(info, 'clusterID')) ?? text(own(info, 'deviceUID'))
				const outputs: Output[] = []
				const add = (device: Fields, key: string): void => {
					const deviceId = text(own(device, key))
					const name = text(own(device, 'name'))
					if (deviceId && name) outputs.push({ id: deviceId, name })
				}
				if (own(info, 'isGroupLeader') === true && own(info, 'isProxyGroupPlayer') === false)
					add(info, 'uniqueIdentifier')
				if (Array.isArray(info.groupedDevices)) {
					for (const item of info.groupedDevices) {
						const device = fields(item)
						if (device) add(device, 'deviceUID')
					}
				}
				const identity = (devices: Output[] | undefined): string =>
					JSON.stringify(devices?.map((device) => device.id).sort())
				if (this.outputId !== id || identity(this.outputs) !== identity(outputs)) {
					this.volumes.clear()
					this.capabilities = undefined
					this.outputCapabilities.clear()
				}
				this.outputId = id
				this.outputs = outputs
				return
			}
			case 17:
				this.capabilities = fields(message['.volumeControlAvailabilityMessage'])
				return
			case 64: {
				const update = fields(message['.volumeControlCapabilitiesDidChangeMessage'])
				const id = text(update?.outputDeviceUID)
				const capabilities = fields(update?.capabilities)
				if (id && capabilities) this.outputCapabilities.set(id, capabilities)
				return
			}
			case 52: {
				const update = fields(message['.volumeDidChangeMessage'])
				const id = text(update?.outputDeviceUID)
				const volume = finite(own(update, 'volume'))
				if (id && volume !== undefined && volume <= 1) this.volumes.set(id, Math.round(volume * 10000) / 100)
				return
			}
			case 46:
				this.selectionReceived = true
				this.selectedClient = text(fields(fields(message['.setNowPlayingClientMessage'])?.client)?.bundleIdentifier)
				return
			case 47: {
				const selection = fields(fields(message['.setNowPlayingPlayerMessage'])?.playerPath)
				const client = text(fields(selection?.client)?.bundleIdentifier)
				if (client) this.client(client).selected = text(fields(selection?.player)?.identifier) ?? null
				return
			}
			case 4: {
				const update = fields(message['.setStateMessage'])
				const target = path(update?.playerPath)
				if (!update || !target) return
				const players = this.client(target.client).players
				const player = players.get(target.player) ?? { items: [], location: 0 }
				const state = finite(own(update, 'playbackState'))
				if (state !== undefined) player.state = state
				const queue = fields(own(update, 'playbackQueue'))
				if (queue) {
					player.items = Array.isArray(queue.contentItems) ? queue.contentItems.filter(fields) : []
					player.location = finite(own(queue, 'location')) ?? 0
				}
				players.set(target.player, player)
				return
			}
			case 56: {
				const update = fields(message['.updateContentItemMessage'])
				const target = path(update?.playerPath)
				if (!target || !Array.isArray(update?.contentItems)) return
				const player = this.clients.get(target.client)?.players.get(target.player)
				for (const item of update.contentItems) {
					const record = fields(item)
					const existing = player?.items.find((entry) => entry.identifier === text(record?.identifier))
					if (existing) existing.metadata = { ...fields(existing.metadata), ...fields(record?.metadata) }
				}
				return
			}
			case 53: {
				const client = text(fields(fields(message['.removeClientMessage'])?.client)?.bundleIdentifier)
				if (!client) return
				this.clients.delete(client)
				if (this.selectedClient === client) this.selectedClient = undefined
				return
			}
			case 54: {
				const target = path(fields(message['.removePlayerMessage'])?.playerPath)
				if (!target) return
				const client = this.clients.get(target.client)
				client?.players.delete(target.player)
				if (client?.selected === target.player) client.selected = null
				return
			}
			default:
				return
		}
	}

	snapshot(): MetadataSnapshot {
		const result: MetadataSnapshot = {
			connected: this.connected,
			nowPlaying: { state: 'Unknown' },
			audio: { absolute: false, relative: false },
		}
		if (!this.connected) return result
		const capabilities = (this.outputId && this.outputCapabilities.get(this.outputId)) || this.capabilities
		if (this.outputId && own(capabilities, 'volumeControlAvailable') === true) {
			const kind = own(capabilities, 'volumeCapabilities')
			result.audio.absolute = kind === 2 || kind === 3
			result.audio.relative = kind === 1 || kind === 3
			if (result.audio.absolute) result.audio.volume = this.volumes.get(this.outputId)
		}
		result.audio.outputId = this.outputId
		result.audio.outputs = this.outputs?.map((output) => ({ ...output }))
		if (!this.selectionReceived) return result
		result.nowPlaying.state = 'Idle'
		if (!this.selectedClient) return result
		result.nowPlaying.app = this.selectedClient
		const client = this.clients.get(this.selectedClient)
		const selected = client?.selected === undefined ? 'MediaRemote-DefaultPlayer' : client.selected
		const player = selected ? client?.players.get(selected) : undefined
		if (!player) return result
		const metadata = fields(player.items[player.location]?.metadata)
		const states: MetadataSnapshot['nowPlaying']['state'][] = [
			'Unknown',
			'Playing',
			'Paused',
			'Stopped',
			'Interrupted',
			'Seeking',
		]
		result.nowPlaying.state =
			player.state === undefined || (player.state === 2 && !metadata) ? 'Idle' : (states[player.state] ?? 'Unknown')
		result.nowPlaying.title = text(own(metadata, 'title'))
		result.nowPlaying.artist = text(own(metadata, 'trackArtistName'))
		result.nowPlaying.album = text(own(metadata, 'albumName'))
		result.nowPlaying.duration = finite(own(metadata, 'duration'))
		result.nowPlaying.reportedPosition = finite(own(metadata, 'elapsedTime'))
		return result
	}
}
