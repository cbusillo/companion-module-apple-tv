import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteActions } from '../dist/actions.js'
import { buildPresets } from '../dist/presets.js'

test('Remote presets follow command table labels, including newly added commands', () => {
	const addedId = 'syntheticCommand'
	remoteActions[addedId] = { action: { kind: 'button', button: 'select' }, preset: { name: 'Synthetic', text: 'Test' } }
	try {
		const { structure, presets } = buildPresets('Synthetic TV', [])
		const ids = structure.find((section) => section.id === 'remote').definitions
		const commands = Object.entries(remoteActions).filter(([, { preset }]) => preset)
		assert.deepEqual(
			ids,
			commands.map(([id]) => `remote_${id}`),
		)
		for (const [id, { preset }] of commands) {
			const button = presets[`remote_${id}`]
			assert.equal(button.name, preset.name)
			assert.equal(button.style.text, preset.text)
			assert.deepEqual(button.steps[0].down, [{ actionId: 'command', options: { command: id } }])
		}
	} finally {
		delete remoteActions[addedId]
	}
})
