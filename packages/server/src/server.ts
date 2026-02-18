/**
 * HTTP + WebSocket event bus server using Bun.serve().
 *
 * Why: Provides a global event bus that CLI commands and Claude Code hooks
 * can POST events to, with real-time WebSocket broadcast for dashboards
 * and tail-style consumers. A single server handles events from all projects;
 * each event carries `appRoot` (cwd) so consumers can filter by project.
 * PID/port/nonce files at ~/.cache/side-quest-observability/ enable process
 * discovery and identity verification across processes.
 *
 * Routes:
 *   POST /events/:eventName  - Raw hook stdin (dumb hook model) -- server enriches
 *   POST /events             - Pre-built EventEnvelope (programmatic clients)
 *   GET  /events             - Query history with ?type=, ?since=, ?limit=
 *   GET  /health             - Server diagnostics including nonce identity
 *   POST /voice/notify       - Trigger voice clip playback (external consumers)
 *   WS   /ws                 - Real-time event stream (optional ?type= filter)
 *   OPTIONS *                - CORS preflight
 */

import { existsSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path, { join } from 'node:path'
import {
	ensureDirSync,
	pathExistsSync,
	readTextFileSync,
	writeTextFileSync,
} from '@side-quest/core/fs'
import { generateCorrelationId } from '@side-quest/core/instrumentation'
import { nanoId } from '@side-quest/core/utils'
import type { Server } from 'bun'
import { createEvent } from './schema.js'
import { EventStore } from './store.js'
import type { EventEnvelope, EventType } from './types.js'
import { cacheGet, cacheKey } from './voice/cache.js'
import { loadVoiceConfig } from './voice/config.js'
import { PlaybackQueue } from './voice/queue.js'
import { handleVoiceNotify } from './voice/router.js'
import type { VoiceSystemConfig } from './voice/types.js'
import { selectPhrase, VOICE_MAP } from './voice/voices.js'

// ---------------------------------------------------------------------------
// Global cache directory -- one server for all projects
// ---------------------------------------------------------------------------

/** Global cache directory for PID/port/nonce discovery files. */
const GLOBAL_CACHE_DIR = path.join(
	os.homedir(),
	'.cache',
	'side-quest-observability',
)

// ---------------------------------------------------------------------------
// CORS headers applied to every response
// ---------------------------------------------------------------------------

/** CORS headers applied to every HTTP response. */
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
} as const

/** Maximum accepted HTTP request body size (1MB). */
const MAX_BODY_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// Event name -> EventType mapping for hook ingress
// ---------------------------------------------------------------------------

/**
 * Maps URL path event names (kebab-case) to typed EventType values.
 *
 * Why: Claude Code hook names use kebab-case in the URL path (matching
 * how they appear in `claude_hooks` config), but the EventType union uses
 * snake_case with the `hook.` prefix. Centralising the mapping here keeps
 * the enrichment pipeline readable and makes v2 additions obvious.
 */
