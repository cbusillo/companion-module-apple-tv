import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { NodeController } from '../../dist/prototype/controller.js'
import { withCompanionSession } from '../../dist/prototype/session.js'
import { withMetadataSession } from '../../dist/prototype/metadata-session.js'
import { MetadataPeer } from './metadata-peer.mjs'

/** Synthetic Companion and metadata peers for a real NodeController; no network access. */
export const credentials = {
	clientId: 'synthetic',
	serverId: 'synthetic',
	clientLTSK: Buffer.alloc(32),
	clientLTPK: Buffer.alloc(32),
	serverLTPK: Buffer.alloc(32),
}
export const reply = (entries = []) =>
	new Map([
		['_t', 3],
		['_c', new Map(entries)],
	])

export class Peer extends EventEmitter {
	constructor(metadata) {
		super()
		this.metadata = metadata
	}
	requests = []
	events = []
	closed = false
	onRequest = undefined
	async connect() {}
	async sendRequest(id, envelope) {
		const content = envelope.get('_c')
		this.requests.push({ id, content })
		if (this.onRequest) await this.onRequest(id, content)
		if (id === '_sessionStart') return reply([['_sid', 0xfedcba98]])
		if (id === 'FetchLaunchableApplicationsEvent') return reply([['com.example.app', 'Synthetic app']])
		if (id === 'FetchAttentionState') return reply([['state', 3]])
		if (id === '_mcc' && content.get('_mcc') === 5) return reply([['_vol', 0.2]])
		if (id === '_mcc' && content.get('_mcc') === 6) this.metadata.volume(content.get('_vol').value * 100)
		return reply()
	}
	sendMessage(id, envelope) {
		this.events.push({ id, content: envelope.get('_c') })
	}
	close() {
		if (!this.closed) {
			this.closed = true
			this.emit('close')
		}
	}
	push(identifier, entries) {
		this.emit('event', {
			identifier,
			data: new Map([
				['_t', 1],
				['_c', new Map(entries)],
			]),
		})
	}
}

export function fixture(options = {}) {
	const peers = []
	const metadataPeers = []
	let discoveries = 0
	const controller = new NodeController('synthetic', credentials, {
		reconnectDelayMs: 5,
		healthIntervalMs: 30000,
		discover: async () => {
			discoveries++
			return { address: 'unused.invalid', companionPort: 1, airplayPort: 2 }
		},
		metadataSession: (target, keys, signal, snapshot, operation) => {
			const peer = new MetadataPeer()
			metadataPeers.push(peer)
			return withMetadataSession(target, keys, signal, snapshot, operation, () => peer)
		},
		session: async (target, keys, signal, operation) => {
			const peer = new Peer(metadataPeers.at(-1))
			peers.push(peer)
			return withCompanionSession(target, keys, signal, operation, () => peer)
		},
		...options,
	})
	return { controller, peers, metadataPeers, discoveries: () => discoveries }
}

export async function until(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Condition did not arrive')
		await delay(5)
	}
}
