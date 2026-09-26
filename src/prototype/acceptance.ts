/** Prepared physical test. Call only after the owner is watching the TV. */
import { setTimeout as delay } from 'node:timers/promises'
import type { NodeController, RemoteAction } from './controller.js'

type Controller = Pick<
	NodeController,
	| 'perform'
	| 'state'
	| 'reconnects'
	| 'audioRevision'
	| 'audioOutputIdentity'
	| 'feedback'
	| 'observe'
	| 'queryPower'
	| 'queryVolume'
	| 'listApps'
>
export type AcceptanceMode = 'close-app' | 'power' | 'wake' | 'volume' | 'audio' | 'audio-output' | 'remaining'
type Event = {
	stage: string
	result: string
	action?: RemoteAction
	volume?: number
	mute?: 'Muted' | 'Unmuted' | 'Unavailable'
	expected?: 'On' | 'Off'
	attempt?: number
}
type Options = {
	appName: string
	mode?: AcceptanceMode
	sleepSeconds?: number
	signal: AbortSignal
	record: (event: Event) => void
	pause?: (ms: number) => Promise<void>
}

export class PilotStopped extends Error {}

function sleepWait(mode: AcceptanceMode, seconds?: number): number {
	if (seconds !== undefined && mode !== 'power' && mode !== 'remaining')
		throw new RangeError('Sleep wait is only available in power or remaining mode')
	const value = seconds ?? 5
	if (!Number.isInteger(value) || value < 5 || value > 30) throw new RangeError('Sleep wait must be 5–30 whole seconds')
	return value * 1000
}

export function previewAcceptance(
	appName: string,
	mode: AcceptanceMode = 'close-app',
	sleepSeconds?: number,
): string[] {
	const sleepMs = sleepWait(mode, sleepSeconds)
	const powerOnly = mode === 'power' || mode === 'wake'
	return [
		...(mode === 'audio-output'
			? [
					'Mute once, then observe the owner switching to another audio output and back within three minutes',
					'Confirm the saved mute level clears on the changed output and stays cleared on return; observe five more seconds',
					'No further volume or routing controls are sent; restore a comfortable volume with the normal remote afterward',
				]
			: []),
		...(mode === 'audio'
			? [
					'Keep the same audio output: lower volume five percentage points, restore it, mute, then unmute',
					'Each volume write needs a new matching TV volume report; any output change stops the remaining steps',
				]
			: []),
		...(mode === 'remaining' || mode === 'volume'
			? ['Volume down one step, then up one step; report before and after each step']
			: []),
		...(mode === 'close-app' || mode === 'remaining'
			? [`Open ${appName}, open App Switcher, then swipe up to close the focused app`]
			: []),
		...(mode === 'wake' ? ['Start with Apple TV already Off, request Wake, and verify On; no Sleep is sent'] : []),
		...(mode === 'remaining' || mode === 'power'
			? [`Put Apple TV to sleep, wait ${sleepMs / 1000} seconds, verify Off, then wake it and verify On`]
			: []),
		...(powerOnly
			? [
					'Wake queries current power and sends Home once only when Off; there is no recovery retry',
					'After On is confirmed, request Wake again; an already-awake TV must receive no button and stay unchanged',
				]
			: []),
		'Observation pauses are five seconds except the stated Sleep wait; stop on error or connection loss; no command retries',
	]
}

