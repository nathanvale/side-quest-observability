/**
 * Disk cache for pre-generated voice clips.
 *
 * Why: All voice clips are generated once via the generate-clips.ts script
 * and cached to disk by their content hash. At runtime, the server does a
 * fast O(1) stat check -- no ElevenLabs API calls, no network, ~1ms overhead.
 *
 * Cache key: contentId(`${voiceId}:${text}`) from @side-quest/core/hash.
 * This is a 12-char SHA-256 prefix -- deterministic and human-friendly.
 *
 * Cache layout: {cacheDir}/{hash}.mp3
 * Flat directory -- no subdirectories needed for v1's ~20 clips.
 *
 * Error contract: cachePut returns null on write failure, never throws.
 * Voice is non-critical -- write failures (disk full, permissions) are
 * silent skips, not crashes.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureDirSync, pathExistsSync } from '@side-quest/core/fs'
import { contentId } from '@side-quest/core/hash'

/** Default cache directory for pre-generated mp3 clips. */
const DEFAULT_CACHE_DIR = join(
	homedir(),
	'.cache',
	'side-quest-observability',
	'voices',
)

/**
 * Compute a deterministic 12-char cache key from voice ID and phrase text.
 *
 * Why: contentId() from @side-quest/core/hash gives a stable SHA-256 prefix.
 * Combining voiceId + text ensures two characters saying the same phrase
 * produce different clips (different voices).
 *
 * @param text - The phrase text, e.g. 'Repairs complete, Captain.'
 * @param voiceId - The ElevenLabs voice ID, e.g. 'TBD_SCOTTISH_MALE'
 * @returns 12-char hex hash string
 */
export function cacheKey(text: string, voiceId: string): string {
	return contentId(`${voiceId}:${text}`)
}

/**
 * Look up a cached mp3 clip by its hash key.
 *
 * Why: Single stat call (~1ms) to check existence. Returns the full
 * absolute path for enqueuing, or null on cache miss (never throws).
 *
 * @param hash - 12-char hash from cacheKey()
 * @param cacheDir - Directory to look in (defaults to DEFAULT_CACHE_DIR)
 * @returns Absolute path to the mp3 file, or null if not cached
 */
export function cacheGet(
	hash: string,
	cacheDir: string = DEFAULT_CACHE_DIR,
): string | null {
	const filePath = join(cacheDir, `${hash}.mp3`)
	return pathExistsSync(filePath) ? filePath : null
}

/**
 * Write an audio buffer to the disk cache.
 *
 * Why: cachePut is called by the generate-clips.ts script, not by the
 * server at runtime. Returns null on write failure instead of throwing --
 * voice is non-critical and a disk full / permission error should not
 * crash the clip generation script entirely.
 *
 * @param hash - 12-char hash from cacheKey()
 * @param audio - Audio data as a Buffer or Uint8Array
 * @param cacheDir - Directory to write to (defaults to DEFAULT_CACHE_DIR)
 * @returns Absolute path to the written file, or null on failure
 */
export async function cachePut(
	hash: string,
	audio: Buffer | Uint8Array,
	cacheDir: string = DEFAULT_CACHE_DIR,
): Promise<string | null> {
	const filePath = join(cacheDir, `${hash}.mp3`)
	try {
		ensureDirSync(cacheDir)
		await Bun.write(filePath, audio)
		return filePath
	} catch {
		// Disk full or permission error -- skip this clip silently (Operator C4)
		return null
	}
}
