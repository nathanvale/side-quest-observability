/**
 * Tests for the HTTP + WebSocket event bus server.
 *
 * Why: Validates EventStore ring-buffer operations, HTTP REST endpoints,
 * WebSocket pub/sub, hook event enrichment pipeline, CORS handling,
 * ingress validation, and health diagnostics. Uses real Bun servers
 * on port 0 (auto-assign) to avoid port conflicts between tests.
 *
 * Note on isolation: startServer() writes global PID/port/nonce files to
 * ~/.cache/side-quest-observability/ and refuses to start if another server
 * is already registered there. We clean up those files in beforeEach so
 * each test suite gets a fresh server registration.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'bun'
import { createEvent } from './schema.js'
import { readEventServerPort, startServer } from './server.js'
import { EventStore } from './store.js'
import type { EventEnvelope } from './types.js'

/** Global cache directory -- must match server.ts. */
const GLOBAL_CACHE_DIR = path.join(os.homedir(), '.cache', 'side-quest-observability')

/**
 * Remove global PID/port/nonce files so startServer() won't throw
 * "Event server already running" during tests.
 *
 * Why: Each test suite starts a fresh server on port 0. Without cleanup,
 * the global cache files from the previous test cause startServer() to
 * throw. We clean up deterministically in beforeEach.
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

/** Reusable test context. */
const testApp = `test-app-${Date.now()}`
const testAppRoot = '/tmp/test-app'

/** Helper to create a test event envelope. */
function makeEvent(
	type: 'worktree.created' | 'worktree.deleted' | 'session.started' = 'worktree.created',
	data: Record<string, unknown> = {},
): EventEnvelope {
	return createEvent(type, data, {
		app: testApp,
		appRoot: testAppRoot,
		source: 'cli',
	})
}

// =============================================
// EventStore unit tests
// =============================================

describe('EventStore', () => {
	test('push and query returns events', () => {
		const store = new EventStore({ capacity: 10 })
		const event = makeEvent('worktree.created', { branch: 'feat/a' })
		store.push(event)

		const result = store.query()
		expect(result).toHaveLength(1)
		expect(result[0]?.type).toBe('worktree.created')
	})

	test('query filters by type', () => {
		const store = new EventStore({ capacity: 10 })
		store.push(makeEvent('worktree.created'))
		store.push(makeEvent('worktree.deleted'))
		store.push(makeEvent('worktree.created'))

		const result = store.query({ type: 'worktree.created' })
		expect(result).toHaveLength(2)
	})

	test('query filters by since timestamp', () => {
		const store = new EventStore({ capacity: 10 })

		const oldEvent = makeEvent('worktree.created')
		store.push(oldEvent)

		// Create a timestamp between old and new events
		const since = new Date().toISOString()

		const newEvent = createEvent(
			'worktree.deleted',
			{},
			{ app: testApp, appRoot: testAppRoot, source: 'cli' },
		)
		// Manually set a future timestamp for the new event
		const futureEvent = {
			...newEvent,
			timestamp: new Date(Date.now() + 1000).toISOString(),
		} as EventEnvelope
		store.push(futureEvent)

		const result = store.query({ since })
		expect(result).toHaveLength(1)
		expect(result[0]?.type).toBe('worktree.deleted')
	})

	test('query respects limit', () => {
		const store = new EventStore({ capacity: 10 })
		for (let i = 0; i < 5; i++) {
			store.push(makeEvent('worktree.created', { index: i }))
		}

		const result = store.query({ limit: 2 })
		expect(result).toHaveLength(2)
		// Should return the last 2 events
		expect((result[0]?.data as Record<string, unknown>).index).toBe(3)
		expect((result[1]?.data as Record<string, unknown>).index).toBe(4)
	})

	test('ring buffer evicts oldest when full', () => {
		const store = new EventStore({ capacity: 3 })

		store.push(makeEvent('worktree.created', { index: 0 }))
		store.push(makeEvent('worktree.created', { index: 1 }))
		store.push(makeEvent('worktree.created', { index: 2 }))
		// This should evict index 0
		store.push(makeEvent('worktree.created', { index: 3 }))

		expect(store.size).toBe(3)

		const events = store.query()
		expect(events).toHaveLength(3)
		// Oldest surviving event should be index 1
		expect((events[0]?.data as Record<string, unknown>).index).toBe(1)
		expect((events[1]?.data as Record<string, unknown>).index).toBe(2)
		expect((events[2]?.data as Record<string, unknown>).index).toBe(3)
	})

	test('last(n) returns correct number of events', () => {
		const store = new EventStore({ capacity: 10 })
		for (let i = 0; i < 5; i++) {
			store.push(makeEvent('worktree.created', { index: i }))
		}

		const result = store.last(2)
		expect(result).toHaveLength(2)
		expect((result[0]?.data as Record<string, unknown>).index).toBe(3)
		expect((result[1]?.data as Record<string, unknown>).index).toBe(4)
	})

	test('size tracks count correctly', () => {
		const store = new EventStore({ capacity: 5 })
		expect(store.size).toBe(0)

		store.push(makeEvent())
		expect(store.size).toBe(1)

		store.push(makeEvent())
		expect(store.size).toBe(2)
	})

	test('size does not exceed capacity', () => {
		const store = new EventStore({ capacity: 3 })
		for (let i = 0; i < 10; i++) {
			store.push(makeEvent())
		}
		expect(store.size).toBe(3)
	})
})

