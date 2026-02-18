/**
 * Runtime configuration for the observability dashboard.
 *
 * Why: Centralising env var access here means components reference
 * config.serverUrl rather than scatter import.meta.env calls across
 * the codebase. Easy to swap in different values for testing.
 */
export const config = {
	/** Base URL for the event server (HTTP history + WebSocket). */
	serverUrl: import.meta.env.VITE_SERVER_URL || 'http://127.0.0.1:7483',
	/**
	 * Maximum number of events held in the in-memory buffer.
	 * Oldest events are dropped when this limit is exceeded.
	 */
	maxEvents: Number.parseInt(import.meta.env.VITE_MAX_EVENTS || '500', 10),
} as const
