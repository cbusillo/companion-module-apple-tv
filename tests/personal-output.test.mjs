import assert from 'node:assert/strict'
import test from 'node:test'
import { PersonalOutputRouter } from '../dist/personal-output.js'
import { OutputRouteRejected } from '../dist/prototype/metadata-session.js'
import { CommandNotSent } from '../dist/prototype/queue.js'

const tv = { id: 'tv-output', name: 'Living Room' }
const airpods = { id: 'synthetic-airpods', name: "Someone's AirPods Pro" }

function fixture({ confirmationMs = 20000, failedHoldMs = 10000 } = {}) {
	const f = { learned: [], results: [], sends: [], changes: 0, reply: async () => true }
	f.router = new PersonalOutputRouter(
		{
			changed: () => f.changes++,
			learned: (output) => f.learned.push(output),
			result: (message) => f.results.push(message),
		},
		{ confirmationMs, failedHoldMs },
	)
	f.link = (outputs, session = 'a:1', send = true) => ({
		session,
		outputs,
		send: send
			? async (ids) => {
					f.sends.push({ session, ids })
					return f.reply(ids)
				}
			: undefined,
	})
	return f
}

test('disabled configuration exposes no working route and sends nothing', async () => {
	const f = fixture()
	f.router.configure({ match: '', id: '' })
	f.router.observe(f.link([tv, airpods]))
	assert.equal(f.router.route, 'Unavailable')
	assert.equal(f.router.name, '')
	assert.equal(f.router.active, false)
	assert.match(await f.router.select('toggle'), /not configured/)
	assert.deepEqual(f.sends, [])
	assert.deepEqual(f.learned, [])
})

test('a name match learns the reported UID once and remembers it while routed to default', async () => {
	const f = fixture()
	f.router.configure({ match: 'airpods' })
	f.router.observe(f.link([tv]))
	assert.equal(f.router.route, 'Unavailable', 'unknown until the output has been reported')
	assert.match(await f.router.select('toggle'), /not identified/)
	f.router.observe(f.link([tv, airpods]))
	assert.deepEqual(f.learned, [{ match: 'airpods', ...airpods }])
	assert.equal(f.router.route, 'Personal')
	assert.equal(f.router.name, airpods.name)
	f.router.observe(f.link([tv]))
	assert.equal(f.router.route, 'Default')
	assert.equal(f.router.name, airpods.name)
	assert.equal(f.learned.length, 1)
	assert.deepEqual(f.sends, [])

	const restarted = fixture()
	restarted.router.configure({ match: 'AirPods' }, f.learned[0])
	restarted.router.observe(restarted.link([tv]))
	assert.equal(restarted.router.route, 'Default')
	const renamed = fixture()
	renamed.router.configure({ match: 'beats' }, f.learned[0])
	renamed.router.observe(renamed.link([tv]))
	assert.equal(renamed.router.route, 'Unavailable', 'a learned output belongs to its name match')
})

test('ambiguous name matches never guess; an explicit identifier overrides the match', () => {
	const f = fixture()
	const other = { id: 'other-airpods', name: 'Guest AirPods' }
	f.router.configure({ match: 'airpods' })
	f.router.observe(f.link([tv, airpods, other]))
	assert.deepEqual(f.learned, [])
	assert.equal(f.router.route, 'Unavailable')
	f.router.configure({ match: 'airpods', id: other.id })
	assert.equal(f.router.route, 'Personal')
	assert.equal(f.router.name, other.name)
	assert.deepEqual(f.learned, [])
})

test('toggle direction comes from the live list and each press sends one request', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = fixture()
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv]))
	assert.match(await f.router.select('toggle'), /acknowledged; waiting/)
	assert.deepEqual(f.sends, [{ session: 'a:1', ids: [airpods.id] }])
	assert.equal(f.router.route, 'Connecting')
	assert.match(await f.router.select('toggle'), /already pending; not sent/)
	assert.equal(f.sends.length, 1)
	f.router.observe(f.link([tv, airpods]))
	assert.equal(f.router.route, 'Personal')
	assert.equal(f.router.active, true)
	assert.match(f.results.at(-1), /personal output confirmed/)

	assert.match(await f.router.select('personal'), /already active; not sent/)
	assert.match(await f.router.select('toggle'), /acknowledged/)
	assert.deepEqual(f.sends.at(-1).ids, [tv.id], 'default is every reported output except the personal one')
	f.router.observe(f.link([tv]))
	assert.equal(f.router.route, 'Default')
	assert.match(f.results.at(-1), /default output confirmed/)
	assert.match(await f.router.select('default'), /already active; not sent/)
	assert.equal(f.sends.length, 2)
	t.mock.timers.tick(60000)
	assert.equal(f.router.route, 'Default', 'a confirmed request leaves no timer behind')
})

