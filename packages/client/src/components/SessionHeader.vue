<script setup lang="ts">
/**
 * SessionHeader -- sticky dashboard header with connection status and filter.
 *
 * Why: A sticky header lets the user see connection state and control
 * filtering without scrolling up. Glassmorphism (backdrop-blur) lets the
 * event feed scroll underneath with a frosted-glass effect (community #5).
 *
 * Contains:
 * - Dashboard title (LCARS orange branding)
 * - Connection indicator (double-layer pulsing dot, community pattern #2)
 * - Event count badge (font-mono tabular-nums)
 * - Events/min counter
 * - Session ID (truncated to 8 chars)
 * - Model name (formatted short form)
 * - Inline event type <select> filter
 */
import { computed } from 'vue'

const props = defineProps<{
	/** True when WebSocket connection is open. */
	isConnected: boolean
	/** Total number of events in the buffer. */
	eventCount: number
	/** Session ID from the most recent session_start event, or null. */
	sessionId: string | null
	/** Application name from the most recent event, or null. */
	appName: string | null
	/** Model name from the most recent session_start event, or null. */
	model: string | null
	/** Events received in the last 60 seconds. */
	eventsPerMinute: number
	/** Unique event types present in the current buffer. */
	availableEventTypes: string[]
	/** Currently selected event type filter ('' = show all). */
	selectedEventType: string
}>()

const emit = defineEmits<{
	/** Emitted when the user changes the event type filter. */
	'update:selectedEventType': [type: string]
}>()

// -------------------------------------------------------------------------
// Display helpers
// -------------------------------------------------------------------------

/**
 * Format a model name string to a short human-readable form.
 *
 * Examples:
 *   'claude-sonnet-4-5-20250929' --> 'sonnet-4-5'
 *   'claude-opus-4-20250101'     --> 'opus-4'
 *   'claude-haiku-3'             --> 'haiku-3'
 *
 * Why: Full model strings are verbose. The distinguishing part is
 * the model family + version (after 'claude-', before the date suffix).
 *
 * @param raw - Raw model string from session_start data
 * @returns Short formatted model name
 */
function formatModel(raw: string | null): string | null {
	if (!raw) return null
	// Strip 'claude-' prefix and trailing date suffix (8 digits)
	const stripped = raw.replace(/^claude-/, '').replace(/-\d{8}$/, '')
	return stripped || raw
}

/**
 * Truncate a session ID to 8 characters for compact display.
 *
 * Why: Session IDs are typically long hex/UUID strings. The first 8 chars
 * are sufficient for visual identification in a single-session dashboard.
 *
 * @param id - Full session ID string
 * @returns First 8 characters of the ID
 */
function truncateSessionId(id: string | null): string | null {
	if (!id) return null
	return id.slice(0, 8)
}

/**
 * Format an event type key for use in the filter <select> option label.
 *
 * Example: 'hook.pre_tool_use' --> 'PreToolUse'
 *
 * @param type - Raw event type string
 * @returns Display label
 */
function formatEventTypeLabel(type: string): string {
	const parts = type.split('.')
	const label = parts[parts.length - 1] ?? type
	return label
		.split('_')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('')
}

const shortSessionId = computed(() => truncateSessionId(props.sessionId))
const shortModel = computed(() => formatModel(props.model))
</script>

