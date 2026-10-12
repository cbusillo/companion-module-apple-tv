// Fail packaging when the built module needs a newer module API than the oldest
// supported Companion accepts. Companion compares the packaged manifest's
// runtime.apiVersion with the range in package.json "companion".
import { readFileSync } from 'node:fs'
import semver from 'semver'

const { companion } = JSON.parse(readFileSync('package.json', 'utf8'))
const manifestPath = process.argv[2] ?? 'pkg/apple-tv/companion/manifest.json'
const { apiVersion } = JSON.parse(readFileSync(manifestPath, 'utf8')).runtime

if (!semver.satisfies(apiVersion, companion.moduleApiVersions)) {
	throw new Error(
		`Module API ${apiVersion} is not accepted by Companion ${companion.minimumVersion}` +
			` (accepts ${companion.moduleApiVersions}). Keep @companion-module/base within that range` +
			` or raise the minimum Companion version in package.json and the README.`,
	)
}
console.log(`Module API ${apiVersion} runs on Companion ${companion.minimumVersion} or later`)
