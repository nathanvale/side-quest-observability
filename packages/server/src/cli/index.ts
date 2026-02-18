#!/usr/bin/env bun

/**
 * CLI executable entry point.
 *
 * Why: Keeps runtime execution separate from the testable command module.
 */

import { runCli } from './command.js'

runCli()
	.then((exitCode) => {
		if (exitCode !== 0) {
			process.exit(exitCode)
		}
	})
	.catch((err) => {
		process.stderr.write(`[observability] Unexpected CLI failure: ${err}\n`)
		process.exit(1)
	})