const EVENT_NAME_MAP: Record<string, EventType> = {
	'session-start': 'hook.session_start',
	'pre-tool-use': 'hook.pre_tool_use',
	'post-tool-use': 'hook.post_tool_use',
	'post-tool-use-failure': 'hook.post_tool_use_failure',
	stop: 'hook.stop',
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for starting the event server. */
export interface ServerOptions {
	/** Port to listen on (0 for auto-assign, default: 7483). */
	readonly port?: number
	/** Application name used as the default `app` field in events. */
	readonly appName: string
	/** Absolute path to the application root. Used as default `appRoot` in events. Optional -- defaults to process.cwd(). */
	readonly appRoot?: string
	/** Host interface to bind to (default: 127.0.0.1). */
	readonly hostname?: string
	/** Ring buffer capacity (default: 1000). */
	readonly capacity?: number
	/** Path for JSONL persistence file. */
	readonly persistPath?: string
	/** Optional absolute path to dashboard dist (primarily for tests). */
	readonly dashboardDistDir?: string
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** WebSocket client data for Bun pub/sub. */
interface WsClientData {
	readonly url: string
}

// ---------------------------------------------------------------------------
// PID/port/nonce file utilities
// ---------------------------------------------------------------------------

/**
 * Check if a PID is still running.
 *
 * Why: Stale PID files from crashed servers need detection
 * so we can clean them up and start a fresh server.
 *
 * @param pid - Process ID to check
 * @returns true if the process exists
 */
function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false
	}

	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Write PID, port, and nonce files for process discovery.
 *
 * Why: Other CLI commands and hooks need to find the running
 * event server's port to POST events or connect via WebSocket.
 * The nonce allows identity verification to prevent PID-reuse
 * misrouting after a crash.
 *
 * @param port - The port the server is listening on
 * @param pid - The server's process ID
 * @returns The generated nonce string
 */
function writePidFiles(port: number, pid: number): string {
	ensureDirSync(GLOBAL_CACHE_DIR)
	const serverNonce = nanoId()
	writeTextFileSync(path.join(GLOBAL_CACHE_DIR, 'events.port'), String(port))
	writeTextFileSync(path.join(GLOBAL_CACHE_DIR, 'events.pid'), String(pid))
	writeTextFileSync(path.join(GLOBAL_CACHE_DIR, 'events.nonce'), serverNonce)
	return serverNonce
}

/**
 * Remove PID, port, and nonce files on shutdown.
 *
 * Why: Clean shutdown should remove discovery files so other
 * processes don't try to connect to a dead server. Best-effort
 * only -- a crash before cleanup is handled by stale PID detection.
 */
function removePidFiles(): void {
	const files = ['events.port', 'events.pid', 'events.nonce']
	for (const f of files) {
		const filePath = path.join(GLOBAL_CACHE_DIR, f)
		try {
			if (pathExistsSync(filePath)) unlinkSync(filePath)
		} catch {
			// Best-effort cleanup
		}
	}
}

// ---------------------------------------------------------------------------
// Server discovery (for external callers)
// ---------------------------------------------------------------------------

/**
 * Read the event server port from the global cache directory.
 *
 * Why: CLI commands need to discover the running server's port to POST
 * events or connect via WebSocket. Verifies the PID is alive before
 * returning the port so callers don't connect to a dead server.
 *
 * @returns Port number if a live server is running, null otherwise
 */
export function readEventServerPort(): number | null {
	const pidFile = path.join(GLOBAL_CACHE_DIR, 'events.pid')
	const portFile = path.join(GLOBAL_CACHE_DIR, 'events.port')

	try {
		const pid = Number.parseInt(readTextFileSync(pidFile), 10)
		const port = Number.parseInt(readTextFileSync(portFile), 10)
		const validPid = Number.isInteger(pid) && pid > 0
		const validPort = Number.isInteger(port) && port >= 1 && port <= 65_535

		// Invalid cache values are treated as stale discovery files.
		if (!validPid || !validPort) {
			removePidFiles()
			return null
		}

		if (!isProcessRunning(pid)) {
			removePidFiles()
			return null
		}

		return port
	} catch {
		// Files missing or unreadable (race with shutdown)
		return null
	}
}

// ---------------------------------------------------------------------------
// Enrichment pipeline (dumb hook, smart server)
// ---------------------------------------------------------------------------

/**
 * Map a URL path event name to its canonical EventType.
 *
 * Why: The EVENT_NAME_MAP covers v1 hook types. Unknown names fall back to
 * `hook.<snake_case>` which is forward-compatible with new hook types added
 * in Claude Code without requiring a server update.
 *
 * @param name - Kebab-case event name from the URL path (e.g. "pre-tool-use")
 * @returns The canonical EventType (e.g. "hook.pre_tool_use")
 */
function mapEventName(name: string): EventType {
	return EVENT_NAME_MAP[name] ?? `hook.${name.replace(/-/g, '_')}`
}

/**
 * Truncate a value to a JSON string no longer than maxLen characters.
 *
 * Why: Claude Code can produce very large tool_input and tool_result
 * payloads. Truncating at the server prevents the ring buffer from being
 * dominated by a single large event and keeps WebSocket frames small.
 *
 * @param value - Any JSON-serialisable value
 * @param maxLen - Maximum character length (default: 2000)
 * @returns The original value if small enough, or a truncated string with "..." suffix
 */
function truncateField(value: unknown, maxLen = 2000): unknown {
	const str = JSON.stringify(value ?? '')
	if (str.length <= maxLen) return value
	return `${str.slice(0, maxLen)}...`
}

/**
 * Extract event-specific fields from raw Claude Code hook stdin.
 *
 * Why: The hook sends the full stdin JSON without transformation.
 * The server normalises field names (camelCase), truncates large payloads,
 * and drops fields irrelevant to the event type. This keeps stored envelopes
 * compact and consistently shaped regardless of which hook fired.
 *
 * @param eventName - Kebab-case event name (e.g. "pre-tool-use")
 * @param raw - Raw hook stdin payload as a parsed object
 * @returns Normalised event data object ready for the envelope's `data` field
 */
function extractEventFields(
	eventName: string,
	raw: Record<string, unknown>,
): Record<string, unknown> {
	switch (eventName) {
		case 'session-start':
			return {
				hookEvent: 'session_start',
				sessionId: raw.session_id,
				source: raw.source ?? 'unknown',
				model: raw.model ?? '',
				agentType: raw.agent_type,
				permissionMode: raw.permission_mode,
			}
		case 'pre-tool-use': {
			return {
				hookEvent: 'pre_tool_use',
				sessionId: raw.session_id,
				toolName: raw.tool_name ?? '',
				toolInputPreview: truncateField(raw.tool_input),
				permissionMode: raw.permission_mode,
			}
		}
		case 'post-tool-use': {
			return {
				hookEvent: 'post_tool_use',
				sessionId: raw.session_id,
				toolName: raw.tool_name ?? '',
				toolUseId: raw.tool_use_id ?? '',
				toolResultPreview: truncateField(raw.tool_result),
				permissionMode: raw.permission_mode,
			}
		}
		case 'post-tool-use-failure':
			return {
				hookEvent: 'post_tool_use_failure',
				sessionId: raw.session_id,
				toolName: raw.tool_name ?? '',
				toolUseId: raw.tool_use_id ?? '',
				toolError: String(raw.tool_error ?? ''),
				permissionMode: raw.permission_mode,
			}
		case 'stop':
			return {
				hookEvent: 'stop',
				sessionId: raw.session_id,
				transcriptPath: raw.transcript_path,
				permissionMode: raw.permission_mode,
			}
		default:
			// Unknown event -- pass through raw payload for forward-compatibility
			return { hookEvent: eventName, sessionId: raw.session_id, raw }
	}
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/**
 * Resolve the Vue dashboard dist directory, checking candidate paths in order.
 *
 * Why: The dashboard assets live at different relative paths depending on
 * how the server is running:
 * - Dev (source): `../../client/dist` (sibling package in monorepo)
 * - npm (built server bundle): `public` (embedded by postbuild)
 *
 * Falls back gracefully -- API routes still work if no dashboard is found,
 * the dashboard just returns 404.
 *
 * @returns Absolute path to the dashboard dist directory, or null if not found
 */
function resolveClientDistDir(preferredDir?: string): string | null {
	const candidates = [
		preferredDir,
		join(import.meta.dir, '../../client/dist'),
		join(import.meta.dir, 'public'),
	].filter((candidate): candidate is string => typeof candidate === 'string')

	for (const candidate of candidates) {
		if (existsSync(join(candidate, 'index.html'))) {
			return candidate
		}
	}

	return null
}

/**
 * Serve a static file from the built Vue dashboard dist directory.
 *
 * Why: The observability server doubles as a static file server so the Vue
 * dashboard is accessible at the same origin as the API -- no separate web
 * server or CORS complexity for the SPA. Bun.file() auto-detects Content-Type
 * from the file extension. If the file is not found, falls back to index.html
 * (SPA routing) and then to 404 if dist/ doesn't exist at all.
 *
 * Caching strategy:
 * - index.html: no-cache (always re-fetch to pick up new hashed asset URLs)
 * - all other assets: immutable (Vite hashes filenames -- safe to cache forever)
 *
 * @param pathname - URL pathname from the incoming request
 * @param preferredDashboardDir - Optional dashboard dist path override
 * @returns Response with the file contents or 404
 */
async function serveStaticFile(
	pathname: string,
	preferredDashboardDir?: string,
): Promise<Response> {
	const clientDistDir = resolveClientDistDir(preferredDashboardDir)

	if (!clientDistDir) {
		return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
	}

	const filePath =
		pathname === '/'
			? join(clientDistDir, 'index.html')
			: join(clientDistDir, pathname)

	const file = Bun.file(filePath)
	if (await file.exists()) {
		const isIndex = filePath.endsWith('index.html')
		const cacheControl = isIndex
			? 'no-cache'
			: 'public, max-age=31536000, immutable'
		return new Response(file, {
			headers: { ...CORS_HEADERS, 'Cache-Control': cacheControl },
		})
	}

	// SPA fallback -- serve index.html for client-side routes (e.g. /sessions/123)
	const indexFile = Bun.file(join(clientDistDir, 'index.html'))
	if (await indexFile.exists()) {
		return new Response(indexFile, {
			headers: { ...CORS_HEADERS, 'Cache-Control': 'no-cache' },
		})
	}

	// dist/ missing entirely -- return 404 (API routes above still work)
	return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isValidTimestamp(value: string): boolean {
	return !Number.isNaN(Date.parse(value))
}

async function parseJsonObjectBody(
	req: Request,
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; response: Response }
> {
	// Fast-path guard when Content-Length is available.
	const contentLength = req.headers.get('content-length')
	if (
		contentLength &&
		Number.isFinite(Number.parseInt(contentLength, 10)) &&
		Number.parseInt(contentLength, 10) > MAX_BODY_BYTES
	) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Request body too large (max 1MB)' },
				{ status: 413, headers: CORS_HEADERS },
			),
		}
	}

	let rawBytes: ArrayBuffer
	try {
		rawBytes = await req.arrayBuffer()
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Invalid JSON body' },
				{ status: 400, headers: CORS_HEADERS },
			),
		}
	}

	// Enforces the same limit for chunked requests with no Content-Length.
	if (rawBytes.byteLength > MAX_BODY_BYTES) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Request body too large (max 1MB)' },
				{ status: 413, headers: CORS_HEADERS },
			),
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(rawBytes))
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Invalid JSON body' },
				{ status: 400, headers: CORS_HEADERS },
			),
		}
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Body must be a JSON object' },
				{ status: 400, headers: CORS_HEADERS },
			),
		}
	}

	return {
		ok: true,
		body: parsed as Record<string, unknown>,
	}
}

