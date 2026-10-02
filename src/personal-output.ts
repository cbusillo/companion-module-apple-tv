import { OutputRouteRejected } from './prototype/metadata-session.js'
import { CommandNotSent } from './prototype/queue.js'

export type PersonalRoute = 'Personal' | 'Default' | 'Connecting' | 'Failed' | 'Unavailable'
export type RouteTarget = 'toggle' | 'personal' | 'default'
export type Output = { id: string; name: string }
/** Remembered from the reported output list; stored only in Companion's connection secrets. */
export type LearnedOutput = { match: string; id: string; name: string }
export type PersonalOutputSettings = { match?: string; id?: string }
/** One authenticated session's view. A new `session` value means any pending request is stale. */
export type OutputLink = {
	session: string
	outputs: Output[]
	send?: (outputDeviceUIDs: readonly string[]) => Promise<boolean>
}
export type RouterHooks = {
	changed(): void
	learned(output: LearnedOutput): void
	result(message: string): void
}
export type RouterOptions = { confirmationMs?: number; failedHoldMs?: number }

type Pending = { want: boolean; session: string; timer: ReturnType<typeof setTimeout> }
type Failure = { session: string; outputs: string; timer: ReturnType<typeof setTimeout> }

const outputKey = (outputs: Output[]): string => JSON.stringify(outputs.map((output) => output.id).sort())

/**
 * Selects a personal output (such as same-account AirPods) as the Apple TV's system audio route.
 *
 * The reported output list is the only confirmation. Each press sends at most one request and
 * nothing is retried. Failed is shown only after the confirmation window, and any later change in
 * the reported outputs (including a late success or a change made on the TV) replaces it.
 */
export class PersonalOutputRouter {
	private match = ''
	private explicitId = ''
	private learnedOutput?: LearnedOutput
	private link?: OutputLink
	private pending?: Pending
	private failure?: Failure
	constructor(
		private readonly hooks: RouterHooks,
		private readonly options: RouterOptions = {},
	) {}

	get enabled(): boolean {
		return this.match.length > 0 || this.explicitId.length > 0
	}

	configure(settings: PersonalOutputSettings, learned?: LearnedOutput): void {
		const match = typeof settings.match === 'string' ? settings.match.trim() : ''
		const explicitId = typeof settings.id === 'string' ? settings.id.trim() : ''
		const valid =
			learned &&
			typeof learned.id === 'string' &&
			learned.id.length > 0 &&
			typeof learned.name === 'string' &&
			typeof learned.match === 'string' &&
			learned.match.toLowerCase() === match.toLowerCase()
		const changed = match !== this.match || explicitId !== this.explicitId
		this.match = match
		this.explicitId = explicitId
		this.learnedOutput = valid ? { match: learned.match, id: learned.id, name: learned.name } : undefined
		if (changed) {
			this.clearPending()
			this.clearFailure()
		}
		this.learn()
		this.hooks.changed()
	}

	/** Apply the latest authenticated output list, or undefined while disconnected. */
	observe(link: OutputLink | undefined): void {
		if (this.pending && link?.session !== this.pending.session) {
			this.clearPending()
			this.hooks.result('connection changed before the output change was confirmed; not retried')
		}
		if (this.failure && (link?.session !== this.failure.session || outputKey(link.outputs) !== this.failure.outputs))
			this.clearFailure()
		this.link = link
		this.learn()
		if (this.pending && link && this.isActive(link) === this.pending.want) {
			const want = this.pending.want
			this.clearPending()
			this.hooks.result(want ? 'personal output confirmed by Apple TV' : 'default output confirmed by Apple TV')
		}
		this.hooks.changed()
	}

	private learn(): void {
		const link = this.link
		if (!link || this.explicitId || !this.match) return
		const needle = this.match.toLowerCase()
		const candidates = link.outputs.filter((output) => output.name.toLowerCase().includes(needle))
		// Never guess between several matching outputs.
		if (candidates.length !== 1) return
		const [output] = candidates
		if (this.learnedOutput?.id === output.id && this.learnedOutput.name === output.name) return
		this.learnedOutput = { match: this.match, id: output.id, name: output.name }
		this.hooks.learned({ ...this.learnedOutput })
	}

