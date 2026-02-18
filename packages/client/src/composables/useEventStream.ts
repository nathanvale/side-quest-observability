import {
	onMounted,
	onUnmounted,
	type Ref,
	ref,
	type ShallowRef,
	shallowRef,
} from 'vue'
import { config } from '../config'
import type { EventEnvelope } from '../types'

/**
 * Return type for the useEventStream composable.
 *
 * Why: Explicit interface documents the contract for callers and ensures
 * TypeScript catches accidental mutation of readonly reactive state.
 */
export interface UseEventStreamReturn {
	/** Immutable snapshot of received events (shallowRef for performance). */
	events: ShallowRef<EventEnvelope[]>
	/** True when the WebSocket connection is open. */
	isConnected: Ref<boolean>
	/** Last connection error message, or null when healthy. */
	error: Ref<string | null>
	/** Number of reconnection attempts since last successful connect. */
	connectionAttempts: Ref<number>
	/** Events received in the last 60 seconds (sliding window). */
	eventsPerMinute: Ref<number>
	/** Clear all buffered events. */
	clearEvents: () => void
}

/**
 * Composable for streaming events from the observability server.
 *
 * Why: Separates the network/state concerns from UI components.
 * Uses shallowRef for the events array so deep reactivity is not
 * applied to 500 immutable event objects -- only the array reference
 * triggers reactivity on replace.
 *
 * Connection strategy:
 * 1. On mount: fetch GET /events for history (chunked with rAF between)
 * 2. Open WebSocket for live events
 * 3. Batch incoming WS messages into a single reactivity trigger per frame
 * 4. Reconnect with exponential backoff + jitter on disconnect
 * 5. Re-fetch history on reconnect to fill gap, deduplicate by event.id
 * 6. Defer rendering when browser tab is hidden (visibilitychange API)
 *
 * @param serverUrl - Base URL for the event server (e.g. http://127.0.0.1:7483)
 * @returns Reactive state and control methods
 */
