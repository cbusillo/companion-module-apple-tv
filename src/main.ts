import {
	InstanceBase,
	InstanceStatus,
	combineRgb,
	type SomeCompanionConfigField,
	type CompanionStaticUpgradeScript,
	type CompanionUpgradeContext,
	type CompanionStaticUpgradeProps,
	type CompanionStaticUpgradeResult,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { displayDefaults, type DisplayValues } from './display.js'
import { NodeBackend, type BackendOptions, type PersonalOutputValues, type SetupState } from './node-backend.js'
import type { RouteTarget } from './personal-output.js'
import type { ModuleSecrets } from './node-credentials.js'
import { remoteActions } from './actions.js'
import { MRPMessage } from 'node-appletv-remote'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: {
		command: { options: { command: string } }
		launchApp: { options: { appId: string } }
		personalOutput: { options: { target: string } }
	}
	feedbacks: { personalOutputActive: { type: 'boolean'; options: Record<string, never> } }
	variables: { connection: string; last_result: string } & DisplayValues & PersonalOutputValues
}

const routeTargets: Record<string, RouteTarget> = { toggle: 'toggle', personal: 'personal', default: 'default' }

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> => ({
		updatedConfig:
			props.config && !props.config.deviceId && (props.config.python || props.config.credentialFile)
				? { ...props.config, deviceId: '', enabled: false, pair: false, refresh: false }
				: null,
		updatedActions: [],
		updatedFeedbacks: [],
	}),
]

const statuses: Record<SetupState, InstanceStatus> = {
	disabled: InstanceStatus.Disconnected,
	unpaired: InstanceStatus.BadConfig,
	discovering: InstanceStatus.Connecting,
	pairing: InstanceStatus.Connecting,
	pin: InstanceStatus.BadConfig,
	verifying: InstanceStatus.Connecting,
	connecting: InstanceStatus.Connecting,
	ready: InstanceStatus.Ok,
	reconnecting: InstanceStatus.ConnectionFailure,
	error: InstanceStatus.ConnectionFailure,
}

export default class AppleTV extends InstanceBase<ModuleSchema> {
	config: ModuleConfig = { enabled: false, deviceId: '' }
	private backend?: NodeBackend
	private apps: { id: string; name: string }[] = []
	private configurationTasks = new Set<Promise<void>>()
	private configurationVersion = 0
	private destroyed = false
	constructor(
		internal: unknown,
		private readonly backendOptions: BackendOptions = {},
	) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets = {}): Promise<void> {
		this.setVariableDefinitions({
			connection: { name: 'Connection state' },
			last_result: { name: 'Last dispatch result (not physical confirmation)' },
			personal_output_route: {
				name: 'Personal audio output route (Personal, Default, Connecting, Failed or Unavailable)',
			},
			personal_output_name: { name: 'Personal audio output name' },
			...(Object.fromEntries(
				Object.keys(displayDefaults).map((key) => [key, { name: key.replaceAll('_', ' ') }]),
			) as Record<keyof DisplayValues, { name: string }>),
		})
		this.setVariableValues({
			...displayDefaults,
			connection: 'disabled',
			last_result: '',
			personal_output_route: 'Unavailable',
			personal_output_name: '',
		})
		try {
			// Load packaged protocol assets before the user is asked to pair. No message is sent.
			await MRPMessage.clientUpdatesConfig({})
		} catch {
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Module files could not be loaded; reinstall the package')
			this.setVariableValues({ connection: 'error' })
			return
		}
		if (this.destroyed) return
		this.backend = new NodeBackend(
			{
				save: (updated, saved) => {
					this.config = updated
					this.saveConfig(updated, saved)
				},
				status: (state, message) => {
					this.updateStatus(statuses[state], message)
					if (state === 'error') this.log('warn', message)
				},
				values: (values) => this.setVariableValues(values),
				log: (level, message) => this.log(level, message),
				feedback: () => this.checkFeedbacks('personalOutputActive'),
				apps: (apps) => {
					this.apps = apps
					this.defineActions()
				},
			},
			this.backendOptions,
		)
		this.defineActions()
		this.setFeedbackDefinitions({
			personalOutputActive: {
				type: 'boolean',
				name: 'Personal audio output active',
				description: 'True while the TV reports the configured personal output in its audio route',
				defaultStyle: { bgcolor: combineRgb(0, 102, 204), color: combineRgb(255, 255, 255) },
				options: [],
				callback: () => this.backend?.personalOutputActive ?? false,
			},
		})
		await this.configUpdated(config, secrets)
	}
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.backend?.devices, this.config.deviceId)
	}
	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets = {}): Promise<void> {
		this.config = config
		const backend = this.backend
		if (!backend) return
		const version = ++this.configurationVersion
		// Companion's configuration IPC has a shorter deadline than discovery or PIN
		// verification. Acknowledge Save now and publish progress through callbacks.
		const task = backend.configure(config, secrets).catch(() => {
			if (this.backend !== backend || this.configurationVersion !== version) return
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Setup failed; disable the connection and try again')
			this.setVariableValues({ connection: 'error' })
		})
		this.configurationTasks.add(task)
		void task.then(() => this.configurationTasks.delete(task))
	}
	private defineActions(): void {
		this.setActionDefinitions({
			command: {
				name: 'Remote command',
				options: [
					{
						id: 'command',
						type: 'dropdown',
						label: 'Command',
						default: 'select',
						choices: Object.keys(remoteActions).map((id) => ({ id, label: id })),
					},
				],
				callback: async (event) =>
					this.backend?.perform(
						Object.hasOwn(remoteActions, event.options.command) ? remoteActions[event.options.command] : undefined,
					),
			},
			launchApp: {
				name: 'Launch App',
				options: [
					{
						id: 'appId',
						type: 'dropdown',
						label: 'App',
						default: '',
						allowCustom: true,
						choices: this.apps.map((app) => ({ id: app.id, label: `${app.name} (${app.id})` })),
					},
				],
				callback: async (event) => this.backend?.perform({ kind: 'launch', bundleId: event.options.appId }),
			},
			personalOutput: {
				name: 'Personal audio output',
				description:
					'Toggle or select the configured personal output, such as AirPods, as the system audio route. Sends one request; the route variable confirms the result.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Route',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle personal output' },
							{ id: 'personal', label: 'Route to personal output' },
							{ id: 'default', label: 'Route to default output' },
						],
					},
				],
				callback: async (event) => {
					const target = Object.hasOwn(routeTargets, event.options.target)
						? routeTargets[event.options.target]
						: undefined
					if (!target) this.setVariableValues({ last_result: 'unknown output route; not sent' })
					else await this.backend?.selectPersonalOutput(target)
				},
			},
		})
	}
	async destroy(): Promise<void> {
		this.destroyed = true
		const backend = this.backend
		this.backend = undefined
		this.configurationVersion++
		await backend?.stop()
		await Promise.allSettled(this.configurationTasks)
	}
}
