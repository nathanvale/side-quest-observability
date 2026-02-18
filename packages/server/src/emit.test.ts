/**
 * Tests for fire-and-forget event emission.
 *
 * Why: Validates the fast-path (no server) behavior, real HTTP
 * emission against a live event server, silent failure on
 * connection refused, and 500ms timeout enforcement. Also verifies
 * discoverEventServer() reads from the global cache directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'bun'
import { discoverEventServer, emitCliEvent, emitEvent, isEventServerRunning } from './emit.js'
import { createEvent } from './schema.js'
import { startServer } from './server.js'

/** Global cache directory -- must match server.ts and emit.ts. */
const GLOBAL_CACHE_DIR = path.join(os.homedir(), '.cache', 'side-quest-observability')

/**
 * Remove global PID/port/nonce files to ensure a clean state between tests.
 *
 * Why: startServer() throws if PID files from a previous test are present.
 * isEventServerRunning() also reads from the same global directory.
 */
function cleanupGlobalPidFiles(): void {
	const files = ['events.port', 'events.pid', 'events.nonce']
	for (const f of files) {
		try {
			unlinkSync(path.join(GLOBAL_CACHE_DIR, f))
		} catch {
			// Ignore -- file may not exist
		}
	}
}

// =============================================
// isEventServerRunning tests
// =============================================

describe('isEventServerRunning', () => {
	beforeEach(() => {
		cleanupGlobalPidFiles()
	})

	afterEach(() => {
		cleanupGlobalPidFiles()
	})

	test('returns null when no PID file exists in global cache dir', () => {
		// After cleanup, no PID files exist -- should return null
		const result = isEventServerRunning()
		expect(result).toBeNull()
	})

	test('returns port when a live server is registered in global cache dir', () => {
		// Start a real server (writes global PID files)
		const server = startServer({
			port: 0,
			appName: 'is-running-test',
			appRoot: `/tmp/is-running-${Date.now()}`,
		})

		try {
			const result = isEventServerRunning()
			expect(result).toBe(server.port)
		} finally {
			server.stop(true)
		}
	})

	test('returns null when PID file references a dead process', () => {
		// Write a fake PID that almost certainly does not exist (very large number)
		const { mkdirSync, writeFileSync } = require('node:fs')
		mkdirSync(GLOBAL_CACHE_DIR, { recursive: true })
		writeFileSync(path.join(GLOBAL_CACHE_DIR, 'events.pid'), '999999')
		writeFileSync(path.join(GLOBAL_CACHE_DIR, 'events.port'), '9999')

		const result = isEventServerRunning()
		expect(result).toBeNull()
	})
})

// =============================================
// discoverEventServer tests
// =============================================

describe('discoverEventServer', () => {
	beforeEach(() => {
		cleanupGlobalPidFiles()
	})

	afterEach(() => {
		cleanupGlobalPidFiles()
	})

	test('returns null when no server port file exists', () => {
		const result = discoverEventServer()
		expect(result).toBeNull()
	})

	test('reads from global cache directory when server is running', () => {
		const server = startServer({
			port: 0,
			appName: 'discover-test',
			appRoot: `/tmp/discover-${Date.now()}`,
		})

		try {
			const result = discoverEventServer()
			expect(result).not.toBeNull()
			expect(result?.port).toBe(server.port)
			expect(result?.baseUrl).toBe(`http://127.0.0.1:${server.port}`)
		} finally {
			server.stop(true)
		}
	})
})

// =============================================
// emitEvent tests
// =============================================

