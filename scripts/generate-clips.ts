#!/usr/bin/env bun

/**
 * Pre-generate ElevenLabs voice clips for all characters.
 *
 * Why: The server uses pregenerated-only mode in v1. All phrases must be on
 * disk before the voice system can play them. Run this script once with
 * ELEVENLABS_API_KEY to generate all 20 clips (~300KB total).
 *
 * After generation, clips are cached at:
 *   ~/.cache/side-quest-observability/voices/{hash}.mp3
 *
 * The server needs NO API key at runtime -- it only reads from disk cache.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk-... bun run scripts/generate-clips.ts
 *   ELEVENLABS_API_KEY=sk-... bun run scripts/generate-clips.ts --dry-run
 *   ELEVENLABS_API_KEY=sk-... bun run scripts/generate-clips.ts --play
 *
 * Flags:
 *   --dry-run   Show what would be generated without calling ElevenLabs
 *   --play      Play each clip with afplay after generating (macOS only)
 *
 * Note: This package is private -- use bun run, not bunx.
 */

import {
	cacheGet,
	cacheKey,
	cachePut,
} from '../packages/server/src/voice/cache.js'
import { loadVoiceConfig } from '../packages/server/src/voice/config.js'
import { VOICE_MAP } from '../packages/server/src/voice/voices.js'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const PLAY = args.includes('--play')

// ---------------------------------------------------------------------------
// ElevenLabs API client
// ---------------------------------------------------------------------------

/** ElevenLabs TTS API endpoint. */
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'

/** ElevenLabs model for fast, low-latency TTS. */
const ELEVENLABS_MODEL = 'eleven_flash_v2_5'

/**
 * Call the ElevenLabs TTS API to synthesize a voice clip.
 *
 * Why: Used only by this script -- never called at server runtime.
 * Returns the audio as a Buffer for writing to the disk cache.
 *
 * @param text - The phrase to synthesize
 * @param voiceId - The ElevenLabs voice ID
 * @param apiKey - ElevenLabs API key
 * @returns Audio data as Buffer, or null on API error
 */
async function synthesize(
	text: string,
	voiceId: string,
	apiKey: string,
): Promise<Buffer | null> {
	const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'xi-api-key': apiKey,
				'Content-Type': 'application/json',
				Accept: 'audio/mpeg',
			},
			body: JSON.stringify({
				text,
				model_id: ELEVENLABS_MODEL,
				voice_settings: {
					stability: 0.75,
					similarity_boost: 0.8,
				},
			}),
		})

		if (!res.ok) {
			const errorText = await res.text()
			console.error(
				`  [error] ElevenLabs API ${res.status}: ${errorText.slice(0, 200)}`,
			)
			return null
		}

		const arrayBuffer = await res.arrayBuffer()
		return Buffer.from(arrayBuffer)
	} catch (err) {
		console.error(`  [error] Network error: ${err}`)
		return null
	}
}

/**
 * Play a cached mp3 clip with afplay (macOS only).
 *
 * Why: --play flag lets you listen to clips immediately after generation
 * to validate voice quality without leaving the terminal.
 *
 * @param filePath - Absolute path to the mp3 file
 */
async function playClip(filePath: string): Promise<void> {
	const proc = Bun.spawn(['afplay', filePath], {
		stdout: 'ignore',
		stderr: 'ignore',
	})
	await proc.exited
}

// ---------------------------------------------------------------------------
// Main generation loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const config = loadVoiceConfig()
	const apiKey = process.env.ELEVENLABS_API_KEY

	if (!DRY_RUN && !apiKey) {
		console.error('Error: ELEVENLABS_API_KEY environment variable is required.')
		console.error(
			'Usage: ELEVENLABS_API_KEY=sk-... bun run scripts/generate-clips.ts',
		)
		process.exit(1)
	}

	if (DRY_RUN) {
		console.log('[dry-run] Showing what would be generated:')
	} else {
		console.log(`Generating voice clips to: ${config.cacheDir}`)
		console.log(`Model: ${ELEVENLABS_MODEL}`)
		console.log()
	}

	let generated = 0
	let skipped = 0
	let failed = 0
	const total = Object.values(VOICE_MAP).reduce(
		(sum, entry) =>
			sum + entry.phrases.start.length + entry.phrases.stop.length,
		0,
	)

	for (const [agentType, entry] of Object.entries(VOICE_MAP)) {
		console.log(`${entry.label} (${agentType})`)

		const allPhrases: Array<{ phase: 'start' | 'stop'; text: string }> = [
			...entry.phrases.start.map((text) => ({ phase: 'start' as const, text })),
			...entry.phrases.stop.map((text) => ({ phase: 'stop' as const, text })),
		]

		for (const { phase, text } of allPhrases) {
			const hash = cacheKey(text, entry.voiceId)
			const existingPath = cacheGet(hash, config.cacheDir)

			if (existingPath) {
				console.log(`  [skip] ${phase}: "${text}"`)
				console.log(`         -> ${existingPath} (already cached)`)
				skipped++
				continue
			}

			if (DRY_RUN) {
				console.log(`  [would generate] ${phase}: "${text}"`)
				console.log(`         -> ${config.cacheDir}/${hash}.mp3`)
				generated++
				continue
			}

			console.log(`  [generating] ${phase}: "${text}"`)
			console.log(`         voice: ${entry.voiceId}`)

			// voiceId is a TBD_ placeholder -- skip synthesis until real IDs are set
			if (entry.voiceId.startsWith('TBD_')) {
				console.log(
					'         [skipped] voice ID is placeholder (TBD_*) -- update voices.ts first',
				)
				skipped++
				continue
			}

			const audio = await synthesize(text, entry.voiceId, apiKey!)
			if (!audio) {
				console.error(`         [failed] synthesis returned null`)
				failed++
				continue
			}

			const filePath = await cachePut(hash, audio, config.cacheDir)
			if (!filePath) {
				console.error(`         [failed] could not write to cache`)
				failed++
				continue
			}

			console.log(`         -> ${filePath}`)
			generated++

			if (PLAY) {
				console.log('         [playing]...')
				await playClip(filePath)
			}
		}

		console.log()
	}

	// Summary
	console.log('='.repeat(60))
	if (DRY_RUN) {
		console.log(`Would generate ${generated} of ${total} clips.`)
	} else {
		console.log(
			`Generated: ${generated} | Skipped: ${skipped} | Failed: ${failed} | Total: ${total}`,
		)
		if (generated > 0) {
			console.log(`Clips cached at: ${config.cacheDir}`)
		}
		if (failed > 0) {
			console.log('Some clips failed. Check ELEVENLABS_API_KEY and voice IDs.')
			process.exit(1)
		}
	}
}

main().catch((err) => {
	console.error('Fatal error:', err)
	process.exit(1)
})
