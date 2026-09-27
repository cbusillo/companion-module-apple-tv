import { performance } from 'node:perf_hooks'
import type { MetadataSnapshot } from './prototype/metadata.js'

type Playing = MetadataSnapshot['nowPlaying']

/** Anchor reported media time to a monotonic clock; freeze on pause or loss. */
export class PlaybackClock {
	private playing: Playing = { state: 'Unknown' }
	private position?: number
	private at = 0
	constructor(
		private readonly now = (): number => performance.now(),
		private readonly wall = (): number => Date.now(),
	) {}
	observe(next: Playing): void {
		const before = this.playing
		const sameItem =
			before.app === next.app &&
			before.playerId === next.playerId &&
			before.itemId === next.itemId &&
			(next.itemId !== undefined || before.title === next.title)
		const sameReport =
			sameItem &&
			before.reportedPosition === next.reportedPosition &&
			before.positionTimestamp === next.positionTimestamp
		if (sameReport && before.state === next.state && before.playbackRate === next.playbackRate) {
			this.playing = { ...next }
			return
		}
		const current = this.value()
		this.playing = { ...next }
		this.at = this.now()
		if (next.reportedPosition === undefined) {
			this.position = undefined
			return
		}
		if (sameReport && current !== undefined) this.position = current
		else {
			const age = next.positionTimestamp === undefined ? 0 : Math.max(0, this.wall() / 1000 - next.positionTimestamp)
			this.position = next.reportedPosition + age * this.rate()
		}
	}
	private rate(): number {
		const rate = this.playing.playbackRate
		return this.playing.state === 'Playing' && rate !== undefined && Number.isFinite(rate) && rate >= 0 && rate <= 16
			? rate
			: 0
	}
	value(): number | undefined {
		if (this.position === undefined) return undefined
		const position = this.position + (Math.max(0, this.now() - this.at) / 1000) * this.rate()
		const duration = this.playing.duration
		return Math.max(0, duration !== undefined && duration > 0 ? Math.min(duration, position) : position)
	}
}