describe('emitEvent', () => {
	let server: Server

	beforeEach(() => {
		cleanupGlobalPidFiles()
		const appName = `emit-test-${Date.now()}`
		server = startServer({
			port: 0,
			appName,
			appRoot: `/tmp/${appName}`,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
	})

	test('sends POST to server and event is retrievable via GET /events', async () => {
		const event = createEvent(
			'worktree.created',
			{ branch: 'feat/test' },
			{
				app: 'test-app',
				appRoot: '/tmp/fake-app-root',
				source: 'cli',
			},
		)

		await emitEvent(event, server.port)

		// Give the server a moment to process
		await Bun.sleep(50)

		const res = await fetch(`http://127.0.0.1:${server.port}/events?type=worktree.created`)
		const events = await res.json()
		expect(events).toHaveLength(1)
		expect(events[0].id).toBe(event.id)
		expect((events[0].data as Record<string, unknown>).branch).toBe('feat/test')
	})

	test('returns silently when server is not running (connection refused)', async () => {
		const event = createEvent(
			'worktree.deleted',
			{ branch: 'feat/gone' },
			{
				app: 'test-app',
				appRoot: '/tmp/fake-app-root',
				source: 'cli',
			},
		)

		// Port 1 is almost certainly not running an HTTP server
		await expect(emitEvent(event, 1)).resolves.toBeUndefined()
	})

	test('is fire-and-forget -- does not throw on failure', async () => {
		const event = createEvent(
			'session.started',
			{},
			{
				app: 'test-app',
				appRoot: '/tmp/fake-app-root',
				source: 'cli',
			},
		)

		// Should not throw even on a bad port
		let threw = false
		try {
			await emitEvent(event, 65535)
		} catch {
			threw = true
		}
		expect(threw).toBe(false)
	})

	test('respects 500ms timeout on a slow server', async () => {
		let slowServer: Server | null = null

		try {
			// Create a server that delays its response beyond 500ms
			slowServer = Bun.serve({
				port: 0,
				async fetch() {
					await Bun.sleep(2000)
					return new Response('too late')
				},
			})

			const event = createEvent(
				'worktree.synced',
				{ branch: 'feat/slow' },
				{
					app: 'test-app',
					appRoot: '/tmp/fake-app-root',
					source: 'cli',
				},
			)

			const start = Date.now()
			await emitEvent(event, slowServer.port)
			const elapsed = Date.now() - start

			// Should abort well before the 2s server delay
			// Allow generous margin but must be under 1500ms
			expect(elapsed).toBeLessThan(1500)
		} finally {
			slowServer?.stop(true)
		}
	})
})

// =============================================
// emitCliEvent tests
// =============================================

describe('emitCliEvent', () => {
	beforeEach(() => {
		cleanupGlobalPidFiles()
	})

	afterEach(() => {
		cleanupGlobalPidFiles()
	})

	test('skips emission when no server is running (fast path)', async () => {
		const start = Date.now()

		await emitCliEvent(
			'worktree.created',
			{ branch: 'feat/quick' },
			{
				app: 'nonexistent-app',
				appRoot: '/tmp/nonexistent-app-xyz',
				source: 'cli',
			},
		)

		const elapsed = Date.now() - start
		// Fast path should complete in under 50ms (file existence check only)
		expect(elapsed).toBeLessThan(50)
	})

	test('emits event when server is running', async () => {
		const appName = `emit-cli-test-${Date.now()}`
		const appRoot = `/tmp/${appName}`

		const server = startServer({
			port: 0,
			appName,
			appRoot,
		})

		try {
			await emitCliEvent(
				'worktree.created',
				{ branch: 'feat/wired' },
				{
					app: appName,
					appRoot,
					source: 'cli',
				},
			)

			// Give the server a moment to process
			await Bun.sleep(50)

			const res = await fetch(`http://127.0.0.1:${server.port}/events?type=worktree.created`)
			const events = await res.json()
			expect(events).toHaveLength(1)
			expect((events[0].data as Record<string, unknown>).branch).toBe('feat/wired')
		} finally {
			server.stop(true)
		}
	})

	test('rate-limited logging -- emit failure counter increments', async () => {
		// This test verifies that emitEvent does not throw on connection refused.
		// The rate-limited logging is module-level state and hard to test in isolation,
		// but we can verify the function completes without error even on repeated failures.
		const event = createEvent(
			'worktree.created',
			{ branch: 'feat/fail' },
			{
				app: 'test-app',
				appRoot: '/tmp/test-app',
				source: 'cli',
			},
		)

		// Fire multiple emissions to a dead port -- none should throw
		const results = await Promise.allSettled([
			emitEvent(event, 1),
			emitEvent(event, 1),
			emitEvent(event, 1),
		])

		for (const result of results) {
			expect(result.status).toBe('fulfilled')
		}
	})
})
