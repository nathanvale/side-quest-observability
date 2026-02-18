#!/usr/bin/env bun

/**
 * Assert that packaged dashboard assets exist in server dist output.
 *
 * Why: `prepack` runs before npm tarball creation. Failing here prevents
 * publishing a package that serves 404 for the dashboard root.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dashboardIndex = join(import.meta.dir, '../dist/public/index.html')

if (!existsSync(dashboardIndex)) {
	console.error(
		`[prepack] Missing dashboard asset: ${dashboardIndex}. Run "bun run build" before packing.`,
	)
	process.exit(1)
}

console.log(`[prepack] Dashboard asset present: ${dashboardIndex}`)
