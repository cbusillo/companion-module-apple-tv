import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Transport } from '../dist/transport.js'
const worker = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url))
function transport() {
	let failures = 0
	const t = new Transport(() => failures++)
	t.start(process.execPath, [worker])
	return { t, failures: () => failures }
}
test('persistent process accepts sequential requests and strips no framing', async () => {
	const { t } = transport()
	try {
		const a = await t.request({ operation: 'status' })
		const b = await t.request({ operation: 'status' })
		assert.equal(a.state, 'ready')
		assert.equal(b.id, a.id + 1)
	} finally {
		t.stop()
	}
})
test('timeout invalidates session; subsequent command cannot replay', async () => {
	const { t, failures } = transport()
	try {
		await assert.rejects(t.request({ operation: 'hang' }, 100), /session_closed/)
		assert.equal(failures(), 1)
		await assert.rejects(t.request({ operation: 'status' }), /not_available/)
	} finally {
		t.stop()
	}
})
test('parallel request is rejected rather than unbounded buffering', async () => {
	const { t } = transport()
	const pending = t.request({ operation: 'hang' }, 100)
	try {
		await assert.rejects(t.request({ operation: 'status' }), /not_available/)
		await assert.rejects(pending)
	} finally {
		t.stop()
	}
})
for (const operation of ['malformed', 'oversize', 'exit', 'lost'])
	test(operation + ' closes session', async () => {
		const { t } = transport()
		try {
			await assert.rejects(t.request({ operation }, 2000))
			await assert.rejects(t.request({ operation: 'status' }))
		} finally {
			t.stop()
		}
	})
test('replacement session rejects old pending request', async () => {
	const { t } = transport()
	const pending = t.request({ operation: 'hang' })
	const rejected = assert.rejects(pending, /session_closed/)
	t.start(process.execPath, [worker])
	await rejected
	try {
		assert.equal((await t.request({ operation: 'status' })).state, 'ready')
	} finally {
		t.stop()
	}
})

test('split UTF-8 chunks preserve response values', async () => {
	const { t } = transport()
	try {
		assert.deepEqual((await t.request({ operation: 'unicode' })).capabilities, ['é'])
	} finally {
		t.stop()
	}
})
