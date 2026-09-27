import assert from 'node:assert/strict'
import process from 'node:process'
import { CompanionPrototype } from '../../dist/prototype/companion.js'

let input = ''
for await (const chunk of process.stdin) input += chunk
const cases = JSON.parse(input)
for (const reference of cases) {
	let clock = 0n
	const events = []
	const sleeps = []
	const client = {
		async sendCompanionRequest() {
			clock += 3000000n
			return new Map([
				['_t', 3],
				['_c', new Map()],
			])
		},
		sendCompanionMessage(id, envelope) {
			const content = Object.fromEntries(envelope.get('_c'))
			content._ns = Number(content._ns)
			events.push({ id, content })
		},
	}
	const controls = new CompanionPrototype(client, {
		now: () => {
			const value = clock
			clock += 1000n
			return value
		},
		pause: async (ms) => {
			clock += BigInt(reference.schedule[sleeps.length % reference.schedule.length]) * 1000000n
			sleeps.push(ms)
		},
	})
	await controls.swipe(reference.direction)
	assert.deepEqual(events, reference.events, `${reference.direction}: pyatv motion, timestamps, and release`)
	assert.deepEqual(sleeps, reference.sleeps)
}
process.stdout.write(`Independent pyatv gesture parity: ${cases.length} traces passed\n`)
