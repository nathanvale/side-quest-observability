/**
 * Serial playback queue for voice clips.
 *
 * Why: Overlapping TTS clips from multiple agents are unintelligible.
 * Serial playback preserves the "bridge chatter" experience -- you hear
 * each character in sequence. The queue handles all reliability concerns:
 *
 *   - maxDepth: back-pressure when events burst (default 10)
 *   - maxAgeMs: skip stale clips no longer relevant (default 30s)
 *   - maxPlayMs: kill hung afplay on corrupt mp3 or blocked audio device (default 15s)
 *   - try/finally on drain(): playing=false is guaranteed even on exception
 *   - currentProc tracking: stop() kills in-flight afplay on SIGTERM
 *
 * Platform note: Uses afplay (macOS only). Cross-platform support (aplay/powershell)
 * is deferred to v2. Nathan's hardware is MacBook Pro M4 Pro + Mac Mini M4 Pro.
 *
 * Operator fixes applied (from 3-pass review):
 *   C1: maxPlayMs timeout via Promise.race -- kills hung afplay
 *   C2: try/finally on drain() -- playing=false guaranteed on any exception
 *   I3: currentProc reference -- stop() kills in-flight process on SIGTERM
 */

import type { QueueItem } from './types.js'

/**
 * Serial FIFO playback queue. Clips play one at a time, in arrival order.
 *
 * Instantiate once at server startup. Pass a config object to override defaults.
 * Call stop() in the SIGTERM handler to kill in-flight afplay and clear the queue.
 */
export class PlaybackQueue {
	private queue: QueueItem[] = []
	private playing = false
	private currentProc: ReturnType<typeof Bun.spawn> | null = null
	private readonly config: {
		maxDepth: number
		maxAgeMs: number
		maxPlayMs: number
	}

	/**
	 * Create a new PlaybackQueue.
	 *
	 * @param opts - Optional config overrides. Defaults: maxDepth=10, maxAgeMs=30000, maxPlayMs=15000
	 */
	constructor(opts?: {
		maxDepth?: number
		maxAgeMs?: number
		maxPlayMs?: number
	}) {
		this.config = {
			maxDepth: opts?.maxDepth ?? 10,
			maxAgeMs: opts?.maxAgeMs ?? 30_000,
			maxPlayMs: opts?.maxPlayMs ?? 15_000,
		}
	}

	/**
	 * Enqueue a clip for playback. Starts draining if idle.
	 *
	 * Why: silently drops when full (voice is non-critical). The back-pressure
	 * limit prevents unbounded queue growth during a burst of agent events.
	 * Drain starts automatically if the queue was empty -- callers never
	 * need to manage the drain lifecycle.
	 *
	 * @param item - Queue item with resolved file path and metadata
	 */
	enqueue(item: QueueItem): void {
		if (this.queue.length >= this.config.maxDepth) {
			// Back-pressure: silently drop -- voice is non-critical
			return
		}
		this.queue.push(item)
		if (!this.playing) {
			// Non-blocking: drain() is async, this call returns immediately
			void this.drain()
		}
	}

	/**
	 * Serial drain loop. Plays one clip, waits for it to finish, plays next.
	 *
	 * Why: try/finally guarantees playing=false even if an unhandled exception
	 * escapes playOne() (Operator C2). Without this, a crash leaves playing=true
	 * permanently, locking the queue until server restart.
	 */
	private async drain(): Promise<void> {
		this.playing = true
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift()!

				// Drop stale clips -- no longer relevant if they've been waiting too long
				if (Date.now() - item.enqueuedAt > this.config.maxAgeMs) {
					continue
				}

				await this.playOne(item.filePath)
			}
		} finally {
			this.playing = false
		}
	}

	/**
	 * Play a single clip via afplay with a timeout guard.
	 *
	 * Why: afplay can hang indefinitely on a corrupt mp3 or unavailable
	 * audio device, permanently stalling the queue (Operator C1). The
	 * Promise.race kills the process after maxPlayMs.
	 *
	 * Platform: afplay is macOS-only. Cross-platform is v2.
	 *
	 * @param filePath - Absolute path to the mp3 file to play
	 */
	private async playOne(filePath: string): Promise<void> {
		try {
			const proc = Bun.spawn(['afplay', filePath], {
				stdout: 'ignore',
				stderr: 'ignore',
			})
			this.currentProc = proc

			// Race against timeout -- kill hung afplay after maxPlayMs (Operator C1)
			const timeout = new Promise<void>((_, reject) =>
				setTimeout(
					() => reject(new Error('playback timeout')),
					this.config.maxPlayMs,
				),
			)

			await Promise.race([proc.exited.then(() => undefined), timeout]).catch(
				() => {
					try {
						proc.kill()
					} catch {
						// Kill may fail if proc already exited -- safe to ignore
					}
				},
			)
		} catch {
			// Playback failure is non-critical -- skip and continue draining
		} finally {
			this.currentProc = null
		}
	}

	/**
	 * Kill the current clip and clear the queue.
	 *
	 * Why: Called in the SIGTERM handler to prevent afplay from becoming
	 * an orphaned process after the server exits (Operator I3).
	 * Also clears pending items -- no point playing voice after shutdown.
	 */
	stop(): void {
		this.queue = []
		if (this.currentProc) {
			try {
				this.currentProc.kill()
			} catch {
				// Process may have already exited -- safe to ignore
			}
			this.currentProc = null
		}
	}

	/**
	 * Clear pending items without killing the current clip.
	 *
	 * Why: Useful when a new session starts and old pending clips
	 * are no longer relevant, but the currently-playing clip should
	 * finish naturally.
	 */
	clear(): void {
		this.queue = []
	}

	/**
	 * Current queue depth (items waiting to play, not counting current).
	 *
	 * Why: Exposed for the /health endpoint so operators can see if
	 * the queue is backing up.
	 */
	get depth(): number {
		return this.queue.length
	}

	/**
	 * Whether a clip is currently playing.
	 *
	 * Why: Exposed for the /health endpoint and for tests that need
	 * to assert drain state.
	 */
	get isPlaying(): boolean {
		return this.playing
	}
}
