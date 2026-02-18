/**
 * Client-side event type definitions for the observability dashboard.
 *
 * Why: Mirrors the server's types.ts exactly (OBS-1 PR1 schema) so the
 * client and server share the same contract without a shared package.
 * All 14 ClaudeHookEvent members are forward-declared even though only 5
 * are active in v1 -- this prevents a client-side type change when PR2 ships.
 * Unknown event types fall through to getEventColor()'s default (gray),
 * so future events render safely without a client update.
 */

/**
 * Claude Code hook lifecycle event types.
 *
 * v1 active: session_start, pre_tool_use, post_tool_use,
 *            post_tool_use_failure, stop
 * v2 forward-declared (not yet emitted by server): remaining 9
 */
export type ClaudeHookEvent =
	// v1 (OBS-1 PR1 -- active)
	| 'hook.session_start'
	| 'hook.pre_tool_use'
	| 'hook.post_tool_use'
	| 'hook.post_tool_use_failure'
	| 'hook.stop'
	// v2 (OBS-1 PR2 -- forward-declared, not yet emitted by server)
	| 'hook.session_end'
	| 'hook.notification'
	| 'hook.user_prompt_submit'
	| 'hook.subagent_start'
	| 'hook.subagent_stop'
	| 'hook.pre_compact'
	| 'hook.permission_request'
	| 'hook.teammate_idle'
	| 'hook.task_completed'

/** Git worktree CLI events. */
export type WorktreeEvent =
	| 'worktree.created'
	| 'worktree.deleted'
	| 'worktree.synced'
	| 'worktree.cleaned'
	| 'worktree.attached'
	| 'worktree.installed'

/** Session lifecycle events. */
export type SessionEvent =
	| 'session.started'
	| 'session.ended'
	| 'session.compacted'
	| 'safety.blocked'
	| 'command.executed'

/**
 * Union of all known event types.
 *
 * Why: `(string & {})` allows unknown event type strings without losing
 * autocomplete on known members -- forward-compatible with new hook types
 * added in Claude Code without requiring a client update.
 */
export type EventType =
	| ClaudeHookEvent
	| WorktreeEvent
	| SessionEvent
	| (string & {})

/**
 * Event envelope wrapping all events from the observability server.
 *
 * Why: Single canonical envelope -- every event type can be deserialized
 * without knowing its specific payload shape. Shared fields (id, timestamp,
 * correlationId) support filtering, deduplication, and display.
 */
export interface EventEnvelope<T = unknown> {
	/** Schema version for forward-compatibility checks. */
	readonly schemaVersion: '1.0.0'
	/** Unique event ID (nanoId). Used for deduplication on reconnect. */
	readonly id: string
	/** ISO 8601 UTC timestamp of event creation. */
	readonly timestamp: string
	/** Discriminator for the event payload shape. */
	readonly type: EventType
	/** Application name. */
	readonly app: string
	/** Absolute path to the application root. */
	readonly appRoot: string
	/** Event source -- CLI command or Claude Code hook. */
	readonly source: 'cli' | 'hook'
	/** W3C-compatible 8-char hex correlation ID for tracing. */
	readonly correlationId: string
	/** Event-specific payload. */
	readonly data: T
}

/**
 * Typed data shape for hook events (fields normalised by the server).
 *
 * Why: The server's extractEventFields() normalises camelCase field names.
 * This interface captures the common fields present across hook event types
 * so EventCard can access them without casting to `any`.
 */
export interface HookEventData {
	readonly hookEvent?: string
	readonly sessionId?: string
	readonly toolName?: string
	readonly agentType?: string
	readonly model?: string
	readonly toolInputPreview?: unknown
	readonly toolResultPreview?: unknown
	readonly toolError?: string
	readonly toolUseId?: string
	readonly permissionMode?: string
	readonly transcriptPath?: string
	readonly source?: string
	[key: string]: unknown
}
