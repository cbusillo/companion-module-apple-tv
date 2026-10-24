import { combineRgb, type CompanionPresetDefinitions, type CompanionPresetSection } from '@companion-module/base'
import { remoteActions } from './actions.js'
import type { ModuleSchema } from './main.js'

const white = combineRgb(255, 255, 255)
const black = combineRgb(0, 0, 0)
const green = combineRgb(0, 153, 0)

type Presets = CompanionPresetDefinitions<ModuleSchema>

function command(name: string, text: string, commandId: string, size: 'auto' | '18' | '24' = 'auto'): Presets[string] {
	return {
		type: 'simple',
		name,
		style: { text, size, color: white, bgcolor: black },
		steps: [{ down: [{ actionId: 'command', options: { command: commandId } }], up: [] }],
		feedbacks: [],
	}
}

/** Ready-made buttons. Variable text uses the connection label so it follows renames. */
export function buildPresets(
	label: string,
	apps: { id: string; name: string }[],
): { structure: CompanionPresetSection<ModuleSchema>[]; presets: Presets } {
	const powerOn = { feedbackId: 'powerOn' as const, options: {}, style: { bgcolor: green, color: white } }
	const presets: Presets = {
		power_state: {
			type: 'simple',
			name: 'Power state',
			style: { text: `Apple TV\\n$(${label}:power)`, size: 'auto', color: white, bgcolor: black },
			steps: [{ down: [{ actionId: 'command', options: { command: 'power' } }], up: [] }],
			feedbacks: [powerOn],
			notes: 'Shows On, Off or Unknown. Green while the TV is awake. Pressing toggles power.',
		},
		wake: { ...command('Wake', 'Wake', 'wake'), feedbacks: [powerOn] } as Presets[string],
		sleep: command('Sleep', 'Sleep', 'sleep'),
		now_playing: {
			type: 'simple',
			name: 'Now playing',
			style: {
				text: `$(${label}:title)\\n$(${label}:elapsed)`,
				size: '14',
				color: white,
				bgcolor: black,
			},
			steps: [{ down: [{ actionId: 'command', options: { command: 'playPause' } }], up: [] }],
			feedbacks: [],
			notes: 'Title and elapsed time of what is playing. Pressing plays or pauses.',
		},
	}
	const remoteIds: string[] = []
	for (const [id, { preset }] of Object.entries(remoteActions)) {
		if (!preset) continue
		remoteIds.push(`remote_${id}`)
		presets[`remote_${id}`] = command(preset.name, preset.text, id)
	}
	const appIds: string[] = []
	for (const app of apps) {
		const id = `app_${app.id.replace(/[^A-Za-z0-9]/g, '_')}`
		appIds.push(id)
		presets[id] = {
			type: 'simple',
			name: `Open ${app.name}`,
			style: { text: app.name, size: 'auto', color: white, bgcolor: black },
			steps: [{ down: [{ actionId: 'launchApp', options: { appId: app.id } }], up: [] }],
			feedbacks: [],
		}
	}
	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{ id: 'power', name: 'Power', definitions: ['power_state', 'wake', 'sleep'] },
		{ id: 'remote', name: 'Remote', definitions: remoteIds },
		{
			id: 'apps',
			name: 'Apps',
			description: appIds.length ? undefined : 'Connect to the Apple TV to list its apps',
			definitions: appIds,
		},
		{ id: 'now_playing', name: 'Now Playing', definitions: ['now_playing'] },
	]
	return { structure, presets }
}
