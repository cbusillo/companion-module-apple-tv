/** Isolated read-only experiment: parent termination bounds candidate transport handles. */
import { parentPort, workerData } from 'node:worker_threads'
import { AirPlayConnection, scan } from 'node-appletv-remote'
import { loadTestCredentials } from './credentials.js'
import { MetadataState } from './metadata.js'

const port = parentPort
if (!port) throw new Error('Metadata worker requires its supervisor')
const state = new MetadataState()
let connection: AirPlayConnection | undefined
let lastSnapshot = ''
let stopped = false
function publish(): void {
	const snapshot = state.snapshot()
	const encoded = JSON.stringify(snapshot)
	if (encoded === lastSnapshot) return
	lastSnapshot = encoded
	port!.postMessage({ kind: 'snapshot', snapshot })
}
function fail(): void {
	if (stopped) return
	stopped = true
	state.invalidate()
	publish()
	connection?.close()
	port!.postMessage({ kind: 'failed' })
}

async function run(): Promise<void> {
	const { credentialsPath } = workerData as { credentialsPath: string }
	const saved = await loadTestCredentials(credentialsPath)
	const matches = (await scan({ timeout: 5000 })).filter(
		(device) => device.deviceId === saved.deviceId && device.model.startsWith('AppleTV'),
	)
	if (matches.length !== 1) throw new Error('Selected TV not uniquely discovered')
	const target = matches[0]
	connection = new AirPlayConnection(target.address, target.port, saved.credentials)
	connection.on('error', fail)
	connection.on('close', fail)
	connection.on('mrp-message', (message: Record<string, unknown>) => {
		if (stopped) return
		state.receive(message)
		publish()
	})
	await connection.connect()
	if (stopped) return
	state.setConnected()
	publish()
	port!.postMessage({ kind: 'ready' })
}

void run().catch(fail)
