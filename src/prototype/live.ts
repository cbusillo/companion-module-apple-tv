/** Separate development CLI; never imported by the installed Companion module. */
import { parseArgs } from 'node:util'
import { CompanionPairSetup, scan, type DiscoveredDevice, type HAPCredentials } from 'node-appletv-remote'
import { CompanionRequestRejected } from './companion.js'
import { loadTestCredentials, prepareCredentialFile, saveTestCredentials } from './credentials.js'
import { bounded, withCompanionSession } from './session.js'

const HELP = `Separate Node Companion test (Node 22):
  node dist/prototype/live.js scan
  node dist/prototype/live.js pair --device DEVICE_ID --credentials /private/directory/test.json
  node dist/prototype/live.js check --credentials /private/directory/test.json
  node dist/prototype/live.js launch --credentials /private/directory/test.json --app BUNDLE_ID

Pair displays a PIN on the selected TV, reads it without echo, saves new credentials
with mode 0600, then checks a new session and app discovery. Check is read-only.
Launch sends one app-launch request. No control is retried. Ctrl-C cancels.
Use a separate private directory outside any repository; never supply production credentials.
`

async function readPin(signal: AbortSignal): Promise<string> {
	if (!process.stdin.isTTY) throw new Error('PIN entry requires an interactive terminal')
	process.stdout.write('Enter the PIN displayed on the selected Apple TV (input hidden): ')
	process.stdin.setRawMode(true)
	process.stdin.setEncoding('utf8')
	process.stdin.resume()
	let onData: (chunk: string) => void = () => {}
	try {
		return await bounded(
			async () =>
				new Promise<string>((resolve, reject) => {
					let input = ''
					onData = (chunk) => {
						for (const char of chunk) {
							if (char === '\u0003' || char === '\u0004') return reject(new Error('PIN entry cancelled'))
							if (char === '\r' || char === '\n') {
								if (/^\d{4}$/.test(input)) return resolve(input)
								return reject(new Error('Expected a four-digit PIN'))
							}
							if (char === '\u007f') input = input.slice(0, -1)
							else if (/^\d$/.test(char) && input.length < 4) input += char
						}
					}
					process.stdin.on('data', onData)
				}),
			180000,
			signal,
		)
	} finally {
		process.stdin.off('data', onData)
		process.stdin.setRawMode(false)
		process.stdin.pause()
		process.stdout.write('\n')
	}
}

function selectTarget(devices: DiscoveredDevice[], deviceId: string): DiscoveredDevice & { companionPort: number } {
	const matches = devices.filter((device) => device.deviceId === deviceId && device.model.startsWith('AppleTV'))
	if (matches.length !== 1 || !matches[0].companionPort) throw new Error('Selected TV has no unique Companion service')
	return matches[0] as DiscoveredDevice & { companionPort: number }
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			device: { type: 'string' },
			credentials: { type: 'string' },
			app: { type: 'string' },
			help: { type: 'boolean' },
		},
	})
	const [command] = positionals
	if (values.help || !command) {
		process.stdout.write(HELP)
		return
	}
	if (positionals.length !== 1 || !['scan', 'pair', 'check', 'launch'].includes(command))
		throw new Error('Invalid command')
	if (command !== 'scan' && !values.credentials) throw new Error('A separate credential file is required')
	if (command === 'pair' && !values.device) throw new Error('Select an exact device ID from scan')
	if (command === 'launch' && (!values.app?.trim() || values.app.length > 255))
		throw new Error('App bundle ID required')
	const controller = new AbortController()
	const onSignal = (): void => controller.abort()
	process.on('SIGINT', onSignal)
	process.on('SIGTERM', onSignal)
	let stage = 'discovery'
	try {
		const existing =
			command === 'check' || command === 'launch' ? await loadTestCredentials(values.credentials!) : undefined
		if (command === 'pair') await prepareCredentialFile(values.credentials!)
		const devices = await bounded(async () => scan({ timeout: 5000 }), 7000, controller.signal)
		if (command === 'scan') {
			for (const device of devices.filter((entry) => entry.model.startsWith('AppleTV'))) {
				process.stdout.write(
					`${JSON.stringify({ name: device.name, id: device.deviceId, address: device.address, companionPort: device.companionPort })}\n`,
				)
			}
			return
		}
		const target = selectTarget(devices, existing?.deviceId ?? values.device!)
		let credentials: HAPCredentials
		if (command === 'pair') {
			stage = 'pairing start'
			const pairing = new CompanionPairSetup(target.address, target.companionPort)
			try {
				await bounded(async () => pairing.start(), 15000, controller.signal)
				stage = 'PIN entry'
				const pin = await readPin(controller.signal)
				stage = 'pairing finish'
				credentials = await bounded(async () => pairing.finish(pin), 15000, controller.signal)
			} finally {
				pairing.destroy()
			}
			stage = 'credential save'
			await saveTestCredentials(values.credentials!, { deviceId: target.deviceId, credentials })
			process.stdout.write('New test credentials saved privately. Verifying a separate connection.\n')
		} else credentials = existing!.credentials
		stage = 'session / app discovery / teardown'
		const result = await withCompanionSession(
			target,
			credentials,
			controller.signal,
			async (commands) => {
				stage = 'app discovery'
				const apps = await commands.listApps()
				if (command === 'launch') {
					if (!apps.some((app) => app.id === values.app))
						throw new Error('Requested app is not in the discovered app list')
					stage = 'app launch (delivery uncertain on failure; do not retry automatically)'
					await commands.launchApp(values.app!)
					return { appCount: apps.length, launchAcknowledged: true, physicalResult: 'unverified' }
				}
				let power: 'On' | 'Off' | 'Unknown' = 'Unknown'
				try {
					stage = 'power-state query'
					power = await commands.readPower()
				} catch (error) {
					if (!(error instanceof CompanionRequestRejected)) throw error
				}
				return { appCount: apps.length, power }
			},
			undefined,
			(nextStage) => {
				stage = nextStage
			},
		)
		process.stdout.write(`${JSON.stringify({ session: 'verified', ...result, teardown: 'acknowledged' })}\n`)
	} catch (error) {
		// Provider errors can contain identifiers; keep raw payloads and credentials out of logs.
		const reason = error instanceof Error && /timeout|timed out/i.test(error.message) ? ' (timeout)' : ''
		throw new Error(`Test failed during ${stage}${reason}. No automatic retry was attempted.`, { cause: error })
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : 'Test failed'}\n`)
	process.exitCode = 1
})