function validateFullEnvelope(
	body: Record<string, unknown>,
): { ok: true; event: EventEnvelope } | { ok: false; error: string } {
	if (body.schemaVersion !== '1.0.0') {
		return { ok: false, error: `Unknown schemaVersion: ${body.schemaVersion}` }
	}
	if (!isNonEmptyString(body.id)) {
		return { ok: false, error: 'Missing or invalid "id" field' }
	}
	if (!isNonEmptyString(body.timestamp) || !isValidTimestamp(body.timestamp)) {
		return { ok: false, error: 'Missing or invalid "timestamp" field' }
	}
	if (!isNonEmptyString(body.type)) {
		return { ok: false, error: 'Missing or invalid "type" field' }
	}
	if (!isNonEmptyString(body.app)) {
		return { ok: false, error: 'Missing or invalid "app" field' }
	}
	if (!isNonEmptyString(body.appRoot)) {
		return { ok: false, error: 'Missing or invalid "appRoot" field' }
	}
	if (body.source !== 'cli' && body.source !== 'hook') {
		return { ok: false, error: 'Missing or invalid "source" field' }
	}
	if (!isNonEmptyString(body.correlationId)) {
		return { ok: false, error: 'Missing or invalid "correlationId" field' }
	}
	if (!('data' in body)) {
		return { ok: false, error: 'Missing "data" field' }
	}

	return {
		ok: true,
		event: {
			schemaVersion: '1.0.0',
			id: body.id,
			timestamp: body.timestamp,
			type: body.type as EventType,
			app: body.app,
			appRoot: body.appRoot,
			source: body.source,
			correlationId: body.correlationId,
			data: body.data,
		},
	}
}

