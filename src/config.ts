import type { SomeCompanionConfigField } from '@companion-module/base'
export type ModuleConfig = { enabled: boolean; python: string; credentialFile: string }
export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'checkbox',
			id: 'enabled',
			label: 'Enable Apple TV connection',
			default: false,
			width: 12,
		},
		{
			type: 'textinput',
			id: 'python',
			label: 'Absolute path to Python with this project’s locked pyatv environment',
			default: '',
			width: 12,
		},
		{
			type: 'textinput',
			id: 'credentialFile',
			label: 'Owner-only credential JSON file (host, identifier, credentials)',
			default: '',
			width: 12,
		},
	]
}
