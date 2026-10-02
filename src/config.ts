import type { SomeCompanionConfigField } from '@companion-module/base'
export type ModuleConfig = {
	enabled: boolean
	deviceId: string
	pair?: boolean
	refresh?: boolean
	python?: string
	credentialFile?: string
	personalOutputName?: string
	personalOutputId?: string
}
export type DeviceChoice = { id: string; label: string }
export function GetConfigFields(devices: DeviceChoice[] = [], selected = ''): SomeCompanionConfigField[] {
	const choices = [{ id: '', label: 'Select an Apple TV' }, ...devices]
	if (selected && !devices.some((device) => device.id === selected))
		choices.push({ id: selected, label: 'Saved Apple TV (currently undiscovered)' })
	return [
		{ type: 'checkbox', id: 'enabled', label: 'Enable Apple TV connection', default: true, width: 12 },
		{ type: 'dropdown', id: 'deviceId', label: 'Apple TV', choices, default: '', width: 12, minChoicesForSearch: 6 },
		{ type: 'checkbox', id: 'refresh', label: 'Refresh device list when saving', default: false, width: 12 },
		{ type: 'checkbox', id: 'pair', label: 'Start pairing when saving', default: false, width: 12 },
		{
			type: 'secret-text',
			id: 'pin',
			label: 'Four-digit PIN shown on the TV',
			default: '',
			regex: '/^(?:\\d{4})?$/',
			width: 12,
			description:
				'Select your TV, check Start pairing and Save. Then enter the TV PIN here and Save again. The PIN is cleared after submission.',
		},
		{
			type: 'textinput',
			id: 'personalOutputName',
			label: 'Personal output name contains',
			default: '',
			width: 6,
			description:
				'For example AirPods. Leave empty to disable personal output selection. Matching is case-insensitive; the output must appear once in the TV output list, for example by selecting it once on the TV.',
		},
		{
			type: 'textinput',
			id: 'personalOutputId',
			label: 'Personal output identifier (optional)',
			default: '',
			width: 6,
			description: 'Overrides the name match. Use the output device UID reported by the TV.',
		},
		{
			type: 'static-text',
			id: 'setupHelp',
			label: 'Setup',
			value:
				'Apple TV and Companion must be reachable on the same local network. Pair once here; no Python or terminal setup is needed. Upgrading from the Python module requires a new PIN pairing. Existing buttons keep their command mappings.',
			width: 12,
		},
	]
}
