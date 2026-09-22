export const displayDefaults = {
	volume: '',
	mute_state: 'Unavailable',
	power: 'Unknown',
	metadata_state: 'Connecting',
	title: 'Nothing Playing',
	artist: '',
	app: '',
	playback_state: 'Idle',
	position: '0',
	duration: '0',
	elapsed: '',
	remaining: '',
	progress: '0',
}
export type DisplayValues = typeof displayDefaults

export function timeText(seconds: number): string {
	const n = Math.max(0, Math.floor(seconds))
	const hours = Math.floor(n / 3600)
	const minutes = Math.floor(n / 60) % 60
	const tail = `${minutes.toString().padStart(hours ? 2 : 1, '0')}:${(n % 60).toString().padStart(2, '0')}`
	return hours ? `${hours}:${tail}` : tail
}

export function displayValues(values: Record<string, string>): Partial<DisplayValues> {
	const output: Partial<DisplayValues> = {}
	for (const key of Object.keys(displayDefaults) as (keyof DisplayValues)[]) {
		if (typeof values[key] === 'string') output[key] = values[key].slice(0, 240)
	}
	if (values.position !== undefined && values.duration !== undefined) {
		const position = Number(values.position)
		const duration = Number(values.duration)
		if (Number.isFinite(position) && position >= 0 && Number.isFinite(duration) && duration >= 0) {
			output.elapsed = timeText(position)
			output.remaining = duration > 0 ? timeText(Math.max(0, duration - position)) : ''
			output.progress = duration > 0 ? String(Math.max(0, Math.min(100, (position / duration) * 100))) : '0'
		}
	}
	return output
}
