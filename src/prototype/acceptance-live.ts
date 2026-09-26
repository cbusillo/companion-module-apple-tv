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
			'sleep-seconds': { type: 'string' },
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
  node dist/prototype/acceptance-live.js --mode power --run --credentials /private/test.json --report /private/power.json
  node dist/prototype/acceptance-live.js --mode power --sleep-seconds 20
  node dist/prototype/acceptance-live.js --mode wake --run --credentials /private/test.json --report /private/wake.json

Without --run: offline preview only; no credential access or network connection.
Run only after the owner is watching. Wake mode requires an asleep TV; other modes require it awake.
Default --mode close-app: open the app, enter App Switcher, swipe up, then stop.
Close-app and remaining modes require one exact app-name match.
Explicit --mode power: sleep, wake, then request Wake again while already On.
Power/remaining modes allow --sleep-seconds 5-30 (default 5) before checking Off and sending Wake.
This changes only the test's Sleep observation pause, not the Wake command or other five-second pauses.
Explicit --mode wake: start from Off, wake, then request Wake again while already On.
Wake mode sends no Sleep, app, swipe, or volume control.
Wake queries current power: Home once for Off, no button for On, stop for Unknown.
The second Wake must leave the awake TV unchanged. No recovery retry is sent.
Explicit --mode remaining also tests volume and sleep/wake; requires volume 5-95%.
Power and remaining modes briefly blank the TV; the revised Wake needs qualification.
Ctrl-C, error, or connection loss stops remaining controls; no command is retried.
If the test stops after sleep, wake the TV with its normal remote.
Reports are created privately and never overwrite an existing file.
`)
		return
	}
	if (values.mode !== 'close-app' && values.mode !== 'power' && values.mode !== 'wake' && values.mode !== 'remaining')
		throw new Error('Invalid acceptance mode')
	if ((values.mode === 'close-app' || values.mode === 'remaining') && !values.app.trim())
		throw new Error('An app name is required')
	const mode: AcceptanceMode = values.mode
	const sleepSeconds = values['sleep-seconds'] === undefined ? undefined : Number(values['sleep-seconds'])
	const plan = previewAcceptance(values.app, mode, sleepSeconds)
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
			sleepSeconds,
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
