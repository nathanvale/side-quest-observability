/**
 * HTTP route handler for POST /voice/notify.
 *
 * Why: Provides an external HTTP endpoint for voice triggering so
 * manual testing (curl) and future WS-based voice services (v2) can
 * enqueue clips without an in-process call. The server itself uses
 * triggerVoice() directly (see server.ts) -- no HTTP self-call.
 *
 * Request body: { agentType: string, phase: 'start' | 'stop' }
 * Response 200: { queued: true, label, text }
 *              | { queued: false, reason: 'voice_disabled' | 'unknown_agent' | 'not_cached' }
 *
 * No live TTS fallback in v1 -- pregenerated-only. If the clip is not
 * cached, returns not_cached immediately without calling ElevenLabs.
 */

import { cacheGet, cacheKey } from './cache.js'
import type { PlaybackQueue } from './queue.js'
import type { VoiceNotification, VoiceSystemConfig } from './types.js'
import { selectPhrase, VOICE_MAP } from './voices.js'

/**
 * Handle POST /voice/notify.
 *
 * Why: Validates the request, resolves the cached clip, and enqueues for
 * serial playback. Returns 200 immediately -- the caller does not wait
 * for audio to play. Fire-and-forget on success.
 *
 * Response format:
 * - { queued: false, reason: 'voice_disabled' } when SIDE_QUEST_VOICE=off
 * - { queued: false, reason: 'unknown_agent' } for unmapped agentType
 * - { queued: false, reason: 'not_cached' } when clip file is missing from disk
 * - { queued: true, label, text } on successful enqueue
 *
 * @param req - Incoming HTTP Request with JSON body
 * @param config - Voice system config (mode, cacheDir)
 * @param queue - The PlaybackQueue instance to enqueue onto
 * @returns Response with CORS-compatible JSON body
 */
export async function handleVoiceNotify(
	req: Request,
	config: VoiceSystemConfig,
	queue: PlaybackQueue,
): Promise<Response> {
	if (config.mode === 'off') {
		return Response.json({ queued: false, reason: 'voice_disabled' })
	}

	let body: VoiceNotification
	try {
		body = (await req.json()) as VoiceNotification
	} catch {
		return Response.json(
			{ queued: false, reason: 'invalid_body' },
			{ status: 400 },
		)
	}

	// 1. Validate agentType -> voice entry
	const entry = VOICE_MAP[body.agentType]
	if (!entry) {
		return Response.json({ queued: false, reason: 'unknown_agent' })
	}

	// 2. Select a random phrase for the phase
	const text = selectPhrase(body.agentType, body.phase)
	if (!text) {
		return Response.json({ queued: false, reason: 'unknown_agent' })
	}

	// 3. Look up cached clip -- no live TTS in v1
	const hash = cacheKey(text, entry.voiceId)
	const filePath = cacheGet(hash, config.cacheDir)
	if (!filePath) {
		return Response.json({ queued: false, reason: 'not_cached' })
	}

	// 4. Enqueue for async serial playback
	queue.enqueue({
		filePath,
		label: `${entry.label}: "${text}"`,
		enqueuedAt: Date.now(),
	})

	return Response.json({ queued: true, label: entry.label, text })
}