	private get personalId(): string | undefined {
		return this.explicitId || this.learnedOutput?.id || undefined
	}

	private isActive(link: OutputLink): boolean {
		const id = this.personalId
		return id !== undefined && link.outputs.some((output) => output.id === id)
	}

	get route(): PersonalRoute {
		const link = this.link
		if (!this.enabled || !link?.send) return 'Unavailable'
		if (this.pending) return 'Connecting'
		if (this.failure) return 'Failed'
		if (!this.personalId) return 'Unavailable'
		return this.isActive(link) ? 'Personal' : 'Default'
	}

	get active(): boolean {
		return this.enabled && this.link !== undefined && this.isActive(this.link)
	}

	get name(): string {
		if (!this.enabled) return ''
		const id = this.personalId
		const reported = id ? this.link?.outputs.find((output) => output.id === id)?.name : undefined
		return reported ?? (this.learnedOutput && this.learnedOutput.id === id ? this.learnedOutput.name : '')
	}

	/** Send at most one request toward the chosen route. Returns a dispatch description. */
	async select(target: RouteTarget): Promise<string> {
		const link = this.link
		if (!this.enabled) return 'personal output not configured; not sent'
		if (!link) return 'not connected; output change not sent'
		if (!link.send) return 'output selection unavailable on this connection; not sent'
		if (this.pending) return 'output change already pending; not sent'
		const personal = this.personalId
		if (!personal) return 'personal output not identified yet; select it once on the TV; not sent'
		const active = this.isActive(link)
		const want = target === 'personal' ? true : target === 'default' ? false : !active
		if (want === active) {
			this.clearFailure()
			this.hooks.changed()
			return want ? 'personal output already active; not sent' : 'default output already active; not sent'
		}
		const outputs = want ? [personal] : link.outputs.map((output) => output.id).filter((id) => id !== personal)
		if (outputs.length === 0) return 'default output not reported; not sent'
		this.clearFailure()
		const pending: Pending = {
			want,
			session: link.session,
			timer: setTimeout(() => this.expire(pending), this.options.confirmationMs ?? 20000),
		}
		this.pending = pending
		this.hooks.changed()
		try {
			const acknowledged = await link.send(outputs)
			if (this.pending !== pending) return 'output change finished or cancelled'
			return acknowledged
				? 'output change acknowledged; waiting for Apple TV to confirm'
				: 'output change sent without acknowledgement; waiting for Apple TV to confirm'
		} catch (error) {
			if (this.pending !== pending) return 'output change finished or cancelled'
			if (error instanceof OutputRouteRejected) {
				this.fail(pending)
				return 'output change rejected by Apple TV; not retried'
			}
			this.clearPending()
			this.hooks.changed()
			return error instanceof CommandNotSent
				? 'not sent; connection changed'
				: 'output change delivery uncertain; connection lost; not retried'
		}
	}

	private expire(pending: Pending): void {
		if (this.pending !== pending) return
		this.fail(pending)
		this.hooks.result('output change not confirmed in time; not retried')
	}

	private fail(pending: Pending): void {
		this.clearPending()
		const link = this.link
		if (link && link.session === pending.session) {
			const failure: Failure = {
				session: pending.session,
				outputs: outputKey(link.outputs),
				timer: setTimeout(() => {
					if (this.failure !== failure) return
					this.failure = undefined
					this.hooks.changed()
				}, this.options.failedHoldMs ?? 10000),
			}
			this.failure = failure
		}
		this.hooks.changed()
	}

	private clearPending(): void {
		if (!this.pending) return
		clearTimeout(this.pending.timer)
		this.pending = undefined
	}

	private clearFailure(): void {
		if (!this.failure) return
		clearTimeout(this.failure.timer)
		this.failure = undefined
	}

	stop(): void {
		this.clearPending()
		this.clearFailure()
		this.link = undefined
		this.hooks.changed()
	}
}
