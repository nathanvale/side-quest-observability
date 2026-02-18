/**
 * WebSocket client for consuming real-time events from the event bus.
 *
 * Why: Consumers (dashboards, CLI tail, hooks) need a simple way
 * to subscribe to real-time events without polling. Auto-reconnect
 * with exponential backoff + jitter handles transient disconnections
 * gracefully without causing retry storms.
 */

import type { EventEnvelope } from './types.js'

/** Base reconnect delay in milliseconds (1 second). */
const BASE_RECONNECT_DELAY_MS = 1_000

/** Maximum reconnect delay in milliseconds (30 seconds). */
const MAX_RECONNECT_DELAY_MS = 30_000

/** Options for connecting to the event bus WebSocket. */
export interface EventClientOptions {
	/** Port the event server is listening on. */
	readonly port: number
	/** Optional event type filter (only receive events of this type). */
	readonly typeFilter?: string
	/** Callback invoked for each received event. */
	readonly onEvent: (event: EventEnvelope) => void
	/** Callback invoked on connection errors. */
	readonly onError?: (error: Error) => void
	/** Hostname to connect to (default: 'localhost'). */
	readonly host?: string
	/** Whether to auto-reconnect on disconnect (default: true). */
	readonly autoReconnect?: boolean
	/**
	 * Base delay in ms before first reconnection attempt (default: 1000).
	 * Actual delay grows exponentially with jitter up to 30s.
	 */
	readonly reconnectDelay?: number
}

/** Handle for a connected event client. */
export interface EventClientHandle {
	/** Close the WebSocket connection and stop reconnecting. */
	close(): void
}

/**
 * Connect a WebSocket client to the event bus server.
 *
 * Why: Provides a simple, auto-reconnecting WebSocket client
 * that consumers can use to subscribe to real-time events.
 * The type filter is passed as a query parameter so the server
 * only broadcasts matching events, reducing bandwidth.
 *
 * Reconnection uses exponential backoff with jitter to prevent
 * thundering-herd retry storms when the server restarts:
 *   delay = min(baseDelay * 2^attempt + jitter(0-1000ms), 30s)
 * The attempt counter resets to 0 on each successful connection.
 *
 * @param options - Client configuration
 * @returns Handle with a close() method to disconnect
 */
export function connectEventClient(
	options: EventClientOptions,
): EventClientHandle {
	const {
		port,
		typeFilter,
		onEvent,
		onError,
		host = 'localhost',
		autoReconnect = true,
		reconnectDelay = BASE_RECONNECT_DELAY_MS,
	} = options

	let closed = false
	let ws: WebSocket | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let attempt = 0

	function connect(): void {
		if (closed) return

		const filterParam = typeFilter
			? `?type=${encodeURIComponent(typeFilter)}`
			: ''
		const url = `ws://${host}:${port}/ws${filterParam}`

		ws = new WebSocket(url)

		ws.onopen = () => {
			// Reset backoff on successful connection
			attempt = 0
		}

		ws.onmessage = (event) => {
			try {
				const envelope = JSON.parse(
					typeof event.data === 'string'
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer),
				) as EventEnvelope
				onEvent(envelope)
			} catch (error) {
				onError?.(
					error instanceof Error ? error : new Error('Failed to parse event'),
				)
			}
		}

		ws.onerror = (event) => {
			const errorEvent = event as ErrorEvent
			onError?.(new Error(errorEvent.message ?? 'WebSocket error'))
		}

		ws.onclose = () => {
			ws = null
			if (!closed && autoReconnect) {
				// Exponential backoff with jitter: min(base * 2^attempt + rand(0..1000ms), maxDelay)
				const base = Math.min(
					reconnectDelay * 2 ** attempt,
					MAX_RECONNECT_DELAY_MS,
				)
				const jitter = Math.random() * 1000
				reconnectTimer = setTimeout(connect, base + jitter)
				attempt++
			}
		}
	}

	connect()

	return {
		close() {
			closed = true
			if (reconnectTimer) {
				clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
			if (ws) {
				ws.close(1000, 'client closing')
				ws = null
			}
		},
	}
}