// =============================================
// HTTP server integration tests
// =============================================

describe('Event Server HTTP', () => {
	let server: Server
	let dashboardDir: string

	beforeEach(() => {
		// Ensure no stale PID files from previous tests
		cleanupGlobalPidFiles()
		dashboardDir = mkdtempSync(path.join(os.tmpdir(), 'obs-dashboard-'))
		writeFileSync(
			path.join(dashboardDir, 'index.html'),
			'<!doctype html><html><body>dashboard</body></html>',
		)
		server = startServer({
			port: 0,
			appName: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			appRoot: `/tmp/test-http-${Date.now()}`,
			capacity: 100,
			dashboardDistDir: dashboardDir,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
		rmSync(dashboardDir, { recursive: true, force: true })
	})

	test('binds to localhost by default', () => {
		expect(server.hostname).toBe('127.0.0.1')
	})

	test('writes discovery files to global cache dir', () => {
		const discoveredPort = readEventServerPort()
		expect(discoveredPort).toBe(server.port)
	})

	test('POST /events stores event and returns 201', async () => {
		const event = makeEvent('worktree.created', { branch: 'feat/test' })

		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(event),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.id).toBe(event.id)
	})

	test('POST /events accepts partial payload and wraps in envelope', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'worktree.created',
				data: { branch: 'feat/auto' },
			}),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(typeof body.id).toBe('string')
	})

	test('POST /events returns 400 for invalid JSON', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		})

		expect(res.status).toBe(400)
	})

	test('POST /events returns 400 for empty body', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '',
		})

		expect(res.status).toBe(400)
	})

	test('POST /events returns 400 for missing type field', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ data: { branch: 'main' } }),
		})

		expect(res.status).toBe(400)
	})

	test('POST /events returns 400 for missing data field', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'worktree.created' }),
		})

		expect(res.status).toBe(400)
	})

	test('GET /events returns stored events', async () => {
		// POST an event first (no direct store access -- use HTTP)
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created', { branch: 'feat/get' })),
		})

		const res = await fetch(`http://localhost:${server.port}/events`)
		expect(res.status).toBe(200)

		const events = await res.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('worktree.created')
	})

	test('GET /events?type= filters by event type', async () => {
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created')),
		})
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.deleted')),
		})
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created')),
		})

		const res = await fetch(`http://localhost:${server.port}/events?type=worktree.deleted`)
		const events = await res.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('worktree.deleted')
	})

	test('GET /events?since= returns events after timestamp', async () => {
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created')),
		})

		const since = new Date().toISOString()

		// Create an event with a future timestamp
		const futureEvent = {
			...makeEvent('worktree.deleted'),
			timestamp: new Date(Date.now() + 1000).toISOString(),
		} as EventEnvelope

		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(futureEvent),
		})

		const res = await fetch(
			`http://localhost:${server.port}/events?since=${encodeURIComponent(since)}`,
		)
		const events = await res.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('worktree.deleted')
	})

	test('GET /events?limit= limits result count', async () => {
		for (let i = 0; i < 5; i++) {
			await fetch(`http://localhost:${server.port}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(makeEvent('worktree.created', { index: i })),
			})
		}

		const res = await fetch(`http://localhost:${server.port}/events?limit=2`)
		const events = await res.json()
		expect(events).toHaveLength(2)
	})

	test('serves SPA fallback (index.html) for unknown routes when dist exists', async () => {
		const res = await fetch(`http://localhost:${server.port}/unknown`)
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('dashboard')
	})
})

