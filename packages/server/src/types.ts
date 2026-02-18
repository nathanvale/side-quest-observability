/**
 * Event system type definitions for @side-quest/observability.
 *
 * Why: Defines the canonical event envelope and type unions for the
 * CLI, hook, and worktree domains, ensuring all event producers share
 * a single schema contract. Generalized from side-quest-git to support
 * any application (not just git repos).
 */

/**
 * Claude Code hook lifecycle event types.
 *
 * Why: Typed as a union rather than a plain string so TypeScript can
 * narrow exhaustively in switch statements and prevent silent typos
 * at call sites. Matches the 14 official Claude Code hook events
 * (code.claude.com/docs/en/hooks).
 */
export type ClaudeHookEvent =
	| 'hook.session_start'
	| 'hook.session_end'
	| 'hook.pre_tool_use'
	| 'hook.post_tool_use'
	| 'hook.post_tool_use_failure'
	| 'hook.notification'
	| 'hook.user_prompt_submit'
	| 'hook.stop'
	| 'hook.subagent_start'
	| 'hook.subagent_stop'
	| 'hook.pre_compact'
	| 'hook.permission_request'
	| 'hook.teammate_idle'
	| 'hook.task_completed'

/**
 * Git worktree CLI events emitted by worktree commands.
 *
 * Why: Kept for backwards compatibility with consumers that subscribe
 * to worktree events from side-quest-git's CLI domain.
 */
export type WorktreeEvent =
	| 'worktree.created'
	| 'worktree.deleted'
	| 'worktree.synced'
	| 'worktree.cleaned'
	| 'worktree.attached'
	| 'worktree.installed'

/**
 * Session lifecycle events (generic, not Claude Code hook-specific).
 *
 * Why: Kept for backwards compatibility with side-quest-git consumers
 * that use the session.started/ended/compacted convention, plus
 * safety.blocked and command.executed from hook domain.
 */
export type SessionEvent =
	| 'session.started'
	| 'session.ended'
	| 'session.compacted'
	| 'safety.blocked'
	| 'command.executed'

/**
 * Union of all known event types, plus an open string escape hatch.
 *
 * Why: `(string & {})` allows arbitrary event type strings without
 * losing autocomplete on known members. This lets external consumers
 * extend the event type system without requiring a schema change here.
 * TypeScript preserves autocomplete hints while still accepting any string.
 */
export type EventType =
	| ClaudeHookEvent
	| WorktreeEvent
	| SessionEvent
	| (string & {})

/**
 * Event envelope wrapping all events produced by the observability system.
 *
 * Why: A single canonical envelope means every consumer (dashboard,
 * CLI tail, voice TTS) can deserialize any event without knowing
 * its specific type. The generic `data` field carries event-specific
 * payload while shared fields (`id`, `timestamp`, `correlationId`)
 * support filtering, deduplication, and tracing.
 */
export interface EventEnvelope<T = unknown> {
	/** Schema version for forward-compatibility checks. */
	readonly schemaVersion: '1.0.0'
	/** Unique event ID (nanoId). */
	readonly id: string
	/** ISO 8601 UTC timestamp of event creation. */
	readonly timestamp: string
	/** Discriminator for the event payload shape. */
	readonly type: EventType
	/** Application name (was "repo" in side-quest-git). */
	readonly app: string
	/** Absolute path to the application root (was "gitRoot"). */
	readonly appRoot: string
	/** Event source -- CLI command or Claude Code hook. */
	readonly source: 'cli' | 'hook'
	/** W3C-compatible 8-char hex correlation ID for tracing. */
	readonly correlationId: string
	/** Event-specific payload. */
	readonly data: T
}

/**
 * Context provided when creating events via the schema factory.
 *
 * Why: Encapsulates the per-session or per-command context that all
 * events produced in the same logical operation share. The optional
 * `correlationId` allows callers to provide an existing ID (e.g. from
 * a parent span) or let the factory generate a fresh one.
 */
export interface EventContext {
	/** Application name (was "repo" in side-quest-git). */
	readonly app: string
	/** Absolute path to the application root (was "gitRoot"). */
	readonly appRoot: string
	/** Event source -- CLI command or Claude Code hook. */
	readonly source: 'cli' | 'hook'
	/** Optional correlation ID; auto-generated if omitted. */
	readonly correlationId?: string
}
