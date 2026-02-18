#!/usr/bin/env node

/**
 * Node-friendly CLI shim for npm users.
 *
 * Why: The actual CLI runtime is Bun. npm/npx invokes bins with Node by
 * default, so this shim either forwards execution to Bun or prints a clear
 * install command when Bun is unavailable.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const cliEntrypoint = join(__dirname, '..', 'dist', 'cli', 'index.js')
const args = process.argv.slice(2)

function printBunRequiredMessage(extra = '') {
	if (extra) process.stderr.write(`${extra}\n`)
	process.stderr.write(
		`${[
			'@side-quest/observability-server requires Bun to run the CLI.',
			'Install Bun: https://bun.sh/docs/installation',
			'Then run: bunx @side-quest/observability-server server',
		].join('\n')}\n`,
	)
}

if (!existsSync(cliEntrypoint)) {
	printBunRequiredMessage(`Built CLI entrypoint not found: ${cliEntrypoint}`)
	process.exit(1)
}

const result = spawnSync('bun', [cliEntrypoint, ...args], { stdio: 'inherit' })

if (result.error) {
	if (result.error.code === 'ENOENT') {
		printBunRequiredMessage('Bun executable was not found in PATH.')
		process.exit(1)
	}
	printBunRequiredMessage(`Failed to start Bun: ${result.error.message}`)
	process.exit(1)
}

if (typeof result.status === 'number') {
	process.exit(result.status)
}

process.exit(1)
