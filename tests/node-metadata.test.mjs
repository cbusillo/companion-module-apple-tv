import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { MetadataState } from '../dist/prototype/metadata.js'
import { observeMetadata } from '../dist/prototype/metadata-pilot.js'

const playerPath = (client = 'test.player', player = 'main') => ({
	client: { bundleIdentifier: client },
	player: { identifier: player },
})
const message = (type, extension, value) => ({ type, [`.${extension}`]: value })
function select(state, client = 'test.player', player = 'main') {
	state.receive(message(46, 'setNowPlayingClientMessage', { client: { bundleIdentifier: client } }))
	state.receive(message(47, 'setNowPlayingPlayerMessage', { playerPath: playerPath(client, player) }))
}
function playing(state, client = 'test.player', title = 'Synthetic title') {
	state.receive(
		message(4, 'setStateMessage', {
			playerPath: playerPath(client),
			playbackState: 1,
			playbackQueue: {
				location: 0,
				contentItems: [{ identifier: 'item', metadata: { title, elapsedTime: 12, duration: 180 } }],
			},
		}),
	)
}
function device(state, id = 'tv-output', groupedDevices = []) {
	state.receive(
		message(15, 'deviceInfoMessage', {
			name: 'Synthetic TV',
			uniqueIdentifier: 'tv-id',
			deviceUID: id,
			isGroupLeader: true,
			isProxyGroupPlayer: false,
			groupedDevices,
		}),
	)
}
function capability(state, id = 'tv-output', kind = 3) {
	state.receive(
		message(64, 'volumeControlCapabilitiesDidChangeMessage', {
			outputDeviceUID: id,
			capabilities: { volumeControlAvailable: true, volumeCapabilities: kind },
		}),
	)
}
function volume(state, id, value) {
	state.receive(message(52, 'volumeDidChangeMessage', { outputDeviceUID: id, volume: value }))
}

test('metadata follows the selected player, independent of arrival order and background apps', () => {
	const state = new MetadataState()
	state.setConnected()
	playing(state)
	playing(state, 'background.app', 'Background title')
	assert.equal(state.snapshot().nowPlaying.state, 'Unknown')
	select(state)
	assert.deepEqual(state.snapshot().nowPlaying, {
		state: 'Playing',
		app: 'test.player',
		title: 'Synthetic title',
		artist: undefined,
		album: undefined,
		duration: 180,
		reportedPosition: 12,
	})
	playing(state, 'background.app', 'New background title')
	assert.equal(state.snapshot().nowPlaying.title, 'Synthetic title')
})

test('partial playback updates retain metadata and content updates merge only matching items', () => {
	const state = new MetadataState()
	state.setConnected()
	select(state)
	playing(state)
	state.receive(message(4, 'setStateMessage', { playerPath: playerPath(), playbackState: 2 }))
	state.receive(
		message(56, 'updateContentItemMessage', {
			playerPath: playerPath(),
			contentItems: [
				{ identifier: 'not-current', metadata: { title: 'Wrong title' } },
				{ identifier: 'item', metadata: { elapsedTime: 24 } },
			],
		}),
	)
	assert.equal(state.snapshot().nowPlaying.state, 'Paused')
	assert.equal(state.snapshot().nowPlaying.title, 'Synthetic title')
	assert.equal(state.snapshot().nowPlaying.reportedPosition, 24)
	state.receive(message(4, 'setStateMessage', { playerPath: playerPath(), playbackQueue: {} }))
	assert.equal(state.snapshot().nowPlaying.state, 'Idle')
	assert.equal(state.snapshot().nowPlaying.title, undefined)
})

test('empty selection and player/client removal clear previous titles', () => {
	for (const removal of [
		message(46, 'setNowPlayingClientMessage', {}),
		message(47, 'setNowPlayingPlayerMessage', { playerPath: { client: { bundleIdentifier: 'test.player' } } }),
		message(53, 'removeClientMessage', { client: { bundleIdentifier: 'test.player' } }),
		message(54, 'removePlayerMessage', { playerPath: playerPath() }),
	]) {
		const state = new MetadataState()
		state.setConnected()
		select(state)
		playing(state)
		state.receive(removal)
		assert.equal(state.snapshot().nowPlaying.title, undefined)
		assert.equal(state.snapshot().nowPlaying.state, 'Idle')
	}
})

test('default-player fallback requires the selected client, not an arbitrary player', () => {
	const state = new MetadataState()
	state.setConnected()
	state.receive(message(46, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'test.player' } }))
	playing(state)
	assert.equal(state.snapshot().nowPlaying.title, undefined)
	state.receive(
		message(4, 'setStateMessage', {
			playerPath: playerPath('test.player', 'MediaRemote-DefaultPlayer'),
			playbackState: 1,
			playbackQueue: { contentItems: [{ metadata: { title: 'Default title' } }] },
		}),
	)
	assert.equal(state.snapshot().nowPlaying.title, 'Default title')
})

test('volume requires authenticated output identity, matching events and absolute capability', () => {
	const state = new MetadataState()
	state.setConnected()
	volume(state, 'tv-output', 0.5)
	assert.equal(state.snapshot().audio.volume, undefined)
	device(state)
	volume(state, 'tv-output', 0.3)
	volume(state, 'other-speaker', 0.8)
	assert.equal(state.snapshot().audio.volume, undefined)
	capability(state)
	assert.equal(state.snapshot().audio.volume, 30)
	assert.deepEqual(state.snapshot().audio.outputs, [{ id: 'tv-id', name: 'Synthetic TV' }])
	capability(state, 'tv-output', 1)
	assert.equal(state.snapshot().audio.volume, undefined)
	assert.equal(state.snapshot().audio.relative, true)
})

