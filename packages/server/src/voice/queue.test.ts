/**
 * Tests for PlaybackQueue.
 *
 * What we test: the queue contract, not actual audio playback.
 * afplay is mocked via Bun.spawn so tests run without audio hardware.
 *
 * Key scenarios:
 *   - FIFO ordering (items drain in arrival order)
 *   - maxDepth back-pressure (items dropped when queue is full)
 *   - maxAgeMs staleness (stale items skipped, not played)
 *   - maxPlayMs timeout (hung afplay killed after timeout)
 *   - try/finally invariant (playing=false guaranteed after exception)
 *   - stop() kills current process and clears queue
 *   - enqueue-after-drain starts a new drain cycle
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { PlaybackQueue } from './queue.js'
import type { QueueItem } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a QueueItem with an optional age offset (negative = older). */
function makeItem(label: string, ageOffsetMs = 0): QueueItem {
	return {
		filePath: `/tmp/test-${label}.mp3`,
		label,
		enqueuedAt: Date.now() + ageOffsetMs,
	}
}

/** Sleep for n milliseconds. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Mock Bun.spawn
// ---------------------------------------------------------------------------

/** A fake process that resolves exited immediately. */
function makeFastProc() {
	const proc = {
		exited: Promise.resolve(0),
		kill: mock(() => {}),
	}
	return proc
}

/** A fake process that never resolves (simulates hung afplay). */
function makeHungProc() {
	const proc = {
		exited: new Promise<number>(() => {}), // never resolves
		kill: mock(() => {}),
	}
	return proc
}

