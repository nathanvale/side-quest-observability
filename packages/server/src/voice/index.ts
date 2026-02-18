/**
 * Voice system barrel export.
 *
 * Why: Single import point for consumers (server.ts, tests, scripts)
 * so they don't need to know the internal file layout.
 */

export { cacheGet, cacheKey, cachePut } from './cache.js'
export { loadVoiceConfig } from './config.js'
export { PlaybackQueue } from './queue.js'
export { handleVoiceNotify } from './router.js'
export type {
	QueueItem,
	VoiceNotification,
	VoiceSystemConfig,
} from './types.js'
export { selectPhrase, VOICE_MAP } from './voices.js'
