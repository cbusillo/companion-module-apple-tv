/** Offline preview by default. Explicit --run observes the separate paired TV. */
import { open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { observeMetadata } from './metadata-pilot.js'
import type { MetadataSnapshot } from './metadata.js'

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			run: { type: 'boolean' },
			credentials: { type: 'string' },
			report: { type: 'string' },
			seconds: { type: 'string', default: '30' },
			help: { type: 'boolean' },
		},
	})
	const seconds = Number(values.seconds)
	if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('Use --seconds 5-60')
	const plan = {
		mode: values.run ? 'read-only observation' : 'offline preview',
		seconds,
		pairing: false,
		deviceControls: 0,
		observe: ['selected player and title', 'reported position', 'authenticated output and volume'],
	}
	if (values.help || !values.run) {
		process.stdout.write(`${JSON.stringify(plan)}\n`)
		process.stdout.write(
			'Run: node dist/prototype/metadata-live.js --run --credentials /private/test.json --report /private/new-report.json\n',
		)
		return
	}
	if (!values.credentials || !values.report) throw new Error('Separate credentials and a new report path are required')
	const report = await open(values.report, 'wx', 0o600)
	const controller = new AbortController()
	const onSignal = (): void => controller.abort()
	process.on('SIGINT', onSignal)
	process.on('SIGTERM', onSignal)
	const startedAt = new Date().toISOString()
	const samples: { at: string; snapshot: MetadataSnapshot }[] = []
	let completed = false
	let reason: string | undefined
	try {
		await observeMetadata({
			credentialsPath: values.credentials,
			seconds,
			signal: controller.signal,
			onSnapshot: (snapshot) => {
				const sample = { at: new Date().toISOString(), snapshot }
				if (samples.length >= 1000) throw new Error('Observation sample limit reached')
				samples.push(sample)
				// Keep device identifiers in the private receipt, not terminal output.
				process.stdout.write(
					`${JSON.stringify({ at: sample.at, connected: snapshot.connected, nowPlaying: snapshot.nowPlaying, volume: snapshot.audio.volume, outputCount: snapshot.audio.outputs?.length })}\n`,
				)
			},
		})
		completed = true
	} catch (error) {
		reason = error instanceof Error ? error.message : 'Metadata observation failed'
		process.exitCode = 1
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
		try {
			await report.writeFile(
				JSON.stringify({ ...plan, startedAt, endedAt: new Date().toISOString(), completed, reason, samples }, null, 2),
			)
			await report.sync()
		} finally {
			await report.close()
		}
	}
	process.stdout.write(`${completed ? 'Read-only observation complete' : reason}. No controls sent.\n`)
}

void main().catch(() => {
	process.stderr.write('Metadata pilot could not start. Check arguments and use a new private report path.\n')
	process.exitCode = 1
})
