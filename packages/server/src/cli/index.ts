#!/usr/bin/env bun

/**
 * CLI entry point for the observability server.
 *
 * Why: Provides the `observability server` command so the event bus
 * can be started from the shell or from Claude Code hook configuration.
 * The hook scripts (OBS-3) are fully self-contained and do not import
 * this package -- they only need the server to be running.
 *
 * Usage:
 *   observability server [--port PORT]
 */

import { startServer } from '../server.js'

async function main(): Promise<void> {
	const command = process.argv[2]

	if (command !== 'server') {
		process.stderr.write('Usage: observability server [--port PORT]\n')
		process.exit(1)
	}

	const portFlag = process.argv.indexOf('--port')
	const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : undefined

	await startServer({
		appName: 'side-quest-observability',
		port,
	})
}

main().catch((err) => {
	process.stderr.write(`${err}\n`)
	process.exit(1)
})