test('output change invalidates volume and capabilities; repeated identity does not', () => {
	const state = new MetadataState()
	state.setConnected()
	device(state)
	capability(state)
	volume(state, 'tv-output', 0.3)
	device(state)
	assert.equal(state.snapshot().audio.volume, 30)
	device(state, 'tv-output', [{ name: 'Speaker', deviceUID: 'speaker' }])
	assert.equal(state.snapshot().audio.volume, undefined)
	assert.equal(state.snapshot().audio.absolute, false)
	assert.equal(state.snapshot().audio.outputs.length, 2)
	capability(state)
	volume(state, 'tv-output', 0.4)
	assert.equal(state.snapshot().audio.volume, 40)
})

test('cluster identity wins, missing proto2 fields do not become observations', () => {
	const state = new MetadataState()
	state.setConnected()
	state.receive(message(15, 'deviceInfoMessage', { name: 'Cluster', deviceUID: 'device', clusterID: 'cluster' }))
	capability(state, 'cluster')
	volume(state, 'device', 0.8)
	assert.equal(state.snapshot().audio.volume, undefined)
	volume(state, 'cluster', 0)
	assert.equal(state.snapshot().audio.volume, 0)
	state.receive(
		message(52, 'volumeDidChangeMessage', Object.assign(Object.create({ volume: 0 }), { outputDeviceUID: 'cluster' })),
	)
	volume(state, 'cluster', 0.3)
	for (const invalid of [-1, 2, NaN, Infinity]) volume(state, 'cluster', invalid)
	assert.equal(state.snapshot().audio.volume, 30)
})

test('disconnect clears metadata and never restores stale state on reconnect', () => {
	const state = new MetadataState()
	state.setConnected()
	select(state)
	playing(state)
	device(state)
	capability(state)
	volume(state, 'tv-output', 0.3)
	state.invalidate()
	assert.equal(state.snapshot().connected, false)
	assert.equal(state.snapshot().nowPlaying.title, undefined)
	assert.equal(state.snapshot().audio.volume, undefined)
	state.setConnected()
	assert.equal(state.snapshot().nowPlaying.state, 'Unknown')
	assert.equal(state.snapshot().audio.outputId, undefined)
})

class Observer extends EventEmitter {
	terminations = 0
	async terminate() {
		this.terminations++
		return 0
	}
}
const options = (signal = new AbortController().signal) => ({
	credentialsPath: '/synthetic/test.json',
	seconds: 5,
	signal,
	onSnapshot() {},
})

test('cancelled or invalid pilots create no worker', async () => {
	let created = 0
	const factory = () => {
		created++
		return new Observer()
	}
	await assert.rejects(observeMetadata(options(AbortSignal.abort()), factory))
	await assert.rejects(observeMetadata({ ...options(), seconds: 0 }, factory))
	assert.equal(created, 0)
})

test('a stuck startup is terminated, not retried', async () => {
	const worker = new Observer()
	await assert.rejects(
		observeMetadata(options(), () => worker, 10),
		/timed out/,
	)
	assert.equal(worker.terminations, 1)
})

test('a real worker with pending handles is reaped after successful observation', async () => {
	let worker
	let count = 0
	await observeMetadata(
		{
			...options(),
			onSnapshot() {
				count++
			},
		},
		() => {
			worker = new Worker(
				new URL(
					`data:text/javascript,${encodeURIComponent(`
			import { parentPort } from 'node:worker_threads';
			setInterval(() => {}, 1000);
			parentPort.postMessage({kind:'snapshot',snapshot:{connected:true}});
			parentPort.postMessage({kind:'ready'});
		`)}`,
				),
			)
			return worker
		},
	)
	assert.equal(count, 1)
	assert.equal(worker.threadId, -1)
})

test('loss, cancellation, worker exit and report failure all terminate the observer', async () => {
	for (const event of ['failed', 'cancel', 'exit', 'report']) {
		const worker = new Observer()
		const controller = new AbortController()
		const received = []
		const pending = observeMetadata(
			{
				...options(controller.signal),
				onSnapshot(snapshot) {
					if (event === 'report') throw new Error('No disk space')
					received.push(snapshot)
				},
			},
			() => worker,
		)
		worker.emit('message', { kind: 'ready' })
		if (event === 'cancel') controller.abort()
		else if (event === 'exit') worker.emit('exit', 0)
		else if (event === 'report') worker.emit('message', { kind: 'snapshot', snapshot: {} })
		else worker.emit('message', { kind: 'failed' })
		worker.emit('message', { kind: 'snapshot', snapshot: {} })
		await assert.rejects(pending)
		assert.equal(worker.terminations, 1)
		assert.deepEqual(received, [])
	}
})

test('metadata CLI preview does not open the supplied credential/report paths', () => {
	const result = spawnSync(
		process.execPath,
		['dist/prototype/metadata-live.js', '--credentials', '/unreadable/test.json', '--report', '/unwritable/test.json'],
		{ encoding: 'utf8', timeout: 5000 },
	)
	assert.equal(result.status, 0, result.stderr)
	const preview = JSON.parse(result.stdout.split('\n')[0])
	assert.equal(preview.mode, 'offline preview')
	assert.equal(preview.deviceControls, 0)
	assert.equal(preview.pairing, false)
})