// =============================================
// Health endpoint tests
// =============================================

describe('Event Server Health', () => {
	let server: Server

	beforeEach(() => {
		cleanupGlobalPidFiles()
		server = startServer({
			port: 0,
			appName: `test-health-${Date.now()}`,
			appRoot: `/tmp/test-health-${Date.now()}`,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
	})

	test('GET /health returns status ok', async () => {
		const res = await fetch(`http://localhost:${server.port}/health`)
		expect(res.status).toBe(200)
		const health = await res.json()
		expect(health.status).toBe('ok')
	})

	test('GET /health returns nonce string', async () => {
		const res = await fetch(`http://localhost:${server.port}/health`)
		const health = await res.json()
		expect(typeof health.nonce).toBe('string')
		expect(health.nonce.length).toBeGreaterThan(0)
	})

	test('GET /health nonce is consistent across requests', async () => {
		const res1 = await fetch(`http://localhost:${server.port}/health`)
		const res2 = await fetch(`http://localhost:${server.port}/health`)
		const health1 = await res1.json()
		const health2 = await res2.json()
		expect(health1.nonce).toBe(health2.nonce)
	})

	test('GET /health returns uptime as number', async () => {
		const res = await fetch(`http://localhost:${server.port}/health`)
		const health = await res.json()
		expect(typeof health.uptime).toBe('number')
		expect(health.uptime).toBeGreaterThanOrEqual(0)
	})

	test('GET /health returns events stats', async () => {
		// POST two events
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent()),
		})
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent()),
		})

		const res = await fetch(`http://localhost:${server.port}/health`)
		const health = await res.json()
		expect(health.events.total).toBe(2)
		expect(typeof health.events.types).toBe('object')
	})
})

// =============================================
// CORS tests
// =============================================

