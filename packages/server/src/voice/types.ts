/**
 * Voice system type definitions for the observability server.
 *
 * Why: Defines the runtime types for the voice notification system --
 * queue items, request/response shapes, and system configuration.
 * Kept minimal for v1: pregenerated-only mode, no live TTS, no verdict routing.
 */

/**
 * POST /voice/notify request body (sent by hooks or in-process callers).
 *
 * Why: Decoupled from QueueItem -- the notification is what arrives over the
 * wire; the queue item is what gets enqueued after cache resolution.
 */
export interface VoiceNotification {
	/** Agent type string, e.g. 'enterprise:builder-scotty'. */
	agentType: string
	/** Event phase -- start or stop. */
	phase: 'start' | 'stop'
}

/**
 * A single item in the playback queue.
 *
 * Why: Captures the resolved clip path plus metadata for logging
 * and staleness detection. The label is human-readable for console output.
 */
export interface QueueItem {
	/** Absolute path to the mp3 file to play. */
	filePath: string
	/** Human-readable label for logging, e.g. 'Scotty: "Repairs complete, Captain."' */
	label: string
	/** Timestamp when the item was enqueued (Date.now()). Used for maxAgeMs check. */
	enqueuedAt: number
}

/**
 * Runtime configuration for the voice system.
 *
 * Why: Centralises all tunables so the queue and router receive a single
 * config object. Loaded once at startup from env vars via loadVoiceConfig().
 */
export interface VoiceSystemConfig {
	/** Operating mode: 'on' plays pregenerated clips; 'off' disables voice entirely. */
	mode: 'on' | 'off'
	/** Directory where cached mp3 files are stored. */
	cacheDir: string
	/** Maximum queue depth before new items are silently dropped. */
	maxQueueDepth: number
	/** Maximum age of a queue item in milliseconds before it is skipped as stale. */
	maxAgeMs: number
	/** Maximum playback duration in milliseconds before afplay is killed. */
	maxPlayMs: number
}
