/** Offline preview by default; an explicit --run starts the prepared device test. */
import { open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { PilotStopped, previewAcceptance, runAcceptance, type AcceptanceMode } from './acceptance.js'
import { loadTestCredentials } from './credentials.js'
import { NodeController } from './controller.js'

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			app: { type: 'string', default: 'YouTube' },
			mode: { type: 'string', default: 'close-app' },
			run: { type: 'boolean' },
			credentials: { type: 'string' },
			report: { type: 'string' },
			help: { type: 'boolean' },
		},
	})
	if (values.help) {
		process.stdout.write(`Prepared physical test (Node 22):
  node dist/prototype/acceptance-live.js --app YouTube
  node dist/prototype/acceptance-live.js --app YouTube --run --credentials /private/test.json --report /private/result.json

Without --run: offline preview only; no credential access or network connection.
Run only after the owner is watching. Requires an awake TV and one exact app-name match.
Default --mode close-app: open the app, enter App Switcher, swipe up, then stop.
Explicit --mode remaining also tests volume and sleep/wake; requires volume 5-95%.
Playback will stop. Remaining mode briefly blanks the TV and wake is not yet qualified.
Ctrl-C, error, or connection loss stops remaining controls; no command is retried.
If the test stops after sleep, wake the TV with its normal remote.
Reports are created privately and never overwrite an existing file.
`)
		return
	}
	if (!values.app.trim()) throw new Error('An app name is required')
	if (values.mode !== 'close-app' && values.mode !== 'remaining') throw new Error('Invalid acceptance mode')
	const mode: AcceptanceMode = values.mode
	const plan = previewAcceptance(values.app, mode)
	if (!values.run) {
		process.stdout.write(`${JSON.stringify({ mode: 'offline preview', plan })}\n`)
		return
	}
	if (!values.credentials || !values.report) throw new Error('Separate credentials and a new report path are required')
	const record = await loadTestCredentials(values.credentials)
	const report = await open(values.report, 'wx', 0o600)
	const controller = new NodeController(record.deviceId, record.credentials)
	const cancel = new AbortController()
	const onSignal = (): void => {
		cancel.abort()
		void controller.stop()
	}
	const events: object[] = []
	const startedAt = new Date().toISOString()
	let completed = false
	let stopReason: string | undefined
	process.on('SIGINT', onSignal)
	process.on('SIGTERM', onSignal)
	const deadline = setTimeout(onSignal, 90000)
	try {
		controller.start()
		await controller.waitUntilReady(15000)
		await runAcceptance(controller, {
			appName: values.app,
			mode,
			signal: cancel.signal,
			record: (event) => {
				const entry = { ...event, at: new Date().toISOString() }
				events.push(entry)
				process.stdout.write(`${JSON.stringify(entry)}\n`)
			},
		})
		completed = true
	} catch (error) {
		stopReason =
			error instanceof PilotStopped
				? error.message
				: cancel.signal.aborted
					? 'Cancelled or timed out'
					: 'Request failed; delivery uncertain'
		throw error
	} finally {
		await controller.stop()
		clearTimeout(deadline)
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
		try {
			await report.writeFile(
				`${JSON.stringify(
					{
						startedAt,
						endedAt: new Date().toISOString(),
						plan,
						completed,
						stopReason,
						physicalResult: 'unverified; requires owner observation',
						reconnects: controller.reconnects,
						events,
					},
					null,
					2,
				)}\n`,
			)
		} finally {
			await report.close()
		}
	}
}

main().catch(() => {
	// Provider exceptions can contain device identifiers; keep them out of output.
	process.stderr.write('Prepared test did not complete. No failed action was retried; check the report if created.\n')
	process.exitCode = 1
})
