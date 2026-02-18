#!/usr/bin/env bun

/**
 * Verify npm pack output includes required runtime files.
 *
 * Why: This catches publish regressions (missing dashboard/assets/bin/docs)
 * before releasing to npm.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const packageDir = join(import.meta.dir, '..')
const decoder = new TextDecoder()

const requiredEntries = [
	'package/dist/index.js',
	'package/dist/cli/index.js',
	'package/dist/public/index.html',
	'package/bin/observability.cjs',
	'package/README.md',
	'package/LICENSE',
	'package/CHANGELOG.md',
] as const

const beforePack = listTarballs(packageDir)

const pack = Bun.spawnSync({
	cmd: [process.execPath, 'pm', 'pack'],
	cwd: packageDir,
	stdout: 'pipe',
	stderr: 'pipe',
})

if (pack.exitCode !== 0) {
	console.error('[pack:verify] bun pm pack failed')
	console.error(decoder.decode(pack.stdout))
	console.error(decoder.decode(pack.stderr))
	process.exit(1)
}

const tarball = detectTarball(packageDir, beforePack)
if (!tarball) {
	console.error('[pack:verify] Could not locate generated .tgz tarball')
	process.exit(1)
}

const list = Bun.spawnSync({
	cmd: ['tar', '-tzf', tarball],
	stdout: 'pipe',
	stderr: 'pipe',
})

if (list.exitCode !== 0) {
	console.error(`[pack:verify] Failed to inspect tarball: ${tarball}`)
	console.error(decoder.decode(list.stderr))
	process.exit(1)
}

const entries = new Set(
	decoder
		.decode(list.stdout)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0),
)

const missing = requiredEntries.filter((entry) => !entries.has(entry))
if (missing.length > 0) {
	console.error(`[pack:verify] Missing required packed files in ${tarball}:`)
	for (const file of missing) {
		console.error(`  - ${file}`)
	}
	process.exit(1)
}

console.log(`[pack:verify] tarball: ${tarball}`)
console.log('[pack:verify] required entries present:')
for (const file of requiredEntries) {
	console.log(`  - ${file}`)
}
console.log('[pack:verify] all checks passed')

function listTarballs(dir: string): readonly string[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith('.tgz'))
		.map((name) => join(dir, name))
}

function detectTarball(dir: string, before: readonly string[]): string | null {
	const beforeSet = new Set(before)
	const after = listTarballs(dir)
	const created = after.filter((file) => !beforeSet.has(file))
	if (created.length > 0) {
		return newestByMtime(created)
	}
	if (after.length > 0) {
		return newestByMtime(after)
	}
	return null
}

function newestByMtime(files: readonly string[]): string {
	return [...files].sort((a, b) => {
		const aMtime = statSync(a).mtimeMs
		const bMtime = statSync(b).mtimeMs
		return bMtime - aMtime
	})[0] as string
}
