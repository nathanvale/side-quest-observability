/**
 * Tests for handleVoiceNotify (POST /voice/notify).
 *
 * What we test: request parsing and response shapes for all branch paths.
 * No actual file I/O or audio playback -- file existence is mocked.
 *
 * Branches:
 *   - voice_disabled  -> mode='off', returns { queued: false, reason: 'voice_disabled' }
 *   - unknown_agent   -> unmapped agentType, returns { queued: false, reason: 'unknown_agent' }
 *   - not_cached      -> known agent but clip not on disk, returns { queued: false, reason: 'not_cached' }
 *   - queued          -> known agent, clip on disk, returns { queued: true, label, text }
 *   - invalid_body    -> malformed JSON, returns { queued: false, reason: 'invalid_body' } 400
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as cacheModule from './cache.js'
import { PlaybackQueue } from './queue.js'
import { handleVoiceNotify } from './router.js'
import type { VoiceSystemConfig } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal VoiceSystemConfig in 'on' mode. */
function makeConfig(mode: 'on' | 'off' = 'on'): VoiceSystemConfig {
	return {
		mode,
		cacheDir: '/tmp/test-voice-cache',
		maxQueueDepth: 10,
		maxAgeMs: 30_000,
		maxPlayMs: 15_000,
	}
}

/** Build a Request with the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request('http://localhost/voice/notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

/** Build a queue whose enqueue we can spy on (spawn mocked to no-op). */
function makeQueue(): PlaybackQueue {
	spyOn(Bun, 'spawn').mockReturnValue({
		exited: Promise.resolve(0),
		kill: mock(() => {}),
	} as ReturnType<typeof Bun.spawn>)
	return new PlaybackQueue()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleVoiceNotify', () => {
	let cacheGetSpy: ReturnType<typeof spyOn>
	let spawnSpy: ReturnType<typeof spyOn>

	beforeEach(() => {
		// Default: cacheGet returns null (no clip cached)
		cacheGetSpy = spyOn(cacheModule, 'cacheGet').mockReturnValue(null)
		// Mock Bun.spawn to prevent accidental afplay calls
		spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		} as ReturnType<typeof Bun.spawn>)
	})

	afterEach(() => {
		cacheGetSpy.mockRestore()
		spawnSpy.mockRestore()
	})

	// -------------------------------------------------------------------------
	// voice_disabled
	// -------------------------------------------------------------------------

	it('returns voice_disabled when mode is off', async () => {
		const config = makeConfig('off')
		const queue = new PlaybackQueue()
		const req = makeRequest({ agentType: 'enterprise:builder-scotty', phase: 'stop' })

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; reason: string }

		expect(res.status).toBe(200)
		expect(body.queued).toBe(false)
		expect(body.reason).toBe('voice_disabled')
	})

	// -------------------------------------------------------------------------
	// unknown_agent
	// -------------------------------------------------------------------------

	it('returns unknown_agent for unmapped agentType', async () => {
		const config = makeConfig()
		const queue = makeQueue()
		const req = makeRequest({ agentType: 'unknown:robot', phase: 'stop' })

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; reason: string }

		expect(body.queued).toBe(false)
		expect(body.reason).toBe('unknown_agent')
	})

	// -------------------------------------------------------------------------
	// not_cached
	// -------------------------------------------------------------------------

	it('returns not_cached when clip file does not exist', async () => {
		// cacheGet returns null by default from beforeEach
		const config = makeConfig()
		const queue = makeQueue()
		const req = makeRequest({ agentType: 'enterprise:builder-scotty', phase: 'stop' })

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; reason: string }

		expect(body.queued).toBe(false)
		expect(body.reason).toBe('not_cached')
	})

	// -------------------------------------------------------------------------
	// queued (happy path)
	// -------------------------------------------------------------------------

	it('returns queued=true and enqueues clip when file is cached', async () => {
		// Make cacheGet return a real path
		cacheGetSpy.mockReturnValue('/tmp/test-voice-cache/abc123.mp3')

		const config = makeConfig()
		const queue = makeQueue()
		const enqueueSpy = spyOn(queue, 'enqueue')

		const req = makeRequest({ agentType: 'enterprise:builder-scotty', phase: 'stop' })
		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; label: string; text: string }

		expect(res.status).toBe(200)
		expect(body.queued).toBe(true)
		expect(body.label).toBe('Scotty')
		expect(typeof body.text).toBe('string')
		expect(body.text.length).toBeGreaterThan(0)
		expect(enqueueSpy).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// All known agents respond correctly
	// -------------------------------------------------------------------------

	it.each([
		['enterprise:builder-scotty', 'Scotty'],
		['enterprise:validator-mccoy', 'McCoy'],
		['enterprise:ships-computer-cpu', 'Computer'],
		['enterprise:API', 'Spock'],
		['newsroom:beat-reporter', 'Mickey Malone'],
	])('known agent %s returns label %s when cached', async (agentType, expectedLabel) => {
		cacheGetSpy.mockReturnValue('/tmp/clip.mp3')

		const config = makeConfig()
		const queue = makeQueue()
		const req = makeRequest({ agentType, phase: 'stop' })

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; label: string }

		expect(body.queued).toBe(true)
		expect(body.label).toBe(expectedLabel)
	})

	// -------------------------------------------------------------------------
	// Phase: start works too
	// -------------------------------------------------------------------------

	it('works for phase=start as well as stop', async () => {
		cacheGetSpy.mockReturnValue('/tmp/clip.mp3')

		const config = makeConfig()
		const queue = makeQueue()
		const req = makeRequest({ agentType: 'enterprise:ships-computer-cpu', phase: 'start' })

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean }

		expect(body.queued).toBe(true)
	})

	// -------------------------------------------------------------------------
	// Malformed request body
	// -------------------------------------------------------------------------

	it('returns 400 invalid_body for malformed JSON', async () => {
		const config = makeConfig()
		const queue = makeQueue()
		const req = new Request('http://localhost/voice/notify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'this is not json',
		})

		const res = await handleVoiceNotify(req, config, queue)
		const body = (await res.json()) as { queued: boolean; reason: string }

		expect(res.status).toBe(400)
		expect(body.queued).toBe(false)
		expect(body.reason).toBe('invalid_body')
	})

	// -------------------------------------------------------------------------
	// Phrase selection returns a valid phrase
	// -------------------------------------------------------------------------

	it('selectPhrase returns different phrases (flat random)', async () => {
		cacheGetSpy.mockReturnValue('/tmp/clip.mp3')

		const config = makeConfig()
		// Run 20 times and collect all returned texts
		const texts = new Set<string>()
		for (let i = 0; i < 20; i++) {
			const queue = makeQueue()
			const req = makeRequest({ agentType: 'enterprise:builder-scotty', phase: 'stop' })
			const res = await handleVoiceNotify(req, config, queue)
			const body = (await res.json()) as { text: string }
			texts.add(body.text)
		}
		// With 2 phrases and 20 rolls, both should appear
		// (probability of missing one: 0.5^20 = ~1 in a million)
		expect(texts.size).toBeGreaterThan(1)
	})
})
