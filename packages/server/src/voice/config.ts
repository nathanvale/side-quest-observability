/**
 * Voice system configuration loader.
 *
 * Why: Centralises env var reading for the voice system so callers
 * receive a typed config object with validated defaults. All tunables
 * are hardcoded defaults in v1 -- per-var overrides are v1.1.
 *
 * Two env vars for v1:
 *   SIDE_QUEST_VOICE   - 'off' disables voice; anything else (or unset) enables it
 *   ELEVENLABS_API_KEY - Only needed by generate-clips.ts; not read here
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VoiceSystemConfig } from './types.js'

/** Default cache directory for pre-generated mp3 clips. */
const DEFAULT_CACHE_DIR = join(
	homedir(),
	'.cache',
	'side-quest-observability',
	'voices',
)

/**
 * Load the voice system configuration from environment variables.
 *
 * Why: A single call at server startup produces an immutable config object
 * that the queue, router, and trigger function all share. No dynamic reloading.
 *
 * SIDE_QUEST_VOICE:
 *   'off' -> mode: 'off' (no queue instantiation, no route registration)
 *   anything else (including unset) -> mode: 'on'
 *
 * @returns Typed VoiceSystemConfig with hardcoded defaults for all tunables
 */
export function loadVoiceConfig(): VoiceSystemConfig {
	const voiceEnv = process.env.SIDE_QUEST_VOICE
	const mode = voiceEnv === 'off' ? 'off' : 'on'

	return {
		mode,
		cacheDir: DEFAULT_CACHE_DIR,
		maxQueueDepth: 10,
		maxAgeMs: 30_000,
		maxPlayMs: 15_000,
	}
}