export function useEventStream(
	serverUrl: string = config.serverUrl,
): UseEventStreamReturn {
	// -------------------------------------------------------------------------
	// Reactive state
	// -------------------------------------------------------------------------

	/**
	 * Why shallowRef: Events are immutable once received. Deep reactive Proxy
	 * on 500 objects with nested data is pure waste -- each rAF batch flush
	 * replaces the array reference, triggering a single shallow reactivity cascade.
	 */
	const events = shallowRef<EventEnvelope[]>([])
	const isConnected = ref(false)
	const error = ref<string | null>(null)
	const connectionAttempts = ref(0)
	const eventsPerMinute = ref(0)

	const maxEvents = config.maxEvents

	// -------------------------------------------------------------------------
	// Non-reactive internals (no reactivity needed -- internal mechanics only)
	// -------------------------------------------------------------------------

	/** Pending WS events not yet flushed to the reactive events array. */
	let pendingEvents: EventEnvelope[] = []
	/** True when a rAF flush is already scheduled. */
	let flushScheduled = false
	/** True when the browser tab is visible. */
	let tabVisible = true
	/** Current WebSocket connection. */
	let ws: WebSocket | null = null
	/** Reconnect timer handle. */
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	/** Sliding window of event timestamps for events/min calculation. */
	let eventTimestamps: number[] = []

	// -------------------------------------------------------------------------
	// Events per minute (sliding 60-second window)
	// -------------------------------------------------------------------------

	/**
	 * Update the events/min counter from the sliding timestamp window.
	 *
	 * Why: Computed properties re-evaluate on every dependency access.
	 * A manual sliding window updated only on flush avoids unnecessary
	 * recalculation when nothing has changed.
	 */
	function updateEventsPerMinute(): void {
		const now = Date.now()
		const cutoff = now - 60_000
		// Remove timestamps older than 60s
		eventTimestamps = eventTimestamps.filter((t) => t > cutoff)
		eventsPerMinute.value = eventTimestamps.length
	}

	// -------------------------------------------------------------------------
	// Batch flush (performance-critical path)
	// -------------------------------------------------------------------------

	/**
	 * Flush pending WS events into the reactive events array.
	 *
	 * Why: Instead of triggering reactivity on every WS message (potentially
	 * 10+/sec), we accumulate into a non-reactive buffer and flush once per
	 * animation frame. This collapses N events into a single reactivity cascade,
	 * preventing 6 computed re-evaluations per event at high rates.
	 */
	function flushBatch(): void {
		flushScheduled = false

		// Accumulate events while tab is hidden -- flush on tab focus
		if (!tabVisible) return
		if (pendingEvents.length === 0) return

		const batch = pendingEvents
		pendingEvents = []

		// Record timestamps for events/min counter
		const now = Date.now()
		for (let i = 0; i < batch.length; i++) {
			eventTimestamps.push(now)
		}
		updateEventsPerMinute()

		const current = events.value
		const combined = [...current, ...batch]

		// Trim oldest events when exceeding maxEvents (batch trim, not per-event)
		events.value =
			combined.length > maxEvents
				? combined.slice(combined.length - maxEvents)
				: combined
	}

	/**
	 * Schedule a flush on the next animation frame.
	 *
	 * Why: requestAnimationFrame coalesces multiple WS messages arriving
	 * in the same tick into a single DOM update, keeping the UI smooth.
	 */
	function scheduleBatchFlush(): void {
		if (!flushScheduled) {
			flushScheduled = true
			requestAnimationFrame(flushBatch)
		}
	}

	// -------------------------------------------------------------------------
	// History fetch (HTTP -- chunked with rAF between chunks)
	// -------------------------------------------------------------------------

	/**
	 * Fetch event history from GET /events and merge into the buffer.
	 *
	 * Why: The WebSocket only streams live events -- history is an HTTP concern.
	 * Processing in chunks of 50 with rAF between prevents a large history
	 * batch from freezing the UI on mount or reconnect.
	 *
	 * @param deduplicateIds - Set of event IDs already in the buffer (for reconnect)
	 */
	async function fetchHistory(deduplicateIds?: Set<string>): Promise<void> {
		try {
			const response = await fetch(`${serverUrl}/events?limit=500`)
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const history = (await response.json()) as EventEnvelope[]
			if (!Array.isArray(history) || history.length === 0) return

			// Deduplicate on reconnect to avoid showing events received while
			// the WebSocket was up but before the reconnect history fetch
			const filtered = deduplicateIds
				? history.filter((e) => !deduplicateIds.has(e.id))
				: history

			if (filtered.length === 0) return

			// Process in chunks of 50 with rAF between to avoid UI freeze
			const chunkSize = 50
			let offset = 0

			function processChunk(): void {
				const chunk = filtered.slice(offset, offset + chunkSize)
				offset += chunkSize

				if (chunk.length > 0) {
					const current = events.value
					const combined = [...current, ...chunk]
					events.value =
						combined.length > maxEvents
							? combined.slice(combined.length - maxEvents)
							: combined
				}

				if (offset < filtered.length) {
					requestAnimationFrame(processChunk)
				}
			}

			requestAnimationFrame(processChunk)
		} catch (err) {
			// History fetch failure is non-fatal -- live events still stream
			error.value = `History fetch failed: ${err instanceof Error ? err.message : String(err)}`
		}
	}

	// -------------------------------------------------------------------------
	// WebSocket connection
	// -------------------------------------------------------------------------

	/**
	 * Compute reconnect delay with exponential backoff + jitter.
	 *
	 * Why: Pure exponential backoff causes thundering-herd reconnects when
	 * the server restarts. Jitter spreads reconnect attempts over a window,
	 * reducing server load on recovery. Max cap prevents infinite growth.
	 *
	 * @param attempts - Number of failed attempts so far
	 * @returns Delay in milliseconds
	 */
	function getReconnectDelay(attempts: number): number {
		const base = 3000 * 2 ** Math.min(attempts, 8)
		const jitter = Math.random() * 1000
		return Math.min(base + jitter, 30_000)
	}

	/**
	 * Schedule a WebSocket reconnect attempt.
	 *
	 * Why: Called on WS close so the dashboard self-heals without user action.
	 * Clears any existing timer to avoid double-reconnect races.
	 */
	function scheduleReconnect(): void {
		if (reconnectTimer !== null) clearTimeout(reconnectTimer)
		const delay = getReconnectDelay(connectionAttempts.value)
		reconnectTimer = setTimeout(() => {
			connectionAttempts.value++
			connect()
		}, delay)
	}

	/**
	 * Open a WebSocket connection to the event server.
	 *
	 * Why: Separate function from mount so reconnect logic can call it
	 * without repeating the handler setup. The WS URL is derived from
	 * serverUrl by replacing http(s) with ws(s).
	 */
	function connect(): void {
		// Clean up any existing connection before opening a new one
		if (ws !== null) {
			ws.onclose = null // Prevent double-reconnect
			ws.close()
			ws = null
		}

		const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws`

		try {
			ws = new WebSocket(wsUrl)
		} catch (err) {
			error.value = `WebSocket creation failed: ${err instanceof Error ? err.message : String(err)}`
			scheduleReconnect()
			return
		}

		ws.onopen = () => {
			isConnected.value = true
			error.value = null

			// Re-fetch history on reconnect to fill the gap during disconnection.
			// Build a deduplication set from current events to avoid duplicates.
			const knownIds = new Set(events.value.map((e) => e.id))
			connectionAttempts.value = 0
			fetchHistory(knownIds)
		}

		ws.onmessage = (event: MessageEvent<string>) => {
			try {
				const envelope = JSON.parse(event.data) as EventEnvelope
				pendingEvents.push(envelope)
				scheduleBatchFlush()
			} catch {
				// Malformed frame -- skip silently
			}
		}

		ws.onclose = () => {
			isConnected.value = false
			ws = null
			scheduleReconnect()
		}

		ws.onerror = () => {
			error.value = 'WebSocket connection error'
			// onclose fires after onerror, which handles reconnect
		}
	}

	// -------------------------------------------------------------------------
	// Tab visibility -- defer rendering when hidden
	// -------------------------------------------------------------------------

	/**
	 * Handle browser tab visibility changes.
	 *
	 * Why: When the tab is hidden, rAF flushes are deferred (the browser
	 * throttles rAF in hidden tabs anyway). When the tab becomes visible again,
	 * flush any accumulated events immediately so the feed is up to date.
	 */
	function handleVisibilityChange(): void {
		tabVisible = document.visibilityState === 'visible'
		if (tabVisible && pendingEvents.length > 0) {
			flushBatch()
		}
	}

	// -------------------------------------------------------------------------
	// Public control methods
	// -------------------------------------------------------------------------

	/** Clear all buffered events (useful for debugging). */
	function clearEvents(): void {
		events.value = []
		pendingEvents = []
		eventTimestamps = []
		eventsPerMinute.value = 0
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	onMounted(() => {
		document.addEventListener('visibilitychange', handleVisibilityChange)
		// Fetch history first, then open WebSocket for live events
		fetchHistory().then(() => connect())
	})

	onUnmounted(() => {
		document.removeEventListener('visibilitychange', handleVisibilityChange)

		if (reconnectTimer !== null) {
			clearTimeout(reconnectTimer)
			reconnectTimer = null
		}

		if (ws !== null) {
			ws.onclose = null // Prevent reconnect on intentional unmount
			ws.close()
			ws = null
		}
	})

	return {
		events,
		isConnected,
		error,
		connectionAttempts,
		eventsPerMinute,
		clearEvents,
	}
}
