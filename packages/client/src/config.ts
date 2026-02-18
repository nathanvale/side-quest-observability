/**
 * Runtime configuration for the observability dashboard.
 *
 * Why: Centralising env var access here means components reference
 * config.serverUrl rather than scatter import.meta.env calls across
 * the codebase. Easy to swap in different values for testing.
 */
export const config = {
	/** Base URL for the event server (HTTP history + WebSocket). */
	serverUrl: import.meta.env.VITE_SERVER_URL || defaultServerUrl(),
	/**
	 * Maximum number of events held in the in-memory buffer.
	 * Oldest events are dropped when this limit is exceeded.
	 */
	maxEvents: Number.parseInt(import.meta.env.VITE_MAX_EVENTS || '500', 10),
} as const

/**
 * Resolve the default event-server base URL for common runtime modes.
 *
 * Why:
 * - Embedded mode (served by observability server): use same-origin so any
 *   runtime port works (e.g. 7483, 7510, random test ports).
 * - Vite dev/preview mode (5173/4173): keep API target on 7483 by default.
 */
function defaultServerUrl(): string {
	if (typeof window === 'undefined') {
		return 'http://127.0.0.1:7483'
	}

	const { protocol, hostname, origin, port } = window.location
	const isVitePort = port === '5173' || port === '4173'

	if (isVitePort) {
		return `${protocol}//${hostname}:7483`
	}

	return origin
}
