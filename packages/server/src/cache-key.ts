/**
 * Event server cache-key utilities.
 *
 * Why: PID/port discovery files must use a stable per-application key
 * that does not collide for applications with the same directory name.
 * With the global server model these keys are no longer used for port
 * file discovery (that uses GLOBAL_CACHE_DIR directly), but they are
 * still needed for: migration compatibility with side-quest-git paths,
 * per-app JSONL file organisation, and the re-export shim in @side-quest/git.
 */

import os from 'node:os'
import path from 'node:path'
import { contentId } from '@side-quest/core/hash'

/**
 * Build a stable cache key from an absolute application root path.
 *
 * Why: Using only `basename(appRoot)` causes collisions across apps
 * that share names (e.g. multiple `app` directories in different
 * monorepo workspaces). The `contentId` suffix provides uniqueness
 * while keeping keys human-readable. Renamed from `getRepoCacheKey`
 * to reflect that any application root is accepted, not just git repos.
 *
 * @param appRoot - Absolute path to the application root directory
 * @returns A stable, collision-resistant cache key string
 *
 * @example
 * ```ts
 * const key = getAppCacheKey('/home/user/my-project')
 * // => 'my-project-a1b2c3d4e5f6'
 * ```
 */
export function getAppCacheKey(appRoot: string): string {
	const normalizedRoot = path.resolve(appRoot)
	const baseName = path
		.basename(normalizedRoot)
		.replace(/[^a-zA-Z0-9._-]/g, '_')
	const digest = contentId(normalizedRoot)
	return `${baseName || 'app'}-${digest}`
}

/**
 * Get the cache directory for an app-specific event cache key.
 *
 * Why: Centralised cache-dir derivation keeps server and emitter lookup
 * behaviour consistent across all consumers. Updated from side-quest-git
 * to side-quest-observability to match the new package identity.
 *
 * @param cacheKey - The cache key returned by `getAppCacheKey`
 * @returns Absolute path to the app-specific cache directory
 *
 * @example
 * ```ts
 * const dir = getAppCacheDir('my-project-a1b2c3d4e5f6')
 * // => '/home/user/.cache/side-quest-observability/my-project-a1b2c3d4e5f6'
 * ```
 */
export function getAppCacheDir(cacheKey: string): string {
	return path.join(os.homedir(), '.cache', 'side-quest-observability', cacheKey)
}