/**
 * Handle POST /events/:eventName -- raw hook stdin ingress.
 *
 * Why: Claude Code hooks are dumb -- they pipe raw stdin to HTTP with the
 * event name in the URL. The server does all enrichment: type mapping,
 * field normalisation, truncation, envelope generation, and stop_hook_active
 * guard. This keeps the hook implementation at ~10 lines with zero logic.
 *
 * Voice trigger: On Stop events, triggerVoice() is called in-process after
 * the envelope is stored and broadcast. The ~2ms overhead is non-blocking --
 * afplay drains asynchronously after the HTTP response is returned.
 *
 * @param req - Incoming HTTP request
 * @param eventName - Kebab-case event name from the URL path
 * @param store - The event ring buffer
 * @param bunServer - The Bun server instance for WebSocket pub/sub
 * @param defaultAppRoot - Default appRoot when not in the hook payload
 * @param queue - Optional PlaybackQueue for voice triggering (null if voice disabled)
 * @param voiceConfig - Voice system config (mode, cacheDir)
 * @returns HTTP response with CORS headers
 */
async function handleHookEvent(
	req: Request,
	eventName: string,
	store: EventStore,
	bunServer: Server<WsClientData>,
	defaultApp: string,
	defaultAppRoot: string,
	queue?: PlaybackQueue | null,
	voiceConfig?: VoiceSystemConfig,
): Promise<Response> {
	const parsedBody = await parseJsonObjectBody(req)
	if (!parsedBody.ok) {
		return parsedBody.response
	}

	const raw = parsedBody.body

	// Stop recursion guard -- Claude Code sets this when a stop hook fires
	// a nested hook invocation, which would loop infinitely.
	if (eventName === 'stop' && raw.stop_hook_active === true) {
		return Response.json(
			{ status: 'skipped', reason: 'stop_hook_active' },
			{ status: 200, headers: CORS_HEADERS },
		)
	}

	const eventType = mapEventName(eventName)
	const appRoot = typeof raw.cwd === 'string' ? raw.cwd : defaultAppRoot
	const appName = isNonEmptyString(raw.app) ? raw.app : defaultApp

	const envelope = createEvent(eventType, extractEventFields(eventName, raw), {
		app: appName,
		appRoot,
		source: 'hook',
		correlationId: generateCorrelationId(),
	})

	store.push(envelope)

	const message = JSON.stringify(envelope)
	bunServer.publish('events.all', message)
	bunServer.publish(`events.${String(eventType)}`, message)

	// Voice trigger -- in-process, fire-and-forget (v1: Stop only, generic Computer phrase)
	// v2: expand to subagent-start/subagent-stop for per-agent triggering (zero new files needed)
	if (eventName === 'stop' && queue && voiceConfig) {
		triggerVoice('enterprise:ships-computer-cpu', 'stop', queue, voiceConfig)
	}

	return Response.json(
		{ id: envelope.id },
		{ status: 201, headers: CORS_HEADERS },
	)
}

