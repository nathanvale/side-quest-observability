#!/usr/bin/env bun

/**
 * Postbuild script: copies Vue dashboard assets into the server dist.
 *
 * Why: When installed from npm, the server package has no access to the
 * sibling `@side-quest/observability-client` package. This script runs
 * after `bunup` and copies the built client dist into `dist/public/`
 * so the dashboard is embedded inside the published package.
 *
 * The client must be built first (root build script ensures ordering).
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const clientDist = join(import.meta.dir, '../../client/dist')
const clientIndex = join(clientDist, 'index.html')
const serverPublic = join(import.meta.dir, '../dist/public')
const serverIndex = join(serverPublic, 'index.html')

if (!existsSync(clientIndex)) {
	console.error(
		`[postbuild] Missing dashboard assets at ${clientIndex}. Build the client first: bun run --cwd packages/client build`,
	)
	process.exit(1)
}

mkdirSync(serverPublic, { recursive: true })
cpSync(clientDist, serverPublic, { recursive: true })

if (!existsSync(serverIndex)) {
	console.error(`[postbuild] Asset copy failed: ${serverIndex} was not created`)
	process.exit(1)
}

console.log(`[postbuild] Copied client assets to ${serverPublic}`)
