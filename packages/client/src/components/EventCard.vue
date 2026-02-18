<script setup lang="ts">
/**
 * EventCard -- renders a single event envelope as a card row.
 *
 * Why: Separating card rendering from the feed list allows EventFeed
 * to manage scroll/animation concerns while EventCard owns display logic.
 * The card uses semantic tokens exclusively (no raw Tailwind colors).
 *
 * Design patterns used:
 * - Left border color via getEventColor() -> --color-event-* tokens
 * - Error events: red tint + negative margin bleed (community pattern #4)
 * - Hook type badge: opacity modifier tint (community pattern #3)
 * - Timestamp: font-mono tabular-nums to prevent layout jitter (pattern #1)
 * - Inline agent_type badge when present (deferred OfficerPanel replacement)
 */
import { computed, ref } from 'vue'
import type { EventEnvelope, EventType, HookEventData } from '../types'

const props = defineProps<{
	/** The event envelope to render. */
	event: EventEnvelope
}>()

// -------------------------------------------------------------------------
// Expand/collapse JSON detail panel
// -------------------------------------------------------------------------

const isExpanded = ref(false)

function _toggleExpand(): void {
	isExpanded.value = !isExpanded.value
}

// -------------------------------------------------------------------------
// Event color mapping (left border accent)
// -------------------------------------------------------------------------

/**
 * Map an event type to its semantic --color-event-* CSS variable.
 *
 * Why: Inline function instead of a composable -- 10 lines, single consumer.
 * Uses startsWith/includes to future-proof against new hook subtypes.
 *
 * @param type - The event type string from the envelope
 * @returns CSS variable reference string for border-left-color
 */
function getEventColor(type: EventType): string {
	if (type.startsWith('hook.session') || type.startsWith('session.')) {
		return 'var(--color-event-session)'
	}
	if (type.includes('failure') || type === 'safety.blocked') {
		return 'var(--color-event-error)'
	}
	if (type.startsWith('hook.pre_tool') || type.startsWith('hook.post_tool')) {
		return 'var(--color-event-tool)'
	}
	if (type === 'hook.notification') {
		return 'var(--color-event-notification)'
	}
	if (type === 'hook.user_prompt_submit') {
		return 'var(--color-event-user)'
	}
	return 'var(--color-event-system)'
}

// -------------------------------------------------------------------------
// Error event detection (community pattern #4: critical row highlighting)
// -------------------------------------------------------------------------

const _isErrorEvent = computed(
	() =>
		props.event.type.includes('failure') ||
		props.event.type === 'safety.blocked',
)

// -------------------------------------------------------------------------
// Display helpers
// -------------------------------------------------------------------------

/**
 * Format an event type string for human display.
 *
 * Examples:
 *   'hook.pre_tool_use'  -> 'PreToolUse'
 *   'hook.session_start' -> 'SessionStart'
 *   'worktree.created'   -> 'Created'
 *
 * Why: The dot-delimited type strings are machine-readable. The UI shows
 * the last segment, title-cased, for a clean badge label.
 *
 * @param type - Raw EventType string
 * @returns Human-readable label
 */
function formatEventType(type: EventType): string {
	const parts = String(type).split('.')
	const label = parts[parts.length - 1] ?? String(type)
	return label
		.split('_')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('')
}

/**
 * Format an ISO 8601 timestamp as HH:MM:SS.
 *
 * Why: The full ISO string is too verbose for the card. The time-only
 * format is sufficient for a real-time feed where all events are recent.
 *
 * @param iso - ISO 8601 timestamp string
 * @returns Formatted time string (HH:MM:SS)
 */
function formatTimestamp(iso: string): string {
	try {
		const d = new Date(iso)
		return d.toLocaleTimeString('en-AU', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		})
	} catch {
		return iso
	}
}

// -------------------------------------------------------------------------
// Typed data access
// -------------------------------------------------------------------------

const hookData = computed(() => props.event.data as HookEventData)

const toolName = computed(() => {
	const d = hookData.value
	return typeof d.toolName === 'string' ? d.toolName : null
})

const _agentType = computed(() => {
	const d = hookData.value
	return typeof d.agentType === 'string' ? d.agentType : null
})

const _sessionId = computed(() => {
	const d = hookData.value
	if (typeof d.sessionId === 'string') {
		return d.sessionId.slice(0, 8)
	}
	return null
})

/**
 * A one-line preview of the tool detail for common tools.
 *
 * Why: Bash commands and file paths are the most useful quick-glance
 * details. Showing them inline avoids needing to expand every card.
 */
const _toolDetail = computed((): string | null => {
	const d = hookData.value
	if (!toolName.value) return null

	if (toolName.value === 'Bash' && d.toolInputPreview) {
		const preview = String(d.toolInputPreview)
		return preview.length > 60 ? `${preview.slice(0, 60)}...` : preview
	}

	if (
		(toolName.value === 'Write' || toolName.value === 'Edit') &&
		d.toolInputPreview
	) {
		const match = String(d.toolInputPreview).match(
			/"file_path"\s*:\s*"([^"]+)"/,
		)
		if (match?.[1]) return match[1]
	}

	return null
})

// -------------------------------------------------------------------------
// Formatted JSON for expand panel
// -------------------------------------------------------------------------

const _formattedJson = computed(() => {
	try {
		return JSON.stringify(props.event.data, null, 2)
	} catch {
		return String(props.event.data)
	}
})