/**
 * Handle POST /events -- pre-built EventEnvelope from programmatic clients.
 *
 * Why: Programmatic clients (CLI tools, git plugin) build their own
 * EventEnvelopes and POST them directly. The server validates required
 * fields but trusts the envelope's type and data -- there is no enrichment.
 *
 * Validation notes:
 * - Full envelopes (with schemaVersion) must have schemaVersion='1.0.0', type (string), and data
 * - Partial payloads (without schemaVersion) must have type (string) and data, and are wrapped
 * - The `type` field is validated as a string but NOT against the EventType union (runtime forward-compat)
 *
 * @param req - Incoming HTTP request
 * @param store - The event ring buffer
 * @param bunServer - The Bun server instance for WebSocket pub/sub
 * @param defaultApp - Default app name when building an envelope from a partial payload
 * @param defaultAppRoot - Default appRoot when building an envelope from a partial payload
 * @returns HTTP response with CORS headers
 */
async function handlePostEnvelope(
	req: Request,
	store: EventStore,
	bunServer: Server<WsClientData>,
	defaultApp: string,
	defaultAppRoot: string,
): Promise<Response> {
	const parsedBody = await parseJsonObjectBody(req)
	if (!parsedBody.ok) {
		return parsedBody.response
	}

	const body = parsedBody.body

	// Validate required fields
	if (typeof body.type !== 'string') {
		return Response.json(
			{ error: 'Missing or invalid "type" field' },
			{ status: 400, headers: CORS_HEADERS },
		)
	}
	if (!('data' in body)) {
		return Response.json(
			{ error: 'Missing "data" field' },
			{ status: 400, headers: CORS_HEADERS },
		)
	}

	let event: EventEnvelope

	if (body.schemaVersion !== undefined) {
		const validated = validateFullEnvelope(body)
		if (!validated.ok) {
			return Response.json(
				{ error: validated.error },
				{ status: 400, headers: CORS_HEADERS },
			)
		}
		event = validated.event
	} else {
		// Partial payload -- wrap in a full envelope
		event = createEvent(
			body.type as EventType,
			(body.data as Record<string, unknown>) ?? {},
			{
				app: isNonEmptyString(body.app) ? body.app : defaultApp,
				appRoot: isNonEmptyString(body.appRoot) ? body.appRoot : defaultAppRoot,
				source: body.source === 'hook' ? 'hook' : 'cli',
				correlationId: isNonEmptyString(body.correlationId)
					? body.correlationId
					: undefined,
			},
		)
	}

	store.push(event)

	const message = JSON.stringify(event)
	bunServer.publish('events.all', message)
	bunServer.publish(`events.${String(event.type)}`, message)

	return Response.json(
		{ ok: true, id: event.id },
		{ status: 201, headers: CORS_HEADERS },
	)
}