test('an unconfirmed request fails after the window and a late success replaces Failed', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = fixture()
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv]))
	await f.router.select('toggle')
	t.mock.timers.tick(19999)
	assert.equal(f.router.route, 'Connecting')
	t.mock.timers.tick(1)
	assert.equal(f.router.route, 'Failed')
	assert.match(f.results.at(-1), /not confirmed in time; not retried/)
	f.router.observe(f.link([tv]))
	assert.equal(f.router.route, 'Failed', 'an unchanged list keeps the failure visible')
	f.router.observe(f.link([tv, airpods]))
	assert.equal(f.router.route, 'Personal')
	assert.equal(f.sends.length, 1, 'nothing was retried')
})

test('Failed returns to the live route after its hold and a manual TV change updates the route', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = fixture({ confirmationMs: 100, failedHoldMs: 50 })
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv]))
	await f.router.select('personal')
	t.mock.timers.tick(100)
	assert.equal(f.router.route, 'Failed')
	t.mock.timers.tick(50)
	assert.equal(f.router.route, 'Default')
	f.router.observe(f.link([tv, airpods]))
	assert.equal(f.router.route, 'Personal', 'a change made on the TV is reflected')
	f.router.observe(f.link([tv]))
	assert.equal(f.router.route, 'Default')
	assert.equal(f.sends.length, 1)
})

test('a rejection fails immediately without retry and a silent TV still waits for the list', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = fixture()
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv]))
	f.reply = async () => {
		throw new OutputRouteRejected('rejected')
	}
	assert.match(await f.router.select('toggle'), /rejected by Apple TV; not retried/)
	assert.equal(f.router.route, 'Failed')
	f.reply = async () => false
	assert.match(await f.router.select('toggle'), /without acknowledgement; waiting/)
	assert.equal(f.router.route, 'Connecting')
	f.router.observe(f.link([tv, airpods]))
	assert.equal(f.router.route, 'Personal')
	assert.equal(f.sends.length, 2)
})

test('reconnect cancels a pending request and ignores its late completion', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = fixture()
	const reply = Promise.withResolvers()
	f.reply = async () => reply.promise
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv], 'a:1'))
	const pending = f.router.select('toggle')
	assert.equal(f.router.route, 'Connecting')
	f.router.observe(undefined)
	assert.equal(f.router.route, 'Unavailable')
	assert.match(f.results.at(-1), /connection changed before the output change was confirmed/)
	f.router.observe(f.link([tv], 'a:2'))
	assert.equal(f.router.route, 'Default')
	reply.resolve(true)
	assert.match(await pending, /finished or cancelled/)
	t.mock.timers.tick(60000)
	assert.equal(f.router.route, 'Default', 'the stale request cannot later report Failed')
	f.router.observe(f.link([tv, airpods], 'a:2'))
	assert.equal(f.router.route, 'Personal', 'a late route change is still reflected from the list')
	assert.equal(f.sends.length, 1)

	f.reply = async () => {
		throw new CommandNotSent('changed')
	}
	assert.match(await f.router.select('toggle'), /not sent; connection changed/)
	assert.equal(f.router.route, 'Personal')
})

test('missing route capability reports Unavailable and sends nothing', async () => {
	const f = fixture()
	f.router.configure({ id: airpods.id })
	f.router.observe(f.link([tv], 'a:1', false))
	assert.equal(f.router.route, 'Unavailable')
	assert.match(await f.router.select('toggle'), /unavailable on this connection/)
	f.router.observe(undefined)
	assert.match(await f.router.select('toggle'), /not connected/)
	f.router.observe(f.link([airpods]))
	assert.match(await f.router.select('default'), /default output not reported/)
	assert.deepEqual(f.sends, [])
})