// -------------------------------------------------------------------------
// Copy to clipboard
// -------------------------------------------------------------------------

const copySuccess = ref(false)

async function _copyJson(e: MouseEvent): Promise<void> {
	e.stopPropagation()
	try {
		await navigator.clipboard.writeText(JSON.stringify(props.event, null, 2))
		copySuccess.value = true
		setTimeout(() => {
			copySuccess.value = false
		}, 2000)
	} catch {
		// Clipboard not available -- silent fail
	}
}

const _borderColor = computed(() => getEventColor(props.event.type))
const _typeLabel = computed(() => formatEventType(props.event.type))
const _timestamp = computed(() => formatTimestamp(props.event.timestamp))
</script>

<template>
	<!--
	  Error events use the critical row highlight (community pattern #4):
	  red tint background + 2px red left border, tint bleeds to card edges.
	  Normal events: 4px colored left border, subtle hover background.
	-->
	<article
		class="group relative cursor-pointer transition-colors duration-150 ease-in-out"
		:class="
			isErrorEvent
				? 'border-l-2 py-3'
				: 'rounded-[var(--radius-card)] border border-[var(--color-card-border)] bg-[var(--color-card-bg)] hover:bg-[var(--color-card-hover)]'
		"
		:style="
			isErrorEvent
				? {
						borderLeftColor: 'var(--color-status-error)',
						backgroundColor:
							'color-mix(in srgb, var(--color-status-error) 5%, transparent)',
						paddingTop: 'var(--space-3)',
						paddingBottom: 'var(--space-3)',
						paddingLeft: 'var(--space-card-padding)',
						paddingRight: 'var(--space-card-padding)',
					}
				: {
						borderLeftColor: borderColor,
						borderLeftWidth: '4px',
						padding: 'var(--space-3) var(--space-card-padding)',
					}
		"
		@click="toggleExpand"
	>
		<div class="space-y-1">
			<!-- Row 1: Badge + tool name + agent type + timestamp -->
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<!-- Event type badge (opacity modifier pattern #3) -->
					<span
						class="inline-flex items-center rounded-[var(--radius-badge)] px-2 py-0.5 text-[var(--font-size-xs)] font-medium"
						:style="
							isErrorEvent
								? {
										backgroundColor:
											'color-mix(in srgb, var(--color-status-error) 10%, transparent)',
										color: 'var(--color-status-error)',
									}
								: {
										backgroundColor: 'var(--color-badge-bg)',
										color: 'var(--color-badge-text)',
									}
						"
					>
						{{ typeLabel }}
					</span>

					<!-- Tool name (when present) -->
					<span
						v-if="toolName"
						class="text-[var(--font-size-sm)]"
						:style="{ color: 'var(--color-text-secondary)' }"
					>
						{{ toolName }}
					</span>

					<!-- Inline agent_type badge (deferred OfficerPanel) -->
					<span
						v-if="agentType"
						class="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[var(--font-size-xs)]"
						:style="{
							backgroundColor:
								'color-mix(in srgb, var(--color-status-info) 10%, transparent)',
							color: 'var(--color-status-info)',
						}"
					>
						{{ agentType }}
					</span>
				</div>

				<!-- Timestamp (right-aligned, tabular-nums prevents jitter) -->
				<time
					class="shrink-0 font-mono text-[var(--font-size-xs)] tabular-nums"
					:style="{ color: 'var(--color-text-tertiary)' }"
					:datetime="event.timestamp"
				>
					{{ timestamp }}
				</time>
			</div>

			<!-- Row 2: Tool detail preview (Bash command, filename) -->
			<p
				v-if="toolDetail"
				class="truncate font-mono text-[var(--font-size-xs)]"
				:style="{ color: 'var(--color-text-secondary)' }"
			>
				{{ toolDetail }}
			</p>

			<!-- Row 3: Session ID (when present) -->
			<p
				v-if="sessionId"
				class="font-mono text-[var(--font-size-xs)]"
				:style="{ color: 'var(--color-text-tertiary)' }"
			>
				session: {{ sessionId }}
			</p>

			<!-- Expand indicator -->
			<div class="mt-0.5 flex items-center gap-1">
				<span
					class="select-none text-[var(--font-size-xs)]"
					:style="{ color: 'var(--color-text-tertiary)' }"
					aria-hidden="true"
				>
					{{ isExpanded ? '\u25b2 collapse' : '\u25bc expand' }}
				</span>
			</div>

			<!-- Expand/collapse JSON detail panel -->
			<div
				v-if="isExpanded"
				class="relative mt-2"
			>
				<pre
					class="max-h-64 overflow-auto rounded-[var(--radius-sm)] border p-3 font-mono text-[var(--font-size-xs)] leading-relaxed"
					:style="{
						backgroundColor: 'var(--color-json-bg)',
						borderColor: 'var(--color-json-border)',
						color: 'var(--color-json-text)',
					}"
				>{{ formattedJson }}</pre>
				<button
					class="absolute right-2 top-2 rounded-[var(--radius-sm)] px-2 py-0.5 text-[var(--font-size-xs)] transition-colors duration-150"
					:style="{
						backgroundColor: 'var(--color-gray-700)',
						color: 'var(--color-gray-300)',
					}"
					aria-label="Copy JSON to clipboard"
					@click="copyJson"
				>
					{{ copySuccess ? 'Copied!' : 'Copy' }}
				</button>
			</div>
		</div>
	</article>
</template>