/**
 * Handle GET /events -- query history with optional filters.
 *
 * Supports ?type=, ?since= (ISO timestamp), and ?limit= (default 100, max 1000).
 *
 * Why: WebSocket is for live events; HTTP /events is for history and backfill.
 * This follows the "HTTP for history, WebSocket for live" pattern so consumers
 * can fetch historical events on mount without gap-loss complexity.
 *
 * @param url - Parsed request URL with query params
 * @param store - The event ring buffer
 * @returns JSON array of EventEnvelopes matching the filter
 */
function handleGetEvents(url: URL, store: EventStore): Response {
	const type = url.searchParams.get('type') as EventType | null
	const since = url.searchParams.get('since')
	const limitStr = url.searchParams.get('limit')
	const rawLimit = limitStr ? Number.parseInt(limitStr, 10) : 100
	const limit = Math.min(rawLimit, 1000)

	const events = store.query({
		type: type ?? undefined,
		since: since ?? undefined,
		limit,
	})

	return Response.json(events, { headers: CORS_HEADERS })
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

/**
 * Register SIGTERM and SIGINT handlers for graceful shutdown.
 *
 * Why: Without signal handlers, the process exits abruptly leaving stale
 * PID/port/nonce files. Subsequent server starts would incorrectly detect
 * a running server (until PID reuse is detected, which requires a stat call).
 * Clean shutdown removes discovery files immediately. queue.stop() kills any
 * in-flight afplay process to prevent orphaned audio (Operator I3).
 *
 * @param bunServer - The Bun server instance to stop
 * @param queue - Optional PlaybackQueue to stop on shutdown (kills in-flight afplay)
 */
function registerSignalHandlers(
	bunServer: Server<WsClientData>,
	queue?: PlaybackQueue | null,
): void {
	const cleanup = () => {
		queue?.stop()
		removePidFiles()
		bunServer.stop(true)
		process.exit(0)
	}
	process.on('SIGTERM', cleanup)
	process.on('SIGINT', cleanup)
}

// ---------------------------------------------------------------------------
// Voice system -- in-process trigger
// ---------------------------------------------------------------------------

/**
 * Resolve a cached voice clip and enqueue it for playback.
 *
 * Why: In-process call from the enrichment pipeline -- no HTTP round-trip,
 * no port discovery, ~2ms total overhead (phrase select + cache lookup + enqueue).
 * Playback happens asynchronously after the HTTP response is returned.
 *
 * Voice is non-critical: if mode is off, no clip is cached, or the queue is
 * full, this function returns silently. Never throws.
 *
 * @param agentType - Agent type string, e.g. 'enterprise:ships-computer-cpu'
 * @param phase - Event phase: 'start' or 'stop'
 * @param queue - The PlaybackQueue to enqueue onto
 * @param config - Voice system config (reads mode and cacheDir)
 */
function triggerVoice(
	agentType: string,
	phase: 'start' | 'stop',
	queue: PlaybackQueue,
	config: VoiceSystemConfig,
): void {
	if (config.mode === 'off') return

	const text = selectPhrase(agentType, phase)
	if (!text) return

	const entry = VOICE_MAP[agentType]
	if (!entry) return

	const hash = cacheKey(text, entry.voiceId)
	const filePath = cacheGet(hash, config.cacheDir)
	if (!filePath) return // not cached -- skip silently (pregenerated-only in v1)

	queue.enqueue({
		filePath,
		label: `${entry.label}: "${text}"`,
		enqueuedAt: Date.now(),
	})
}

// ---------------------------------------------------------------------------
// startServer -- main export
// ---------------------------------------------------------------------------

/**
 * Start the global event bus server.
 *
 * Why: Central event bus for the side-quest observability ecosystem.
 * Claude Code hooks POST raw events (enriched server-side), CLI tools POST
 * pre-built envelopes, and dashboards subscribe via WebSocket for real-time
 * updates. A single global server handles events from all projects -- each
 * event carries `appRoot` so consumers can filter by project.
 *
 * @param options - Server configuration
 * @returns The running Bun Server instance
 *
 * @example
 * ```ts
 * const server = startServer({ appName: 'my-project', port: 7483 })
 * // Server is now listening at http://127.0.0.1:7483
 * ```
 */
export function startServer(options: ServerOptions): Server<WsClientData> {
	const {
		port = 7483,
		appName,
		appRoot = process.cwd(),
		hostname = '127.0.0.1',
		capacity,
		persistPath,
		dashboardDistDir,
	} = options

	const store = new EventStore({ capacity, persistPath })
	const startTime = Date.now()

	// ---------------------------------------------------------------------------
	// Voice system -- initialise before server starts
	// ---------------------------------------------------------------------------

	const voiceConfig = loadVoiceConfig()
	const playbackQueue =
		voiceConfig.mode !== 'off'
			? new PlaybackQueue({
					maxDepth: voiceConfig.maxQueueDepth,
					maxAgeMs: voiceConfig.maxAgeMs,
					maxPlayMs: voiceConfig.maxPlayMs,
				})
			: null

	// Probe for afplay at startup -- one warning instead of per-clip silent failures (Operator I1)
	// macOS only in v1; cross-platform support deferred to v2.
	if (playbackQueue) {
		const probe = Bun.spawn(['which', 'afplay'], {
			stdout: 'ignore',
			stderr: 'ignore',
		})
		probe.exited
			.then((code) => {
				if (code !== 0) {
					process.stderr.write(
						'[voice] afplay not found -- audio will not play (macOS only)\n',
					)
				}
			})
			.catch(() => {
				process.stderr.write(
					'[voice] afplay probe failed -- audio will not play\n',
				)
			})
	}

	// Check for already-running server
	const existingPort = readEventServerPort()
	if (existingPort !== null) {
		throw new Error(`Event server already running on port ${existingPort}`)
	}

	const bunServer: Server<WsClientData> = Bun.serve<WsClientData>({
		hostname,
		port,

		async fetch(req, srv) {
			const url = new URL(req.url)

			// CORS preflight -- must come before route matching
			if (req.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: CORS_HEADERS })
			}

			// WebSocket upgrade
			if (url.pathname === '/ws') {
				const upgraded = srv.upgrade(req, {
					data: { url: req.url },
				})
				if (upgraded) return undefined
				return new Response('WebSocket upgrade failed', {
					status: 400,
					headers: CORS_HEADERS,
				})
			}

			// POST /events/:eventName -- raw hook stdin (dumb hook model)
			if (req.method === 'POST') {
				const hookMatch = url.pathname.match(/^\/events\/([^/]+)$/)
				if (hookMatch?.[1]) {
					const eventName = hookMatch[1]
					return handleHookEvent(
						req,
						eventName,
						store,
						bunServer,
						appName,
						appRoot,
						playbackQueue,
						voiceConfig,
					)
				}
			}

			// POST /voice/notify -- external voice trigger (curl, future WS services)
			// Route matches regardless of whether voice is enabled -- returns JSON error
			// instead of falling through to the SPA catch-all when voice is disabled.
			if (req.method === 'POST' && url.pathname === '/voice/notify') {
				if (!playbackQueue || voiceConfig.mode === 'off') {
					return Response.json(
						{ queued: false, reason: 'voice_disabled' },
						{ headers: CORS_HEADERS },
					)
				}
				const voiceRes = await handleVoiceNotify(
					req,
					voiceConfig,
					playbackQueue,
				)
				// Wrap response with CORS headers -- CORS is a server concern, not a router concern.
				return new Response(voiceRes.body, {
					status: voiceRes.status,
					headers: { ...Object.fromEntries(voiceRes.headers), ...CORS_HEADERS },
				})
			}

			// POST /events -- pre-built EventEnvelope
			if (req.method === 'POST' && url.pathname === '/events') {
				return handlePostEnvelope(req, store, bunServer, appName, appRoot)
			}

			// GET /events -- query history
			if (req.method === 'GET' && url.pathname === '/events') {
				return handleGetEvents(url, store)
			}

			// GET /health -- diagnostics
			if (req.method === 'GET' && url.pathname === '/health') {
				return Response.json(
					{
						status: 'ok',
						nonce: serverNonce,
						uptime: Math.floor((Date.now() - startTime) / 1000),
						events: {
							total: store.size,
							types: store.typeCounts(),
						},
						persistErrors: store.persistErrors,
						wsClients: bunServer.subscriberCount('events.all'),
						version: '1.0.0',
						voice: {
							mode: voiceConfig.mode,
							queueDepth: playbackQueue?.depth ?? 0,
							isPlaying: playbackQueue?.isPlaying ?? false,
						},
					},
					{ headers: CORS_HEADERS },
				)
			}

			// Static file serving -- built Vue dashboard (LAST -- after all API routes)
			//
			// Why: The dashboard is a SPA built by Vite into packages/client/dist/.
			// We resolve the dist directory relative to this source file so the path
			// is correct whether run via `bun --watch` (source) or from dist/ (built).
			// Bun.file() auto-detects Content-Type from the file extension, so no
			// manual MIME map is needed. Missing dist/ degrades gracefully -- API
			// routes above still work, only the dashboard returns 404.
			return serveStaticFile(url.pathname, dashboardDistDir)
		},

		websocket: {
			/**
			 * Subscribe new client to the events.all topic and optionally to a
			 * type-specific topic if ?type= is provided.
			 *
			 * Why: Bun native pub/sub handles fan-out internally with less GC
			 * pressure than manual Set iteration. Type-specific subscriptions
			 * let consumers (voice TTS, CLI tail) avoid processing every event.
			 */
			open(ws) {
				ws.subscribe('events.all')
				const url = new URL(ws.data.url)
				const typeFilter = url.searchParams.get('type')
				if (typeFilter) {
					ws.subscribe(`events.${typeFilter}`)
					ws.unsubscribe('events.all')
				}
			},
			close(_ws) {
				// Bun automatically unsubscribes on close
			},
			message(_ws, _data) {
				// v1: read-only subscription -- client messages are ignored
			},
			drain(_ws) {
				// Backpressure relief -- Bun resumes queued sends automatically
			},
			sendPings: true,
			idleTimeout: 120,
			backpressureLimit: 1024 * 1024,
			closeOnBackpressureLimit: false,
		},
	})

	// Write discovery files after server is bound
	const actualPort = bunServer.port ?? port
	const serverNonce = writePidFiles(actualPort, process.pid)

	// Clean up on process exit -- includes killing in-flight afplay (Operator I3)
	registerSignalHandlers(bunServer, playbackQueue)

	return bunServer
}