describe('Event Server CORS', () => {
	let server: Server

	beforeEach(() => {
		cleanupGlobalPidFiles()
		server = startServer({
			port: 0,
			appName: `test-cors-${Date.now()}`,
			appRoot: `/tmp/test-cors-${Date.now()}`,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
	})

	test('OPTIONS preflight returns 204 with correct CORS headers', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'OPTIONS',
		})
		expect(res.status).toBe(204)
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type')
	})

	test('GET /events response has CORS headers', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`)
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
	})

	test('POST /events response has CORS headers', async () => {
		const res = await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent()),
		})
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
	})
})

// =============================================
// Hook event enrichment tests
// =============================================

describe('Event Server Hook Enrichment (POST /events/:eventName)', () => {
	let server: Server

	beforeEach(() => {
		cleanupGlobalPidFiles()
		server = startServer({
			port: 0,
			appName: `test-hook-${Date.now()}`,
			appRoot: `/tmp/test-hook-${Date.now()}`,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
	})

	test('POST /events/session-start enriches SessionStart stdin', async () => {
		const stdin = {
			session_id: 'sess-abc-123',
			transcript_path: '/tmp/transcript.jsonl',
			cwd: '/home/user/project',
			permission_mode: 'default',
			hook_event_name: 'SessionStart',
			source: 'vscode',
			model: 'claude-opus-4-6',
			agent_type: 'claude-code',
		}

		const res = await fetch(`http://localhost:${server.port}/events/session-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(typeof body.id).toBe('string')

		// Verify the stored event has the enriched envelope
		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.session_start`)
		const events = await eventsRes.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('hook.session_start')
		expect(events[0].source).toBe('hook')

		const data = events[0].data as Record<string, unknown>
		expect(data.hookEvent).toBe('session_start')
		expect(data.sessionId).toBe('sess-abc-123')
		expect(data.model).toBe('claude-opus-4-6')
		expect(data.source).toBe('vscode')
	})

	test('POST /events/pre-tool-use extracts tool_name', async () => {
		const stdin = {
			session_id: 'sess-abc-123',
			tool_name: 'Bash',
			tool_input: { command: 'ls -la' },
			permission_mode: 'default',
			cwd: '/home/user/project',
		}

		const res = await fetch(`http://localhost:${server.port}/events/pre-tool-use`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)

		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.pre_tool_use`)
		const events = await eventsRes.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('hook.pre_tool_use')

		const data = events[0].data as Record<string, unknown>
		expect(data.toolName).toBe('Bash')
		expect(data.hookEvent).toBe('pre_tool_use')
	})

	test('POST /events/pre-tool-use truncates large tool_input', async () => {
		const largeInput = { content: 'x'.repeat(3000) }
		const stdin = {
			session_id: 'sess-abc-123',
			tool_name: 'Write',
			tool_input: largeInput,
			cwd: '/home/user/project',
		}

		const res = await fetch(`http://localhost:${server.port}/events/pre-tool-use`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)

		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.pre_tool_use`)
		const events = await eventsRes.json()
		const data = events[0].data as Record<string, unknown>
		// toolInputPreview should be truncated (original JSON would be > 2000 chars)
		const preview = data.toolInputPreview as string
		expect(typeof preview).toBe('string')
		expect(preview.endsWith('...')).toBe(true)
	})

	test('POST /events/post-tool-use truncates large tool_result', async () => {
		const largeResult = 'y'.repeat(3000)
		const stdin = {
			session_id: 'sess-abc-123',
			tool_name: 'Read',
			tool_use_id: 'tool-001',
			tool_result: largeResult,
			cwd: '/home/user/project',
		}

		const res = await fetch(`http://localhost:${server.port}/events/post-tool-use`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)

		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.post_tool_use`)
		const events = await eventsRes.json()
		const data = events[0].data as Record<string, unknown>
		const preview = data.toolResultPreview as string
		expect(typeof preview).toBe('string')
		expect(preview.endsWith('...')).toBe(true)
	})

	test('POST /events/stop with stop_hook_active: true returns skipped', async () => {
		const stdin = {
			session_id: 'sess-abc-123',
			transcript_path: '/tmp/t.jsonl',
			cwd: '/tmp',
			permission_mode: 'default',
			stop_hook_active: true,
		}

		const res = await fetch(`http://localhost:${server.port}/events/stop`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('skipped')

		// Verify no event was stored
		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.stop`)
		const events = await eventsRes.json()
		expect(events).toHaveLength(0)
	})

	test('POST /events/stop without stop_hook_active stores enriched envelope', async () => {
		const stdin = {
			session_id: 'sess-abc-123',
			transcript_path: '/tmp/t.jsonl',
			cwd: '/home/user/project',
			permission_mode: 'default',
		}

		const res = await fetch(`http://localhost:${server.port}/events/stop`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(typeof body.id).toBe('string')

		// Verify the event was stored
		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.stop`)
		const events = await eventsRes.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('hook.stop')
	})

	test('POST /events/unknown-event maps forward-compatibly', async () => {
		const stdin = {
			session_id: 'sess-abc-123',
			cwd: '/home/user/project',
			some_field: 'value',
		}

		const res = await fetch(`http://localhost:${server.port}/events/unknown-event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		expect(res.status).toBe(201)

		// Should map to hook.unknown_event
		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.unknown_event`)
		const events = await eventsRes.json()
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe('hook.unknown_event')

		const data = events[0].data as Record<string, unknown>
		expect(data.hookEvent).toBe('unknown-event')
	})

	test('POST /events/:eventName returns 400 for invalid JSON', async () => {
		const res = await fetch(`http://localhost:${server.port}/events/session-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		})

		expect(res.status).toBe(400)
	})

	test('enriched envelope has schemaVersion, timestamp, and correlationId', async () => {
		const stdin = {
			session_id: 'sess-xyz',
			cwd: '/home/user/project',
			permission_mode: 'default',
		}

		await fetch(`http://localhost:${server.port}/events/session-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(stdin),
		})

		const eventsRes = await fetch(`http://localhost:${server.port}/events?type=hook.session_start`)
		const events = await eventsRes.json()
		const envelope = events[0]

		expect(envelope.schemaVersion).toBe('1.0.0')
		expect(typeof envelope.timestamp).toBe('string')
		expect(Date.parse(envelope.timestamp)).not.toBeNaN()
		expect(typeof envelope.correlationId).toBe('string')
		expect(envelope.correlationId.length).toBeGreaterThan(0)
	})
})

