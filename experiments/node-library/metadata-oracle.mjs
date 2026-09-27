/** Offline integration check of pyatv packets through the installed patched codec. */
import assert from 'node:assert/strict'
import { MRPMessage, Message } from 'node-appletv-remote'
import { MetadataState } from '../../dist/prototype/metadata.js'

let input = ''
for await (const chunk of process.stdin) input += chunk
/** @type {{messages: Record<string, string>}} */
const fixtures = JSON.parse(input)
const decode = async (name) => MRPMessage.decode(Buffer.from(fixtures.messages[name], 'hex'))
const state = new MetadataState()
state.setConnected()
for (const name of ['device', 'availability', 'capabilities', 'volume', 'client', 'player', 'state']) {
	state.receive(await decode(name))
}
assert.equal(state.snapshot().audio.volume, 30)
assert.equal(state.snapshot().audio.outputId, 'cluster-output')
assert.equal(state.snapshot().audio.outputs.length, 2)
assert.equal(state.snapshot().nowPlaying.state, 'Playing')
assert.equal(state.snapshot().nowPlaying.title, 'Synthetic title')
assert.equal(state.snapshot().nowPlaying.reportedPosition, 12)
state.receive(await decode('content'))
assert.equal(state.snapshot().nowPlaying.reportedPosition, 24)
assert.equal(state.snapshot().nowPlaying.title, 'Synthetic title')
state.receive(await decode('removePlayer'))
assert.equal(state.snapshot().nowPlaying.title, undefined)
assert.equal(new Message(await decode('ack')).type, 0)
assert.equal((await decode('error'))['errorCode'], 6)
state.invalidate()
assert.equal(state.snapshot().audio.volume, undefined)
console.log('Independent pyatv metadata codec/state check passed (offline).')
