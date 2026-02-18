/**
 * Event factory for creating type-safe event envelopes.
 *
 * Why: Centralises envelope creation so all events have consistent
 * structure, unique IDs via nanoId, and UTC timestamps. Correlation
 * IDs use generateCorrelationId for W3C-compatible 8-char hex format.
 * Using a single factory prevents envelope fields from drifting across
 * call sites and makes the schema contract explicit.
 */

import { generateCorrelationId } from '@side-quest/core/instrumentation'
import { nanoId } from '@side-quest/core/utils'
import type { EventContext, EventEnvelope, EventType } from './types.js'

/**
 * Create an event envelope with auto-generated id and timestamp.
 *
 * Why: Centralises envelope creation so all events have consistent
 * structure, unique IDs, and UTC timestamps. The `correlationId` is
 * forwarded from the caller's context when one already exists (e.g.
 * to group related events in a single session), or generated fresh
 * when none is provided.
 *
 * @param type - The event type discriminator
 * @param data - Event-specific payload
 * @param context - Shared context (app, appRoot, source, optional correlationId)
 * @returns Fully-formed event envelope ready for serialisation
 *
 * @example
 * ```ts
 * const event = createEvent('worktree.created', { branch: 'feat/foo' }, {
 *   app: 'my-project',
 *   appRoot: '/home/user/my-project',
 *   source: 'cli',
 * })
 * ```
 */
export function createEvent<T>(
	type: EventType,
	data: T,
	context: EventContext,
): EventEnvelope<T> {
	return {
		schemaVersion: '1.0.0',
		id: nanoId(),
		timestamp: new Date().toISOString(),
		type,
		app: context.app,
		appRoot: context.appRoot,
		source: context.source,
		correlationId: context.correlationId ?? generateCorrelationId(),
		data,
	}
}
