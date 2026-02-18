#!/usr/bin/env bun

/**
 * Smoke-test built CLI entrypoints and help surfaces.
 *
 * Why: Day-3 release validation should quickly confirm the published CLI
 * contract is discoverable for both humans and agents before shipping.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const cliEntrypoint = join(import.meta.dir, '../dist/cli/index.js')
const nodeShimEntrypoint = join(import.meta.dir, '../bin/observability.cjs')

const decoder = new TextDecoder()

interface CommandCase {
	readonly label: string
	readonly cmd: string[]
	readonly expectedCode: number
	readonly stdoutIncludes?: readonly string[]
	readonly stderrIncludes?: readonly string[]
}

if (!existsSync(cliEntrypoint)) {
	console.error(
		`[smoke:cli] Missing built CLI at ${cliEntrypoint}. Run "bun run build" first.`,
	)
	process.exit(1)
}

const cases: readonly CommandCase[] = [
	{
		label: 'main help',
		cmd: [process.execPath, cliEntrypoint, '--help'],
		expectedCode: 0,
		stdoutIncludes: ['Observability CLI', 'HTTP server API', 'Help topics:'],
	},
	{
		label: 'help api',
		cmd: [process.execPath, cliEntrypoint, 'help', 'api'],
		expectedCode: 0,
		stdoutIncludes: ['Help: api', 'HTTP routes:'],
	},
	{
		label: 'help contract',
		cmd: [process.execPath, cliEntrypoint, 'help', 'contract'],
		expectedCode: 0,
		stdoutIncludes: ['Help: contract', 'CLI machine contract:'],
	},
	{
		label: 'events help',
		cmd: [process.execPath, cliEntrypoint, 'events', '--help'],
		expectedCode: 0,
		stdoutIncludes: ['Help: events', '--jsonl'],
	},
	{
		label: 'unknown help topic',
		cmd: [process.execPath, cliEntrypoint, 'help', 'wat'],
		expectedCode: 2,
		stderrIncludes: ['Unknown help topic: wat'],
	},
]

for (const testCase of cases) {
	const result = Bun.spawnSync({
		cmd: testCase.cmd,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const stdout = decoder.decode(result.stdout)
	const stderr = decoder.decode(result.stderr)
	const exitCode = result.exitCode

	if (exitCode !== testCase.expectedCode) {
		console.error(
			`[smoke:cli] ${testCase.label} failed: expected exit ${testCase.expectedCode}, got ${exitCode}`,
		)
		if (stdout) console.error(`[smoke:cli] stdout:\n${stdout}`)
		if (stderr) console.error(`[smoke:cli] stderr:\n${stderr}`)
		process.exit(1)
	}

	for (const expected of testCase.stdoutIncludes ?? []) {
		if (!stdout.includes(expected)) {
			console.error(
				`[smoke:cli] ${testCase.label} failed: stdout missing "${expected}"`,
			)
			console.error(`[smoke:cli] stdout:\n${stdout}`)
			process.exit(1)
		}
	}

	for (const expected of testCase.stderrIncludes ?? []) {
		if (!stderr.includes(expected)) {
			console.error(
				`[smoke:cli] ${testCase.label} failed: stderr missing "${expected}"`,
			)
			console.error(`[smoke:cli] stderr:\n${stderr}`)
			process.exit(1)
		}
	}

	console.log(`[smoke:cli] pass: ${testCase.label}`)
}

// Optional Node shim check (npx path). Skip only if node is unavailable.
const nodePath = Bun.which('node')
if (nodePath && existsSync(nodeShimEntrypoint)) {
	const result = Bun.spawnSync({
		cmd: [nodePath, nodeShimEntrypoint, 'help', 'api'],
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const stdout = decoder.decode(result.stdout)
	if (result.exitCode !== 0 || !stdout.includes('Help: api')) {
		console.error('[smoke:cli] node shim check failed')
		console.error(`[smoke:cli] exit: ${result.exitCode}`)
		if (stdout) console.error(`[smoke:cli] stdout:\n${stdout}`)
		const stderr = decoder.decode(result.stderr)
		if (stderr) console.error(`[smoke:cli] stderr:\n${stderr}`)
		process.exit(1)
	}

	console.log('[smoke:cli] pass: node shim help api')
}

console.log('[smoke:cli] all checks passed')
