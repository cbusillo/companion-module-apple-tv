import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
const MAX_FRAME = 16384
export type Reply = {
	id: number
	state?: string
	capabilities?: string[]
	error?: string
	values?: Record<string, string>
}
export class Transport {
	private child: ChildProcessWithoutNullStreams | undefined
	private pending = new Map<
		number,
		{ resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>()
	private sequence = 0
	private buffer = ''
	constructor(private readonly failed: () => void) {}
	start(executable: string, args: string[]): void {
		this.stop()
		const child = spawn(executable, args, { stdio: 'pipe', shell: false })
		this.child = child
		child.stderr.resume() // Never log library errors which may contain private target data.
		const fail = (): void => {
			if (this.child === child) {
				this.stop()
				this.failed()
			}
		}
		child.on('error', fail)
		child.stdin.on('error', fail)
		child.on('exit', fail)
		child.stdout.setEncoding('utf8')
		child.stdout.on('data', (chunk: string) => {
			if (this.child !== child) return
			this.buffer += chunk
			if (Buffer.byteLength(this.buffer) > MAX_FRAME * 4) {
				fail()
				return
			}
			let end: number
			while ((end = this.buffer.indexOf('\n')) >= 0) {
				const line = this.buffer.slice(0, end)
				if (Buffer.byteLength(line) + 1 > MAX_FRAME) {
					fail()
					return
				}
				this.buffer = this.buffer.slice(end + 1)
				try {
					const reply = JSON.parse(line) as Reply
					if (
						!Number.isInteger(reply.id) ||
						(reply.values !== undefined &&
							(!reply.values ||
								typeof reply.values !== 'object' ||
								Array.isArray(reply.values) ||
								!Object.values(reply.values).every((v) => typeof v === 'string'))) ||
						(reply.capabilities !== undefined &&
							(!Array.isArray(reply.capabilities) || !reply.capabilities.every((c) => typeof c === 'string')))
					) {
						fail()
						return
					}
					if (reply.id === 0 && reply.state === 'offline') {
						fail()
						return
					}
					const p = this.pending.get(reply.id)
					if (p) {
						this.pending.delete(reply.id)
						clearTimeout(p.timer)
						p.resolve(reply)
					}
				} catch {
					fail()
					return
				}
			}
		})
	}
	async request(value: Record<string, unknown>, timeout = 15000): Promise<Reply> {
		const child = this.child
		if (!child || this.pending.size >= 1) return Promise.reject(new Error('not_available'))
		const id = ++this.sequence
		const frame = JSON.stringify({ ...value, id }) + '\n'
		if (Buffer.byteLength(frame) > MAX_FRAME) return Promise.reject(new Error('oversized_request'))
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.stop()
				this.failed()
			}, timeout)
			this.pending.set(id, { resolve, reject, timer })
			child.stdin.write(frame, (error) => {
				if (error && this.child === child) {
					this.stop()
					this.failed()
				}
			})
		})
	}
	stop(): void {
		const child = this.child
		this.child = undefined
		this.buffer = ''
		for (const p of this.pending.values()) {
			clearTimeout(p.timer)
			p.reject(new Error('session_closed'))
		}
		this.pending.clear()
		if (child) {
			child.stdin.end()
			child.kill('SIGTERM')
			const timer = setTimeout(() => {
				if (child.exitCode === null) child.kill('SIGKILL')
			}, 1000)
			timer.unref()
			child.once('exit', () => clearTimeout(timer))
		}
	}
}
