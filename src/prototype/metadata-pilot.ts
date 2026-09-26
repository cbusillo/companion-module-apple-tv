import { Worker } from 'node:worker_threads'
import type { MetadataSnapshot } from './metadata.js'

type Observer = Pick<Worker, 'on' | 'terminate'> & Partial<Pick<Worker, 'stdout' | 'stderr'>>
export type MetadataPilotOptions = {
	credentialsPath: string
	seconds: number
	signal: AbortSignal
	onSnapshot: (snapshot: MetadataSnapshot) => void
}

/** A bounded observation session; no controls, PIN pairing, reconnect or retry. */
export async function observeMetadata(
	options: MetadataPilotOptions,
	createWorker: (path: string) => Observer = (credentialsPath) =>
		new Worker(new URL('./metadata-worker.js', import.meta.url), {
			workerData: { credentialsPath },
			stdout: true,
			stderr: true,
		}),
	startupMs = 20000,
): Promise<void> {
	if (!Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 60)
		throw new Error('Observation duration must be 5-60 seconds')
	options.signal.throwIfAborted()
	const worker = createWorker(options.credentialsPath)
	// The candidate library logs private transport addresses. Consume without forwarding.
	worker.stdout?.resume()
	worker.stderr?.resume()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort = (): void => {}
	try {
		await new Promise<void>((resolve, reject) => {
			let ready = false
			let ended = false
			const finish = (error?: Error): void => {
				if (ended) return
				ended = true
				if (error) reject(error)
				else resolve()
			}
			onAbort = (): void => finish(new Error('Metadata observation cancelled'))
			options.signal.addEventListener('abort', onAbort, { once: true })
			if (options.signal.aborted) onAbort()
			timer = setTimeout(() => finish(new Error('Metadata connection timed out')), startupMs)
			worker.on('error', () => finish(new Error('Metadata worker failed')))
			worker.on('exit', () => finish(new Error('Metadata connection ended')))
			worker.on('message', (message: { kind: string; snapshot?: MetadataSnapshot }) => {
				if (ended) return
				if (message.kind === 'snapshot' && message.snapshot) {
					try {
						options.onSnapshot(message.snapshot)
					} catch {
						finish(new Error('Metadata report failed'))
					}
				} else if (message.kind === 'failed') finish(new Error('Metadata connection failed'))
				else if (message.kind === 'ready' && !ready) {
					ready = true
					clearTimeout(timer)
					timer = setTimeout(() => finish(), options.seconds * 1000)
				}
			})
		})
	} finally {
		clearTimeout(timer)
		options.signal.removeEventListener('abort', onAbort)
		// Always reap sockets/timers, including a late connect after cancellation.
		await worker.terminate()
	}
}
