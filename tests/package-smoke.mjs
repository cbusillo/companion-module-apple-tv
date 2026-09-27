import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

// Keep build artifacts in this worktree, including on hosts with an external worktree policy.
mkdirSync('pkg', { recursive: true })
const temporary = mkdtempSync(resolve('pkg', 'smoke-'))
try {
	const archives = readdirSync('.').filter((name) => /^apple-tv-.*\.tgz$/.test(name))
	const archive = process.argv[2] ?? `apple-tv-${JSON.parse(readFileSync('package.json', 'utf8')).version}.tgz`
	assert.ok(archive && archives.includes(archive), 'Pass the freshly built package archive')
	execFileSync('tar', ['-xzf', resolve(archive), '-C', temporary])
	const root = join(temporary, 'apple-tv')
	assert.equal(existsSync(join(root, 'node_modules')), false)
	const fixture = resolve('tests/fixtures/packaged-module-smoke.mjs')
	execFileSync(
		process.execPath,
		['--experimental-permission', `--allow-fs-read=${root}`, `--allow-fs-read=${fixture}`, fixture, root],
		{ stdio: 'inherit', timeout: 30000 },
	)
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
