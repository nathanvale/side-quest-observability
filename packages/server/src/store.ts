/**
 * In-memory ring buffer with optional JSONL persistence and rotation.
 *
 * Why: Events need fast in-memory access for queries and WebSocket
 * broadcast, plus durable persistence for post-mortem analysis.
 * A ring buffer gives O(1) insertion and bounded memory usage,
 * while JSONL append gives crash-safe durability without write amplification.
 * Rotation caps unbounded disk growth at ~50MB (10MB * 5 files).
 */

import { renameSync } from 'node:fs'
import path from 'node:path'
import {
	appendToFileSync,
	ensureDirSync,
	pathExistsSync,
} from '@side-quest/core/fs'
import type { EventEnvelope, EventType } from './types.js'

/** Maximum JSONL file size before rotation (10MB). */
const MAX_JSONL_BYTES = 10 * 1024 * 1024

/** Maximum number of rotated files to retain (.jsonl.1 through .jsonl.5). */
const MAX_ROTATED_FILES = 5

/** Rate-limit persist-failure warnings to once per 30 seconds. */
const PERSIST_WARN_INTERVAL_MS = 30_000

/** Configuration for the event store. */
export interface StoreOptions {
	/** Maximum number of events to retain in memory (default: 1000). */
	readonly capacity?: number
	/** Optional path to a JSONL file for durable persistence. */
	readonly persistPath?: string
}

/** Filter criteria for querying stored events. */
export interface EventFilter {
	/** Only return events of this type. */
	readonly type?: EventType
	/** Only return events with timestamp strictly after this ISO string. */
	readonly since?: string
	/** Maximum number of events to return (from the tail). */
	readonly limit?: number
}

/**
 * Ring buffer event store with optional JSONL append persistence and rotation.
 *
 * Why: Provides bounded in-memory storage for real-time queries
 * while optionally appending each event to a JSONL file for
 * durable post-mortem analysis. File rotation caps disk usage at
 * MAX_JSONL_BYTES * MAX_ROTATED_FILES. Persist failures degrade
 * gracefully -- the ring buffer continues serving queries and
 * WebSocket consumers even when the file system is unavailable.
 */
export class EventStore {
	private readonly buffer: EventEnvelope[]
	private readonly capacity: number
	private readonly persistPath: string | null
	private writeIndex = 0
	private count = 0
	private lastWarnAt = 0

	/** Total number of persist failures since startup. Exposed for /health. */
	persistErrors = 0

	constructor(options: StoreOptions = {}) {
		this.capacity = options.capacity ?? 1000
		this.buffer = new Array(this.capacity)
		this.persistPath = options.persistPath ?? null
		if (this.persistPath) {
			ensureDirSync(path.dirname(this.persistPath))
		}
	}

	/**
	 * Push an event into the ring buffer and optionally persist to JSONL.
	 *
	 * Why: Synchronous push is intentional -- single Bun process means the
	 * event loop already serialises calls, so no lock is needed. Making push
	 * async would complicate all callers for no real benefit.
	 *
	 * @param event - The event envelope to store
	 */
	push(event: EventEnvelope): void {
		this.buffer[this.writeIndex] = event
		this.writeIndex = (this.writeIndex + 1) % this.capacity
		if (this.count < this.capacity) this.count++
		if (this.persistPath) {
			try {
				this.rotateIfNeeded()
				appendToFileSync(this.persistPath, `${JSON.stringify(event)}\n`)
			} catch (err) {
				this.persistErrors++
				const now = Date.now()
				if (now - this.lastWarnAt >= PERSIST_WARN_INTERVAL_MS) {
					this.lastWarnAt = now
					process.stderr.write(
						`[event-store] persist failure #${this.persistErrors}: ${err}\n`,
					)
				}
				// Continue operating in memory-only mode -- do not rethrow
			}
		}
	}

	/**
	 * Query events by optional type, timestamp, and limit filters.
	 *
	 * @param filter - Optional filter criteria
	 * @returns Chronologically ordered array of matching events
	 */
	query(filter?: EventFilter): EventEnvelope[] {
		let events = this.toArray()
		if (filter?.type) {
			events = events.filter((e) => e.type === filter.type)
		}
		if (filter?.since) {
			const since = filter.since
			events = events.filter((e) => e.timestamp > since)
		}
		if (filter?.limit !== undefined) {
			if (filter.limit <= 0) return []
			events = events.slice(-filter.limit)
		}
		return events
	}

	/**
	 * Get the last N events from the buffer.
	 *
	 * @param n - Number of events to return
	 * @returns The most recent N events in chronological order
	 */
	last(n: number): EventEnvelope[] {
		if (n <= 0) return []
		return this.toArray().slice(-n)
	}

	/** Total events currently stored in the ring buffer. */
	get size(): number {
		return this.count
	}

	/**
	 * Count events grouped by type. Used by the /health endpoint.
	 *
	 * Why: Gives operators a quick signal of which event types are
	 * flowing through the server without requiring a full query.
	 *
	 * @returns A map of EventType -> count
	 */
	typeCounts(): Record<string, number> {
		const counts: Record<string, number> = {}
		for (const event of this.toArray()) {
			const type = event.type as string
			counts[type] = (counts[type] ?? 0) + 1
		}
		return counts
	}

	/**
	 * Rotate the JSONL file if it exceeds the size limit.
	 *
	 * Why: Unbounded JSONL growth at ~412 events/session could consume
	 * ~250MB/month. Rotation keeps the total footprint under
	 * MAX_JSONL_BYTES * (MAX_ROTATED_FILES + 1) ≈ 60MB.
	 *
	 * Rotation order: .jsonl.4 -> .jsonl.5 (delete old .5), .jsonl.3 -> .jsonl.4,
	 * ..., .jsonl -> .jsonl.1. The active file is then re-created empty.
	 */
	private rotateIfNeeded(): void {
		if (!this.persistPath) return
		try {
			const file = Bun.file(this.persistPath)
			if (file.size < MAX_JSONL_BYTES) return

			// Rotate from highest index down to avoid clobbering
			for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
				const from = `${this.persistPath}.${i}`
				const to = `${this.persistPath}.${i + 1}`
				if (pathExistsSync(from)) renameSync(from, to)
			}
			// .jsonl -> .jsonl.1
			renameSync(this.persistPath, `${this.persistPath}.1`)
		} catch {
			// Best-effort rotation -- persist failure is handled by push() caller
		}
	}

	/**
	 * Materialize the ring buffer into a chronologically ordered array.
	 *
	 * Why: When the buffer wraps, the oldest event starts at writeIndex.
	 * We need to stitch the two halves together for correct ordering.
	 */
	private toArray(): EventEnvelope[] {
		if (this.count < this.capacity) {
			return this.buffer.slice(0, this.count)
		}
		// Ring buffer is full: oldest is at writeIndex, newest is at writeIndex - 1
		return [
			...this.buffer.slice(this.writeIndex),
			...this.buffer.slice(0, this.writeIndex),
		]
	}
}