// =============================================
// WebSocket integration tests
// =============================================

describe('Event Server WebSocket', () => {
	let server: Server

	beforeEach(() => {
		cleanupGlobalPidFiles()
		server = startServer({
			port: 0,
			appName: `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			appRoot: `/tmp/test-ws-${Date.now()}`,
			capacity: 100,
		})
	})

	afterEach(() => {
		server.stop(true)
		cleanupGlobalPidFiles()
	})

	test('WebSocket client receives broadcast on POST', async () => {
		const received: EventEnvelope[] = []

		const ws = new WebSocket(`ws://localhost:${server.port}/ws`)

		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve()
			ws.onerror = (_e) => reject(new Error('WS connection failed'))
			setTimeout(() => reject(new Error('WS open timeout')), 5000)
		})

		ws.onmessage = (event) => {
			received.push(JSON.parse(event.data as string))
		}

		// POST an event
		const testEvent = makeEvent('worktree.created', { branch: 'feat/ws' })
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(testEvent),
		})

		// Wait for broadcast
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(received).toHaveLength(1)
		expect(received[0]?.type).toBe('worktree.created')
		expect((received[0]?.data as Record<string, unknown>).branch).toBe('feat/ws')

		ws.close()
	})

	test('WebSocket type filter only receives matching events', async () => {
		const received: EventEnvelope[] = []

		// Connect with type filter
		const ws = new WebSocket(`ws://localhost:${server.port}/ws?type=worktree.deleted`)

		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve()
			ws.onerror = () => reject(new Error('WS connection failed'))
			setTimeout(() => reject(new Error('WS open timeout')), 5000)
		})

		ws.onmessage = (event) => {
			received.push(JSON.parse(event.data as string))
		}

		// POST events of different types
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created')),
		})
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.deleted')),
		})
		await fetch(`http://localhost:${server.port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(makeEvent('worktree.created')),
		})

		// Wait for broadcasts
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Should only receive the worktree.deleted event
		expect(received).toHaveLength(1)
		expect(received[0]?.type).toBe('worktree.deleted')

		ws.close()
	})

	test('WebSocket client receives hook enrichment broadcast', async () => {
		const received: EventEnvelope[] = []

		const ws = new WebSocket(`ws://localhost:${server.port}/ws?type=hook.session_start`)

		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve()
			ws.onerror = () => reject(new Error('WS connection failed'))
			setTimeout(() => reject(new Error('WS open timeout')), 5000)
		})

		ws.onmessage = (event) => {
			received.push(JSON.parse(event.data as string))
		}

		// POST a hook event
		await fetch(`http://localhost:${server.port}/events/session-start`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				session_id: 'ws-test-sess',
				cwd: '/home/user/project',
				model: 'claude-opus-4-6',
			}),
		})

		// Wait for broadcast
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(received).toHaveLength(1)
		expect(received[0]?.type).toBe('hook.session_start')

		ws.close()
	})
})
