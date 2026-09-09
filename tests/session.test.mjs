import test from 'node:test'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AppleTV from '../dist/main.js'
function fixture() {
	const module = Object.create(AppleTV.prototype)
	Object.assign(module, {
		generation: 1,
		ready: true,
		queued: 0,
		probe: false,
		tail: Promise.resolve(),
		capabilities: new Set(['navigation']),
		config: { enabled: false },
		retryDelay: 5000,
		lastActivity: -40000,
	})
	const updates = []
	const calls = []
	module.setVariableValues = (v) => updates.push(v)
	module.updateStatus = () => {}
	module.transport = {
		request: async (v) => {
			calls.push(v.operation)
			return { state: 'ready', capabilities: ['navigation'] }
		},
		stop: () => {},
	}
	return { module, calls, updates }
}
test('idle probe serializes with an arriving action', async () => {
	const { module, calls } = fixture()
	let finish
	module.transport.request = async (v) => {
		calls.push(v.operation)
		if (v.operation === 'status') await new Promise((r) => (finish = r))
		return { state: 'ready', capabilities: ['navigation'] }
	}
	const probe = module.checkHealth()
	await Promise.resolve()
	const action = module.dispatch('up')
	await Promise.resolve()
	assert.deepEqual(calls, ['status'])
	finish()
	await Promise.all([probe, action])
	assert.deepEqual(calls, ['status', 'action'])
})
test('input expires behind a slow probe rather than playing later', async (t) => {
	const { module, calls, updates } = fixture()
	let now = 40000
	t.mock.method(performance, 'now', () => now)
	let finish
	module.transport.request = async (v) => {
		calls.push(v.operation)
		await new Promise((r) => (finish = r))
		return { state: 'ready', capabilities: ['navigation'] }
	}
	const probe = module.checkHealth()
	await Promise.resolve()
	const action = module.dispatch('up')
	now += 1001
	finish()
	await Promise.all([probe, action])
	assert.deepEqual(calls, ['status'])
	assert.equal(updates.at(-1).last_result, 'expired; not sent')
})
test('failed probe discards queued action and invalidates session', async () => {
	const { module, calls } = fixture()
	let fail
	module.transport.request = async (v) => {
		calls.push(v.operation)
		return new Promise((_, reject) => (fail = reject))
	}
	const probe = module.checkHealth()
	await Promise.resolve()
	const action = module.dispatch('up')
	fail(new Error('offline'))
	await Promise.all([probe, action])
	assert.deepEqual(calls, ['status'])
	assert.equal(module.ready, false)
	assert.equal(module.generation, 2)
})
test('busy queue suppresses probe and rejects inputs beyond eight', async () => {
	const { module, calls, updates } = fixture()
	module.queued = 8
	await module.checkHealth()
	await module.dispatch('up')
	assert.deepEqual(calls, [])
	assert.equal(updates.at(-1).last_result, 'unavailable or busy')
})
test('destroy prevents a late probe reply from restoring readiness', async () => {
	const { module } = fixture()
	let finish
	module.transport.request = async () => new Promise((r) => (finish = r))
	const probe = module.checkHealth()
	await Promise.resolve()
	await module.destroy()
	finish({ state: 'ready', capabilities: ['navigation'] })
	await probe
	assert.equal(module.ready, false)
	assert.equal(module.capabilities.size, 0)
})

for (const kind of ['public', 'symlink', 'oversized'])
	test('credential loader rejects ' + kind + ' before worker spawn', async () => {
		const { module } = fixture()
		const dir = await mkdtemp(join(tmpdir(), 'apple-tv-test-'))
		try {
			const source = join(dir, 'secret.json')
			await writeFile(source, kind === 'oversized' ? 'x'.repeat(8193) : '{}', { mode: 0o600 })
			if (kind === 'public') await chmod(source, 0o644)
			let path = source
			if (kind === 'symlink') {
				path = join(dir, 'link')
				await symlink(source, path)
			}
			let started = false
			module.transport.start = () => {
				started = true
			}
			module.config = { enabled: false, python: process.execPath, credentialFile: path }
			await module.connect()
			assert.equal(started, false)
			assert.equal(module.ready, false)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

test('duplicate offline notification does not inflate scheduled backoff', async () => {
	const { module } = fixture()
	module.config.enabled = true
	module.offline()
	const delay = module.retryDelay
	const timer = module.timer
	module.offline()
	assert.equal(module.retryDelay, delay)
	assert.equal(module.timer, timer)
	await module.destroy()
})
test('successful real action resets retry backoff during active use', async () => {
	const { module } = fixture()
	module.retryDelay = 60000
	await module.dispatch('up')
	assert.equal(module.retryDelay, 5000)
})

test('unsupported health query stops reconnect attempts', async () => {
	const { module, updates } = fixture()
	module.config.enabled = true
	module.transport.request = async () => ({ state: 'unknown', error: 'healthUnsupported' })
	await module.checkHealth()
	assert.equal(module.ready, false)
	assert.equal(module.timer, undefined)
	assert.equal(updates.at(-1).connection, 'unsupported')
})
test('successful action refreshes capabilities', async () => {
	const { module } = fixture()
	module.transport.request = async () => ({ state: 'ready', capabilities: ['navigation', 'select'] })
	await module.dispatch('up')
	assert.equal(module.capabilities.has('select'), true)
})
