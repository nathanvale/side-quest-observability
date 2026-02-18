<script setup lang="ts">
/**
 * EventFeed -- scrollable real-time event list with auto-scroll.
 *
 * Why: Separating feed mechanics (scroll, animation) from the card
 * rendering (EventCard) keeps each concern focused and testable.
 *
 * Key behaviors:
 * - Auto-scroll: sticks to bottom when user is within 50px of bottom
 * - Pause auto-scroll on manual scroll-up (user is reading old events)
 * - "Jump to latest" button re-engages auto-scroll
 * - TransitionGroup for enter animations, disabled at > 5 events/sec
 *   (Operator I1 fix: prevents layout thrashing at high event rates)
 * - Empty state when no events
 * - Accessibility: role="log" + aria-live for screen reader announcements
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { EventEnvelope } from '../types'
import EventCard from './EventCard.vue'

const props = defineProps<{
	/**
	 * Pre-filtered events array from App.vue.
	 * Why: Filtering is a display concern; the feed renders whatever it receives.
	 */
	events: EventEnvelope[]
	/**
	 * Current events/min rate (from useEventStream).
	 * Why: Used to disable TransitionGroup at high rates to prevent
	 * overlapping animations causing layout thrashing.
	 */
	eventsPerMinute: number
}>()

// -------------------------------------------------------------------------
// Auto-scroll state
// -------------------------------------------------------------------------

const feedEl = ref<HTMLElement | null>(null)
const isAtBottom = ref(true)
const userScrolledUp = ref(false)

/**
 * Check if the scroll position is near the bottom (within 50px).
 *
 * Why: "At bottom" threshold of 50px (not 0) prevents the feed from
 * momentarily losing auto-scroll during the transition between items.
 */
function checkAtBottom(): boolean {
	const el = feedEl.value
	if (!el) return true
	return el.scrollHeight - el.scrollTop - el.clientHeight < 50
}

/** Scroll the feed container to the very bottom. */
function scrollToBottom(): void {
	const el = feedEl.value
	if (!el) return
	el.scrollTop = el.scrollHeight
}

/** Re-engage auto-scroll (called by "Jump to latest" button). */
function jumpToLatest(): void {
	userScrolledUp.value = false
	isAtBottom.value = true
	nextTick(() => scrollToBottom())
}

/** Handle user scroll events to detect manual scroll-up. */
function handleScroll(): void {
	const atBottom = checkAtBottom()
	if (!atBottom) {
		userScrolledUp.value = true
		isAtBottom.value = false
	} else {
		userScrolledUp.value = false
		isAtBottom.value = true
	}
}

// -------------------------------------------------------------------------
// Auto-scroll on new events
// -------------------------------------------------------------------------

/**
 * Watch for new events and scroll to bottom if auto-scroll is active.
 *
 * Why: We watch events.length rather than the full events array to avoid
 * re-running on same-length replacement (filtered view switches).
 * nextTick ensures the DOM has been updated before scrolling.
 */
watch(
	() => props.events.length,
	() => {
		if (!userScrolledUp.value) {
			nextTick(() => scrollToBottom())
		}
	},
)

// -------------------------------------------------------------------------
// Rate-aware TransitionGroup
// -------------------------------------------------------------------------

/**
 * Disable TransitionGroup animations when events arrive faster than 5/min.
 *
 * Wait -- 5/sec or 5/min? The spec says "> 5 events/sec" -- eventsPerMinute
 * is per-minute, so the threshold is 300/min (5 * 60). At 5 events/sec with
 * 300ms transitions, 10 overlapping enter animations cause layout thrashing
 * on 500 DOM nodes. Below that rate, animations improve perceived quality.
 *
 * Why: At high event rates, overlapping CSS enter animations on 500 DOM nodes
 * cause layout thrashing. Disabling them keeps the feed smooth.
 */
const animationsEnabled = computed(() => {
	// > 5 events/sec = > 300/min
	return props.eventsPerMinute <= 300
})

// -------------------------------------------------------------------------
// Cleanup
// -------------------------------------------------------------------------

onUnmounted(() => {
	// No timers to clear -- scroll handling is event-driven
})
</script>

<template>
	<!-- Outer container: flex-1 takes remaining height, overflow scrolls -->
	<div
		ref="feedEl"
		role="log"
		aria-label="Event feed"
		aria-live="polite"
		aria-relevant="additions"
		class="relative flex-1 overflow-y-auto"
		:style="{ backgroundColor: 'var(--color-bg-app)' }"
		@scroll="handleScroll"
	>
		<!-- "Jump to latest" button -- appears when user has scrolled up -->
		<Transition name="jump-btn">
			<button
				v-if="userScrolledUp"
				type="button"
				class="sticky top-3 z-30 mx-auto flex w-fit cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150"
				:style="{
					backgroundColor: 'var(--color-bg-surface)',
					borderColor: 'var(--color-border-brand)',
					color: 'var(--color-text-primary)',
				}"
				@click="jumpToLatest"
			>
				<span aria-hidden="true">&#8595;</span>
				Jump to latest
			</button>
		</Transition>

		<!-- Empty state -->
		<div
			v-if="events.length === 0"
			class="flex h-full min-h-64 flex-col items-center justify-center gap-2"
		>
			<p
				class="text-base font-semibold"
				:style="{ color: 'var(--color-text-primary)' }"
			>
				Observability Dashboard is live
			</p>
			<p
				class="text-sm"
				:style="{ color: 'var(--color-text-tertiary)' }"
			>
				Waiting for events...
			</p>
			<p
				class="text-xs"
				:style="{ color: 'var(--color-text-tertiary)' }"
			>
				Start a Claude Code session and run a command to populate the feed.
			</p>
		</div>

		<!-- Event list with optional enter animations -->
		<TransitionGroup
			v-else
			tag="ul"
			:name="animationsEnabled ? 'event-enter' : undefined"
			class="flex flex-col gap-2 p-3"
			role="list"
			aria-label="Events"
		>
			<li
				v-for="event in events"
				:key="event.id"
				class="list-none"
			>
				<EventCard :event="event" />
			</li>
		</TransitionGroup>
	</div>
</template>

<style scoped>
/* Jump-to-latest button fade */
.jump-btn-enter-active,
.jump-btn-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.jump-btn-enter-from,
.jump-btn-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Event card enter animation (disabled at high rates via animationsEnabled) */
@media (prefers-reduced-motion: no-preference) {
  .event-enter-enter-active {
    transition: opacity 0.3s ease, transform 0.3s ease;
  }

  .event-enter-enter-from {
    opacity: 0;
    transform: translateY(-6px);
  }
}
</style>