<template>
	<!--
	  Sticky header with glassmorphism (community pattern #5).
	  Why /80 opacity: makes the backdrop-blur visible. A fully opaque
	  background hides the blur effect entirely.
	-->
	<header
		class="sticky top-0 z-40 w-full backdrop-blur-xl"
		:style="{
			backgroundColor: 'color-mix(in srgb, var(--color-header-bg) 80%, transparent)',
			borderBottom: '1px solid var(--color-header-border)',
		}"
	>
		<div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
			<!-- Left: Title + connection indicator -->
			<div class="flex items-center gap-3">
				<!-- Dashboard title (LCARS orange branding) -->
				<h1
					class="text-sm font-semibold tracking-wider uppercase"
					:style="{ color: 'var(--color-text-primary)' }"
				>
					Observability
				</h1>

				<!--
				  Connection indicator: double-layer pulsing dot (community pattern #2).
				  Outer animate-ping ring + inner solid dot.
				  Why two layers: solid dot stays visible during the ping animation.
				  motion-safe: respects prefers-reduced-motion.
				-->
				<div class="flex items-center gap-1.5">
					<span
						class="relative flex h-2 w-2"
						role="status"
						:aria-label="isConnected ? 'Connected to event server' : 'Disconnected from event server'"
					>
						<!-- Ping ring (outer) -->
						<span
							class="absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping"
							:style="{
								backgroundColor: isConnected
									? 'var(--color-connected)'
									: 'var(--color-disconnected)',
							}"
						/>
						<!-- Solid dot (inner) -->
						<span
							class="relative inline-flex h-2 w-2 rounded-full"
							:style="{
								backgroundColor: isConnected
									? 'var(--color-connected)'
									: 'var(--color-disconnected)',
							}"
						/>
					</span>
					<!-- Text label for color-blind safety -->
					<span
						class="text-xs"
						:style="{
							color: isConnected
								? 'var(--color-connected)'
								: 'var(--color-disconnected)',
						}"
					>
						{{ isConnected ? 'Connected' : 'Disconnected' }}
					</span>
				</div>
			</div>

			<!-- Center: Metrics -->
			<div class="flex items-center gap-4">
				<!-- Event count badge (tabular-nums prevents layout jitter) -->
				<div class="flex items-center gap-1.5">
					<span
						class="text-xs"
						:style="{ color: 'var(--color-text-tertiary)' }"
					>
						Events
					</span>
					<span
						class="inline-flex items-center rounded-[var(--radius-badge)] border px-2 py-0.5 text-xs font-mono tabular-nums font-medium"
						:style="{
							backgroundColor: 'var(--color-badge-bg)',
							borderColor: 'var(--color-badge-border)',
							color: 'var(--color-badge-text)',
						}"
					>
						{{ eventCount }}
					</span>
				</div>

				<!-- Events per minute (tabular-nums prevents layout jitter) -->
				<div class="flex items-center gap-1">
					<span
						class="font-mono tabular-nums text-sm font-semibold"
						:style="{ color: 'var(--color-text-heading)' }"
					>
						{{ eventsPerMinute }}
					</span>
					<span
						class="text-xs"
						:style="{ color: 'var(--color-text-tertiary)' }"
					>
						/min
					</span>
				</div>

				<!-- Session ID (when available) -->
				<div
					v-if="shortSessionId"
					class="hidden items-center gap-1 sm:flex"
				>
					<span
						class="text-xs"
						:style="{ color: 'var(--color-text-tertiary)' }"
					>
						session
					</span>
					<span
						class="font-mono text-xs"
						:style="{ color: 'var(--color-text-secondary)' }"
					>
						{{ shortSessionId }}
					</span>
				</div>

				<!-- Model name (when available) -->
				<div
					v-if="shortModel"
					class="hidden items-center gap-1 sm:flex"
				>
					<span
						class="text-xs"
						:style="{ color: 'var(--color-text-tertiary)' }"
					>
						model
					</span>
					<span
						class="text-xs"
						:style="{ color: 'var(--color-text-secondary)' }"
					>
						{{ shortModel }}
					</span>
				</div>
			</div>

			<!-- Right: Event type filter -->
			<div class="flex items-center gap-2">
				<label
					for="event-type-filter"
					class="text-xs"
					:style="{ color: 'var(--color-text-tertiary)' }"
				>
					Filter
				</label>
				<select
					id="event-type-filter"
					class="rounded-[var(--radius-sm)] border px-2 py-1 text-xs transition-colors duration-150"
					:style="{
						backgroundColor: 'var(--color-filter-bg)',
						borderColor: 'var(--color-filter-border)',
						color: 'var(--color-filter-text)',
					}"
					:value="selectedEventType"
					@change="emit('update:selectedEventType', ($event.target as HTMLSelectElement).value)"
				>
					<option value="">All events</option>
					<option
						v-for="type in availableEventTypes"
						:key="type"
						:value="type"
					>
						{{ formatEventTypeLabel(type) }} ({{ type }})
					</option>
				</select>
			</div>
		</div>

		<!-- App name bar (when available) -->
		<div
			v-if="appName"
			class="px-4 py-1"
			:style="{ borderTop: '1px solid var(--color-border-subtle)' }"
		>
			<p
				class="font-mono text-xs"
				:style="{ color: 'var(--color-text-tertiary)' }"
			>
				{{ appName }}
			</p>
		</div>
	</header>
</template>
