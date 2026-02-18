/**
 * Fire-and-forget event emission to the global event bus.
 *
 * Why: CLI commands need to emit events without blocking or failing.
 * The emitter has a fast path when no server is running (<5ms)
 * and a 500ms timeout when the server exists but is slow.
 *
 * Global server model: one port file at
 * ~/.cache/side-quest-observability/events.port covers all projects.
 * Falls back to legacy side-quest-git per-app paths during migration.
 */

import os from 'node:os'
import path from 'node:path'
import { pathExistsSync, readTextFileSync } from '@side-quest/core/fs'
import { getAppCacheKey } from './cache-key.js'
import { createEvent } from './schema.js'
import type { EventContext, EventEnvelope, EventType } from './types.js'

/** Global cache directory -- matches server's discovery location. */
const GLOBAL_CACHE_DIR = path.join(
	os.homedir(),
	'.cache',
	'side-quest-observability',
)

/** Legacy side-quest-git cache directory (migration fallback). */
const LEGACY_CACHE_BASE = path.join(os.homedir(), '.cache', 'side-quest-git')

/** Module-level emit failure counter for rate-limited logging. */
let emitFailures = 0

/** Timestamp of last emit failure log to stderr (rate limit: 30s). */
let lastEmitFailureLogAt = 0

/** Rate-limit interval for emit failure logging (30 seconds). */
const EMIT_FAILURE_LOG_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Server discovery
// ---------------------------------------------------------------------------

/**
 * Discover the running event server port from the global cache directory.
 *
 * Why: The global server model uses a single port file for all projects.
 * This function reads it directly so any app can find the server without
 * knowing its own `appRoot` (no per-app cache key needed for discovery).
 *
 * Falls back to the legacy side-quest-git per-app cache path during the
 * migration period so existing side-quest-git consumers keep working.
 *
 * @param appRoot - Optional appRoot for legacy path fallback lookup
 * @returns Port and baseUrl if a server is discoverable, null otherwise
 *
 * @example
 * ```ts
 * const server = discoverEventServer()
 * if (server) {
 *   await emitEvent(envelope, server.port)
 * }
 * ```
 */
export function discoverEventServer(
	appRoot?: string,
): { port: number; baseUrl: string } | null {
	// Primary: global cache path (new global server model)
	const globalPortFile = path.join(GLOBAL_CACHE_DIR, 'events.port')
	if (pathExistsSync(globalPortFile)) {
		try {
			const port = Number.parseInt(readTextFileSync(globalPortFile).trim(), 10)
			if (!Number.isNaN(port) && port > 0) {
				return { port, baseUrl: `http://127.0.0.1:${port}` }
			}
		} catch {
			// Fall through to legacy path
		}
	}

	// Fallback: legacy side-quest-git per-app cache path (migration period only)
	if (appRoot) {
		try {
			const legacyCacheKey = getAppCacheKey(appRoot)
			const legacyPortFile = path.join(
				LEGACY_CACHE_BASE,
				legacyCacheKey,
				'events.port',
			)
			if (pathExistsSync(legacyPortFile)) {
				const port = Number.parseInt(
					readTextFileSync(legacyPortFile).trim(),
					10,
				)
				if (!Number.isNaN(port) && port > 0) {
					return { port, baseUrl: `http://127.0.0.1:${port}` }
				}
			}
		} catch {
			// No legacy server running
		}
	}

	return null
}

/**
 * Check if the event server is running by inspecting PID and port files.
 *
 * Why: Fast path -- if no PID file exists, skip HTTP entirely.
 * Checking a file takes <1ms vs. HTTP connection setup.
 *
 * Uses the global cache directory (new model). The `appRoot` parameter
 * enables the legacy side-quest-git fallback for migration compatibility.
 *
 * @param appRoot - Optional appRoot for legacy cache path fallback
 * @returns The port number if the server is running, null otherwise
 */
export function isEventServerRunning(appRoot?: string): number | null {
	const pidPath = path.join(GLOBAL_CACHE_DIR, 'events.pid')
	const portPath = path.join(GLOBAL_CACHE_DIR, 'events.port')

	try {
		if (!pathExistsSync(pidPath) || !pathExistsSync(portPath)) {
			// Try legacy fallback if appRoot provided
			if (appRoot) {
				const discovered = discoverEventServer(appRoot)
				return discovered?.port ?? null
			}
			return null
		}

		const pid = Number.parseInt(readTextFileSync(pidPath).trim(), 10)
		const port = Number.parseInt(readTextFileSync(portPath).trim(), 10)

		// Check if process is alive
		process.kill(pid, 0)
		return port
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Emit functions
// ---------------------------------------------------------------------------

/**
 * Emit an event to the local event bus (fire-and-forget).
 *
 * Why: Every CLI command should emit an event for observability,
 * but emission must never block or fail the command itself.
 * Uses 500ms AbortController timeout and catches all errors.
 *
 * Failure logging is rate-limited to once per 30 seconds to avoid
 * spamming stderr on prolonged server outages while still providing
 * visibility that events are being dropped.
 *
 * @param event - The event envelope to send
 * @param port - The port the event server is listening on
 */
export async function emitEvent(
	event: EventEnvelope,
	port: number,
): Promise<void> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 500)

	try {
		await fetch(`http://127.0.0.1:${port}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(event),
			signal: controller.signal,
		})
		// Reset failure counter on success
		emitFailures = 0
	} catch (err) {
		emitFailures++
		// Rate-limited logging: at most once per 30 seconds
		const now = Date.now()
		if (now - lastEmitFailureLogAt >= EMIT_FAILURE_LOG_INTERVAL_MS) {
			lastEmitFailureLogAt = now
			process.stderr.write(`[emitter] emit failure #${emitFailures}: ${err}\n`)
		}
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * Convenience: create and emit an event in one call.
 *
 * Why: Reduces boilerplate in CLI commands. Handles the full
 * "is server running? create envelope, POST it" flow.
 *
 * @param type - The event type discriminator
 * @param data - Event-specific payload
 * @param context - Shared context (app, appRoot, source, optional correlationId)
 */
export async function emitCliEvent<T>(
	type: EventType,
	data: T,
	context: EventContext,
): Promise<void> {
	const port = isEventServerRunning(context.appRoot)
	if (port === null) return // Fast path: no server

	const event = createEvent(type, data, context)
	await emitEvent(event, port)
}