/** A fake process that rejects with an error. */
function makeErrorProc() {
	const proc = {
		exited: Promise.reject(new Error('spawn failed')),
		kill: mock(() => {}),
	}
	return proc
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlaybackQueue', () => {
	let spawnMock: ReturnType<typeof spyOn>

	beforeEach(() => {
		// Default: fast proc that resolves immediately
		spawnMock = spyOn(Bun, 'spawn').mockReturnValue(makeFastProc() as ReturnType<typeof Bun.spawn>)
	})

	afterEach(() => {
		spawnMock.mockRestore()
	})

	// -------------------------------------------------------------------------
	// Initial state
	// -------------------------------------------------------------------------

	it('starts with depth 0 and isPlaying false', () => {
		const q = new PlaybackQueue()
		expect(q.depth).toBe(0)
		expect(q.isPlaying).toBe(false)
	})

	// -------------------------------------------------------------------------
	// FIFO ordering
	// -------------------------------------------------------------------------

	it('plays items in FIFO order', async () => {
		const order: string[] = []
		spawnMock.mockImplementation(([, file]: string[]) => {
			order.push(file ?? '')
			return makeFastProc() as ReturnType<typeof Bun.spawn>
		})

		const q = new PlaybackQueue()
		q.enqueue(makeItem('alpha'))
		q.enqueue(makeItem('bravo'))
		q.enqueue(makeItem('charlie'))

		// Wait for drain to complete
		await sleep(50)

		expect(order).toEqual(['/tmp/test-alpha.mp3', '/tmp/test-bravo.mp3', '/tmp/test-charlie.mp3'])
	})

	// -------------------------------------------------------------------------
	// maxDepth back-pressure
	// -------------------------------------------------------------------------

	it('drops items when queue is full', async () => {
		// Use a queue with maxDepth=2. Use a hung proc so items don't drain during enqueue.
		spawnMock.mockReturnValue(makeHungProc() as ReturnType<typeof Bun.spawn>)
		const q = new PlaybackQueue({ maxDepth: 2, maxPlayMs: 50 })

		// First item starts playing (dequeued immediately into drain)
		q.enqueue(makeItem('first'))
		// Slight pause to let drain start and dequeue first item
		await sleep(10)

		// Now queue is empty (first item is playing). Enqueue two more.
		q.enqueue(makeItem('second'))
		q.enqueue(makeItem('third'))

		// Third item should be the one dropped. Enqueue a fourth -- depth is now 2, should drop
		q.enqueue(makeItem('fourth'))

		expect(q.depth).toBe(2) // second + third, fourth dropped

		// Cleanup
		q.stop()
	})

	// -------------------------------------------------------------------------
	// maxAgeMs staleness
	// -------------------------------------------------------------------------

	it('skips stale items (older than maxAgeMs)', async () => {
		const played: string[] = []
		spawnMock.mockImplementation(([, file]: string[]) => {
			played.push(file ?? '')
			return makeFastProc() as ReturnType<typeof Bun.spawn>
		})

		const q = new PlaybackQueue({ maxAgeMs: 1000 })

		// Fresh item -- should play
		q.enqueue(makeItem('fresh', 0))
		// Stale item -- enqueuedAt is 2000ms in the past
		q.enqueue(makeItem('stale', -2000))

		await sleep(50)

		// Only 'fresh' should have been played
		expect(played).toHaveLength(1)
		expect(played[0]).toBe('/tmp/test-fresh.mp3')
	})

	// -------------------------------------------------------------------------
	// maxPlayMs timeout
	// -------------------------------------------------------------------------

	it('kills hung afplay after maxPlayMs and continues draining', async () => {
		const hungProc = makeHungProc()
		const fastProc = makeFastProc()
		let call = 0
		spawnMock.mockImplementation(() => {
			call++
			if (call === 1) return hungProc as ReturnType<typeof Bun.spawn>
			return fastProc as ReturnType<typeof Bun.spawn>
		})

		const played: string[] = []
		const originalSpawn = spawnMock.getMockImplementation()
		spawnMock.mockImplementation(([, file]: string[]) => {
			played.push(file ?? '')
			return originalSpawn!([undefined, file] as [string, string]) as ReturnType<typeof Bun.spawn>
		})

		// Reset call counter, re-mock cleanly
		call = 0
		spawnMock.mockImplementation(([, file]: string[]) => {
			call++
			played.push(file ?? '')
			if (call === 1) return hungProc as ReturnType<typeof Bun.spawn>
			return fastProc as ReturnType<typeof Bun.spawn>
		})

		const q = new PlaybackQueue({ maxPlayMs: 100 })
		q.enqueue(makeItem('hung'))
		q.enqueue(makeItem('next'))

		// Wait long enough for timeout (100ms) + drain of second item
		await sleep(300)

		expect(hungProc.kill).toHaveBeenCalled()
		expect(played).toContain('/tmp/test-next.mp3')
		expect(q.isPlaying).toBe(false)
	})

	// -------------------------------------------------------------------------
	// try/finally invariant
	// -------------------------------------------------------------------------

	it('sets isPlaying=false even when playOne throws', async () => {
		// Simulate an error proc -- exited rejects immediately
		spawnMock.mockReturnValue(makeErrorProc() as ReturnType<typeof Bun.spawn>)

		const q = new PlaybackQueue()
		q.enqueue(makeItem('errored'))

		await sleep(50)

		// playing must be false after the exception
		expect(q.isPlaying).toBe(false)
	})

	// -------------------------------------------------------------------------
	// stop() kills current proc and clears queue
	// -------------------------------------------------------------------------

	it('stop() kills the current proc and clears pending items', async () => {
		const hungProc = makeHungProc()
		spawnMock.mockReturnValue(hungProc as ReturnType<typeof Bun.spawn>)

		const q = new PlaybackQueue({ maxPlayMs: 60_000 }) // high timeout so it doesn't auto-kill
		q.enqueue(makeItem('playing'))
		await sleep(20) // let drain start

		q.enqueue(makeItem('pending-1'))
		q.enqueue(makeItem('pending-2'))

		q.stop()

		expect(hungProc.kill).toHaveBeenCalled()
		expect(q.depth).toBe(0)
	})

	// -------------------------------------------------------------------------
	// Enqueue after drain completes starts a new cycle
	// -------------------------------------------------------------------------

	it('starts a new drain cycle when enqueuing after previous drain completed', async () => {
		const played: string[] = []
		spawnMock.mockImplementation(([, file]: string[]) => {
			played.push(file ?? '')
			return makeFastProc() as ReturnType<typeof Bun.spawn>
		})

		const q = new PlaybackQueue()

		// First batch
		q.enqueue(makeItem('first'))
		await sleep(50)

		// Drain should be done
		expect(q.isPlaying).toBe(false)
		expect(played).toHaveLength(1)

		// Second batch -- should trigger a new drain cycle
		q.enqueue(makeItem('second'))
		await sleep(50)

		expect(played).toHaveLength(2)
		expect(played[1]).toBe('/tmp/test-second.mp3')
	})

	// -------------------------------------------------------------------------
	// clear() clears queue without killing current
	// -------------------------------------------------------------------------

	it('clear() removes pending items without killing the current proc', async () => {
		const hungProc = makeHungProc()
		spawnMock.mockReturnValue(hungProc as ReturnType<typeof Bun.spawn>)

		const q = new PlaybackQueue({ maxPlayMs: 60_000 })
		q.enqueue(makeItem('playing'))
		await sleep(20)

		q.enqueue(makeItem('pending'))
		q.clear()

		expect(q.depth).toBe(0)
		// Kill not called -- current proc still running
		expect(hungProc.kill).not.toHaveBeenCalled()

		// Cleanup
		q.stop()
	})
})
