/** Explicit, separate developer pilot. Default behavior only observes the TV. */
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { loadTestCredentials } from './credentials.js'
import { NodeController, type RemoteAction } from './controller.js'
import type { Button, Direction, MediaCommand } from './companion.js'

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			credentials: { type: 'string' },
			seconds: { type: 'string', default: '5' },
			button: { type: 'string' },
			media: { type: 'string' },
			swipe: { type: 'string' },
			seek: { type: 'string' },
			volume: { type: 'string' },
			app: { type: 'string' },
			power: { type: 'boolean' },
			mute: { type: 'boolean' },
			help: { type: 'boolean' },
		},
	})
	if (values.help) {
		process.stdout.write(`Separate Node control pilot (requires existing test pairing):
  node dist/prototype/controls-live.js --credentials /private/test.json [--seconds 5]
  Add exactly one action: --button up|down|left|right|select|back|home|appSwitcher|homeHold|controlCenter|playPause|volumeUp|volumeDown|screensaver
    --media play|pause|next|previous | --swipe up|down|left|right | --seek SECONDS
    --volume PERCENT | --app BUNDLE_ID | --power | --mute
Default: read-only status. Actions run once; physical effect requires observation.
Mute remains unavailable until an authenticated metadata source identifies the audio output.
`)
		return
	}
	if (!values.credentials) throw new Error('Provide a separate test credential file')
	const seconds = Number(values.seconds)
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
		throw new RangeError('Observation time must be 1–60 seconds')
	const actions: RemoteAction[] = []
	if (values.button) actions.push({ kind: 'button', button: values.button as Button })
	if (values.media) actions.push({ kind: 'media', command: values.media as MediaCommand })
	if (values.swipe) actions.push({ kind: 'swipe', direction: values.swipe as Direction })
	if (values.seek !== undefined) actions.push({ kind: 'seek', seconds: Number(values.seek) })
	if (values.volume !== undefined) actions.push({ kind: 'volume', percent: Number(values.volume) })
	if (values.app !== undefined) actions.push({ kind: 'launch', bundleId: values.app })
	if (values.power) actions.push({ kind: 'power' })
	if (values.mute) actions.push({ kind: 'mute' })
	if (actions.length > 1) throw new RangeError('Choose only one action per supervised test')
	const record = await loadTestCredentials(values.credentials)
	const controller = new NodeController(record.deviceId, record.credentials)
	const cancel = new AbortController()
	const onSignal = (): void => {
		cancel.abort()
		void controller.stop()
	}
	process.on('SIGINT', onSignal)
	process.on('SIGTERM', onSignal)
	try {
		controller.start()
		await controller.waitUntilReady()
		if (actions.length) {
			await controller.perform(actions[0])
			process.stdout.write(`${JSON.stringify({ dispatch: 'completed', physicalResult: 'unverified' })}\n`)
		}
		await delay(seconds * 1000, undefined, { signal: cancel.signal })
		process.stdout.write(
			`${JSON.stringify({
				connection: controller.state,
				reconnects: controller.reconnects,
				feedback: controller.feedback,
			})}\n`,
		)
	} finally {
		await controller.stop()
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
}

main().catch(() => {
	// No provider payload, key, credential identifier or PIN is logged.
	process.stderr.write('Pilot did not complete. No action was retried automatically.\n')
	process.exitCode = 1
})
