<script setup lang="ts">
/**
 * App.vue -- root layout shell for the observability dashboard.
 *
 * Why: App.vue holds the top-level state and wires components together.
 * It is the single source of truth for:
 * - The events array (via useEventStream)
 * - The filter selection (local ref, display concern only)
 * - Derived metadata (sessionId, model, appName) from the latest events
 *
 * Layout: flex h-screen shell, sidebar-ready for v1.1 without refactoring.
 * Adding a sidebar in v1.1 is a slot addition, not a layout restructure.
 *
 * Data flow (unidirectional):
 *   useEventStream -> events shallowRef
 *     -> filteredEvents computed
 *       -> EventFeed receives filtered events
 *   useEventStream -> isConnected, eventsPerMinute
 *     -> SessionHeader receives connection state + metrics
 *   SessionHeader emits update:selectedEventType
 *     -> selectedEventType ref updated
 *       -> filteredEvents recomputed
 */
import { computed, ref } from 'vue'
import EventFeed from './components/EventFeed.vue'
import SessionHeader from './components/SessionHeader.vue'
import { useEventStream } from './composables/useEventStream'
import { config } from './config'
import type { HookEventData } from './types'

// -------------------------------------------------------------------------
// Event stream
// -------------------------------------------------------------------------

const { events, isConnected, error, connectionAttempts, eventsPerMinute } =
	useEventStream()

// -------------------------------------------------------------------------
// Filter state
// -------------------------------------------------------------------------

/** Currently selected event type filter. Empty string = show all. */
const selectedEventType = ref('')

// -------------------------------------------------------------------------
// Derived metadata from the event buffer
// -------------------------------------------------------------------------

/**
 * Extract session ID from the most recent session_start event.
 *
 * Why: The session ID is the primary identity for the current Claude session.
 * We scan from the end of the buffer to find the most recent one.
 */
const sessionId = computed(() => {
	const evts = events.value
	for (let i = evts.length - 1; i >= 0; i--) {
		const e = evts[i]!
		if (e.type === 'hook.session_start') {
			const d = e.data as HookEventData
			return typeof d.sessionId === 'string' ? d.sessionId : null
		}
	}
	return null
})

/** Application name from the most recent event. */
const appName = computed(() => {
	const evts = events.value
	if (evts.length === 0) return null
	return evts[evts.length - 1]?.app ?? null
})

/** Model from the most recent session_start event. */
const model = computed(() => {
	const evts = events.value
	for (let i = evts.length - 1; i >= 0; i--) {
		const e = evts[i]!
		if (e.type === 'hook.session_start') {
			const d = e.data as HookEventData
			return typeof d.model === 'string' ? d.model : null
		}
	}
	return null
})

// -------------------------------------------------------------------------
// Filter options -- unique event types present in the buffer
// -------------------------------------------------------------------------

/**
 * Unique event types present in the current event buffer.
 *
 * Why: The filter <select> should only show types that exist in the buffer.
 * Computed from events so it updates as new event types arrive.
 * Sorted for stable dropdown order.
 */
const availableEventTypes = computed(() => {
	const types = new Set<string>()
	for (const e of events.value) {
		types.add(String(e.type))
	}
	return [...types].sort()
})

// -------------------------------------------------------------------------
// Filtered events (5-line inline computed -- no composable needed)
// -------------------------------------------------------------------------

/**
 * The events array filtered by the selected event type.
 *
 * Why inline computed (not a composable): filtering is a display concern
 * local to App.vue. A composable would add an abstraction layer for
 * 2 lines of logic. The event buffer itself always holds ALL events.
 */
const filteredEvents = computed(() => {
	if (!selectedEventType.value) return events.value
	const filter = selectedEventType.value
	return events.value.filter((e) => String(e.type) === filter)
})

const serverUrl = config.serverUrl
</script>

<template>
	<!--
	  Outer shell: flex h-screen.
	  Why: v1.1 sidebar insertion is a slot addition here, not a layout refactor.
	  flex-col on the main content column gives SessionHeader + EventFeed stacking.
	-->
	<div
		class="flex h-screen"
		:style="{ backgroundColor: 'var(--color-bg-app)' }"
	>
		<!-- Sidebar slot: empty in v1, shadcn-vue Sidebar in v1.1 -->

		<!-- Main content column -->
		<div class="flex flex-1 flex-col overflow-hidden">
			<SessionHeader
				:is-connected="isConnected"
				:event-count="filteredEvents.length"
				:session-id="sessionId"
				:app-name="appName"
				:model="model"
				:events-per-minute="eventsPerMinute"
				:available-event-types="availableEventTypes"
				:selected-event-type="selectedEventType"
				@update:selected-event-type="(v: string) => selectedEventType = v"
			/>

			<div
				class="px-4 py-2 text-xs"
				:style="{
					backgroundColor: 'color-mix(in srgb, var(--color-bg-surface) 70%, transparent)',
					borderBottom: '1px solid var(--color-border-subtle)',
					color: 'var(--color-text-tertiary)',
				}"
			>
				<div>Live event dashboard for Claude Code hooks and Side Quest tooling.</div>
				<div>
					Server target:
					<span
						class="font-mono"
						:style="{ color: 'var(--color-text-secondary)' }"
					>{{ serverUrl }}</span>
				</div>
				<div
					v-if="error"
					:style="{ color: 'var(--color-status-warning)' }"
				>
					Reconnecting (attempt {{ connectionAttempts }}): {{ error }}
				</div>
			</div>

			<EventFeed
				:events="filteredEvents"
				:events-per-minute="eventsPerMinute"
			/>
		</div>
	</div>
</template>
