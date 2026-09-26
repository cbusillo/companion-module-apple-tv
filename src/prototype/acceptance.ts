/** Prepared physical test. Call only after the owner is watching the TV. */
import { setTimeout as delay } from 'node:timers/promises'
import type { NodeController, RemoteAction } from './controller.js'

type Controller = Pick<NodeController, 'perform' | 'state' | 'reconnects' | 'queryPower' | 'queryVolume' | 'listApps'>
export type AcceptanceMode = 'close-app' | 'power' | 'wake' | 'remaining'
type Event = {
	stage: string
	result: string
	action?: RemoteAction
	volume?: number
	expected?: 'On' | 'Off'
	attempt?: number
}
type Options = {
	appName: string
	mode?: AcceptanceMode
	signal: AbortSignal
	record: (event: Event) => void
	pause?: (ms: number) => Promise<void>
}

export class PilotStopped extends Error {}

export function previewAcceptance(appName: string, mode: AcceptanceMode = 'close-app'): string[] {
	const powerOnly = mode === 'power' || mode === 'wake'
	return [
		...(mode === 'remaining' ? ['Volume down one step, then up one step'] : []),
		...(!powerOnly ? [`Open ${appName}, open App Switcher, then swipe up to close the focused app`] : []),
		...(mode === 'wake' ? ['Start with Apple TV already Off, request Wake, and verify On; no Sleep is sent'] : []),
		...(mode === 'remaining' || mode === 'power'
			? ['Put Apple TV to sleep, verify Off, then wake it and verify On']
			: []),
		...(powerOnly
			? [
					'Wake queries current power and sends Home once only when Off; there is no recovery retry',
					'After On is confirmed, request Wake again; an already-awake TV must receive no button and stay unchanged',
				]
			: []),
		'Five-second observation pauses; stop on error or connection loss; no command retries',
	]
}

export async function runAcceptance(controller: Controller, options: Options): Promise<void> {
	const pause = options.pause ?? (async (ms) => delay(ms, undefined, { signal: options.signal }))
	const reconnects = controller.reconnects
	const check = (): void => {
		options.signal.throwIfAborted()
		if (controller.state !== 'ready' || controller.reconnects !== reconnects)
			throw new PilotStopped('Connection changed; remaining controls were not sent')
	}
	const observe = async (): Promise<void> => {
		await pause(5000)
		check()
	}
	const step = async (stage: string, action: RemoteAction): Promise<void> => {
		check()
		options.record({ stage, action, result: 'sending' })
		await controller.perform(action)
		options.record({ stage, action, result: 'action completed; physical result unverified' })
		await observe()
	}
	const expectPower = async (expected: 'On' | 'Off'): Promise<void> => {
		for (let attempt = 0; attempt < 10; attempt++) {
			check()
			const result = await controller.queryPower()
			check()
			options.record({ stage: 'power report', result, expected, attempt: attempt + 1 })
			if (result === expected) return
			await pause(1000)
		}
		throw new PilotStopped(`Power did not report ${expected} within the observation window`)
	}
	const wakeSequence = async (): Promise<void> => {
		await step('wake', { kind: 'power', state: 'On' })
		await expectPower('On')
		if (options.mode === 'power' || options.mode === 'wake') {
			await step('wake while already On', { kind: 'power', state: 'On' })
			await expectPower('On')
		}
	}
	const powerSequence = async (): Promise<void> => {
		check()
		if ((await controller.queryPower()) !== 'On') throw new PilotStopped('Start with the Apple TV awake')
		await step('sleep', { kind: 'power', state: 'Off' })
		await expectPower('Off')
		await wakeSequence()
	}

	check()
	if (options.mode === 'power') return powerSequence()
	if (options.mode === 'wake') {
		const current = await controller.queryPower()
		check()
		options.record({ stage: 'initial power', result: current })
		if (current !== 'Off') throw new PilotStopped('Start with the Apple TV already asleep')
		return wakeSequence()
	}
	if (!options.appName.trim()) throw new PilotStopped('Choose an app to close')
	const apps = (await controller.listApps()).filter((app) => app.name === options.appName)
	if (apps.length !== 1) throw new PilotStopped('App name must match exactly one installed app')
	check()
	if ((await controller.queryPower()) !== 'On') throw new PilotStopped('Start with the Apple TV awake')
	check()
	if (options.mode === 'remaining') {
		const volume = await controller.queryVolume()
		if (!Number.isFinite(volume) || volume < 5 || volume > 95)
			throw new PilotStopped('Start with reported volume between 5 and 95 percent to avoid an end stop')
		options.record({ stage: 'initial volume', result: 'reported', volume })
		await step('volume down', { kind: 'button', button: 'volumeDown' })
		await step('volume up', { kind: 'button', button: 'volumeUp' })
		const after = await controller.queryVolume()
		options.record({ stage: 'final volume', result: 'reported; physical result unverified', volume: after })
	}
	// Foreground the exact discovered app before entering the switcher.
	await step('open selected app', { kind: 'launch', bundleId: apps[0].id })
	await step('App Switcher', { kind: 'button', button: 'appSwitcher' })
	await step('close focused app', { kind: 'swipe', direction: 'up' })
	if (options.mode !== 'remaining') return
	await powerSequence()
}