export async function runAcceptance(controller: Controller, options: Options): Promise<void> {
	const sleepMs = sleepWait(options.mode ?? 'close-app', options.sleepSeconds)
	const pause = options.pause ?? (async (ms) => delay(ms, undefined, { signal: options.signal }))
	const reconnects = controller.reconnects
	const check = (): void => {
		options.signal.throwIfAborted()
		if (controller.state !== 'ready' || controller.reconnects !== reconnects)
			throw new PilotStopped('Connection changed; remaining controls were not sent')
	}
	const step = async (stage: string, action: RemoteAction, waitMs = 5000): Promise<void> => {
		check()
		options.record({ stage, action, result: 'sending' })
		await controller.perform(action)
		options.record({ stage, action, result: 'action completed; physical result unverified' })
		await pause(waitMs)
		check()
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
		await step('sleep', { kind: 'power', state: 'Off' }, sleepMs)
		await expectPower('Off')
		await wakeSequence()
	}
	const volumeSequence = async (): Promise<void> => {
		check()
		const volume = await controller.queryVolume()
		check()
		if (!Number.isFinite(volume) || volume < 5 || volume > 95)
			throw new PilotStopped('Start with reported volume between 5 and 95 percent to avoid an end stop')
		options.record({ stage: 'initial volume', result: 'reported', volume })
		await step('volume down', { kind: 'button', button: 'volumeDown' })
		const lower = await controller.queryVolume()
		check()
		options.record({ stage: 'volume after down', result: 'reported; physical result unverified', volume: lower })
		await step('volume up', { kind: 'button', button: 'volumeUp' })
		const after = await controller.queryVolume()
		check()
		options.record({ stage: 'final volume', result: 'reported; physical result unverified', volume: after })
	}
	const audioSequence = async (): Promise<void> => {
		const revision = controller.audioRevision
		const sameOutput = (): void => {
			check()
			if (revision < 0 || controller.audioRevision !== revision)
				throw new PilotStopped('Audio output changed; remaining controls were not sent')
		}
		const initial = await controller.queryVolume()
		sameOutput()
		if (!Number.isFinite(initial) || initial < 10 || initial > 95)
			throw new PilotStopped('Start with authenticated volume between 10 and 95 percent')
		options.record({ stage: 'initial volume', result: 'authenticated report', volume: initial })
		const actions: [string, RemoteAction, number][] = [
			['lower absolute volume', { kind: 'volume', percent: initial - 5 }, initial - 5],
			['restore initial volume', { kind: 'volume', percent: initial }, initial],
			['mute', { kind: 'mute' }, 0],
			['unmute', { kind: 'mute' }, initial],
		]
		for (const [stage, action, expected] of actions) {
			sameOutput()
			await step(stage, action)
			sameOutput()
			const volume = await controller.queryVolume()
			sameOutput()
			options.record({ stage, result: 'authenticated report; physical result unverified', volume })
			if (Math.abs(volume - expected) >= 0.01)
				throw new PilotStopped('Volume changed during the observation pause; remaining controls were not sent')
		}
	}
	const outputSequence = async (): Promise<void> => {
		const originalOutput = controller.audioOutputIdentity
		const revision = controller.audioRevision
		const initial = await controller.queryVolume()
		check()
		if (originalOutput === undefined || revision < 0 || controller.audioRevision !== revision)
			throw new PilotStopped('Start with one stable authenticated audio output')
		if (!Number.isFinite(initial) || initial < 10 || initial > 95)
			throw new PilotStopped('Start with authenticated volume between 10 and 95 percent')
		options.record({ stage: 'initial volume', result: 'authenticated report', volume: initial })
		const action: RemoteAction = { kind: 'mute' }
		options.record({ stage: 'mute original output', result: 'sending', action })
		await controller.perform(action)
		check()
		if (
			controller.audioRevision !== revision ||
			controller.feedback?.mute !== 'Muted' ||
			controller.feedback.volume !== 0
		)
			throw new PilotStopped('Initial mute was not confirmed on the original output')
		options.record({ stage: 'mute original output', result: 'confirmed; saved level armed', volume: 0, mute: 'Muted' })
		options.record({ stage: 'manual output round trip', result: 'waiting up to 180 seconds; no further controls' })
		let changedOutput = false
		let returned = false
		let failure: Error | undefined
		const inspectOutput = (): void => {
			check()
			const identity = controller.audioOutputIdentity
			const feedback = controller.feedback
			if (!feedback) throw new PilotStopped('Audio feedback became unavailable')
			if ((changedOutput || (identity !== undefined && identity !== originalOutput)) && feedback.mute === 'Muted')
				throw new PilotStopped('Saved mute level survived an output change')
			if (identity === undefined) return
			if (identity !== originalOutput) {
				if (returned) throw new PilotStopped('Audio output changed again after returning')
				if (!changedOutput) {
					changedOutput = true
					options.record({ stage: 'changed output', result: 'saved mute level cleared', mute: feedback.mute })
				}
			} else if (changedOutput && !returned) {
				returned = true
				options.record({
					stage: 'original output returned',
					result: 'saved mute level remains cleared',
					mute: feedback.mute,
				})
			} else if (!changedOutput && feedback.volume !== null && feedback.volume > 0) {
				throw new PilotStopped('Volume changed before the output switch; repeat requires a newly prepared mute')
			}
		}
		// Never throw through the metadata emitter; surface errors in the awaited pilot.
		const observe = (): void => {
			if (failure) return
			try {
				inspectOutput()
			} catch (error) {
				failure = error instanceof Error ? error : new PilotStopped('Output observation failed', { cause: error })
			}
		}
		const checkObservation = (): void => {
			observe()
			if (failure) throw failure
		}
		const unsubscribe = controller.observe(observe)
		try {
			for (let elapsed = 0; elapsed < 180000 && !returned; elapsed += 500) {
				checkObservation()
				if (!returned) await pause(500)
			}
			checkObservation()
			if (!returned) throw new PilotStopped('No complete output round trip was observed within 180 seconds')
			await pause(5000)
			checkObservation()
			if (controller.audioOutputIdentity !== originalOutput)
				throw new PilotStopped('Original audio output is not confirmed at the end of observation')
			options.record({
				stage: 'output round trip complete',
				result: 'saved level stayed cleared; restore volume with the normal remote; physical result unverified',
				mute: controller.feedback?.mute,
			})
		} finally {
			unsubscribe()
		}
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
	if (options.mode === 'volume' || options.mode === 'audio' || options.mode === 'audio-output') {
		if ((await controller.queryPower()) !== 'On') throw new PilotStopped('Start with the Apple TV awake')
		check()
		if (options.mode === 'audio-output') return outputSequence()
		return options.mode === 'audio' ? audioSequence() : volumeSequence()
	}
	if (!options.appName.trim()) throw new PilotStopped('Choose an app to close')
	const apps = (await controller.listApps()).filter((app) => app.name === options.appName)
	if (apps.length !== 1) throw new PilotStopped('App name must match exactly one installed app')
	check()
	if ((await controller.queryPower()) !== 'On') throw new PilotStopped('Start with the Apple TV awake')
	check()
	if (options.mode === 'remaining') await volumeSequence()
	// Foreground the exact discovered app before entering the switcher.
	await step('open selected app', { kind: 'launch', bundleId: apps[0].id })
	await step('App Switcher', { kind: 'button', button: 'appSwitcher' })
	await step('close focused app', { kind: 'swipe', direction: 'up' })
	if (options.mode !== 'remaining') return
	await powerSequence()
}
