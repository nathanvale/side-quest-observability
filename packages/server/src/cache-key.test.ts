/**
 * Tests for cache-key utilities.
 *
 * Why: Validates that getAppCacheKey produces stable, collision-resistant
 * keys and that getAppCacheDir returns the correct base path under the
 * side-quest-observability cache directory.
 */

import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { getAppCacheDir, getAppCacheKey } from './cache-key.js'

describe('getAppCacheKey', () => {
	test('returns the same key for equivalent absolute paths', () => {
		const keyA = getAppCacheKey('/tmp/example-app')
		const keyB = getAppCacheKey('/tmp/../tmp/example-app')
		expect(keyA).toBe(keyB)
	})

	test('returns different keys for different roots with same basename', () => {
		const keyA = getAppCacheKey('/tmp/a/app')
		const keyB = getAppCacheKey('/tmp/b/app')
		expect(keyA).not.toBe(keyB)
	})

	test('key is deterministic across calls with the same path', () => {
		const path1 = getAppCacheKey('/home/user/my-project')
		const path2 = getAppCacheKey('/home/user/my-project')
		expect(path1).toBe(path2)
	})

	test('key is non-empty string', () => {
		const key = getAppCacheKey('/tmp/test-app')
		expect(typeof key).toBe('string')
		expect(key.length).toBeGreaterThan(0)
	})
})

describe('getAppCacheDir', () => {
	test('includes the cache key as final path segment', () => {
		const cacheKey = getAppCacheKey('/tmp/sample')
		const cacheDir = getAppCacheDir(cacheKey)
		expect(path.basename(cacheDir)).toBe(cacheKey)
	})

	test('returns a path under ~/.cache/side-quest-observability/', () => {
		const cacheKey = getAppCacheKey('/tmp/sample-app')
		const cacheDir = getAppCacheDir(cacheKey)
		const expectedBase = path.join(os.homedir(), '.cache', 'side-quest-observability')
		expect(cacheDir.startsWith(expectedBase)).toBe(true)
	})
})
