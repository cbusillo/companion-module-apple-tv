/** A bounded queue for complete gestures; stale input never waits for reconnect. */
export class CommandNotSent extends Error {}

export class CommandQueue {
	private tail: Promise<void> = Promise.resolve()
	private generation = 0
	private count = 0
	constructor(private readonly now: () => number = () => performance.now()) {}
	get busy(): boolean {
		return this.count > 0
	}
	invalidate(): void {
		this.generation++
	}
	async run<T>(operation: () => Promise<T>, maxAgeMs = 500): Promise<T> {
		if (this.count >= 8) throw new CommandNotSent('Command queue is full; not sent')
		const queuedAt = this.now()
		const generation = this.generation
		this.count++
		const result = this.tail
			.then(async () => {
				if (generation !== this.generation) throw new CommandNotSent('Session changed; command not sent')
				if (this.now() - queuedAt > maxAgeMs) throw new CommandNotSent('Command expired; not sent')
				return operation()
			})
			.finally(() => {
				this.count--
			})
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
}
