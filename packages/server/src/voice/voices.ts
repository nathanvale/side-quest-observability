/**
 * Voice character identity and phrase library.
 *
 * Why: Co-locates voice IDs with phrases -- the data is small and tightly coupled.
 * No separate phrases.ts module needed for ~30 lines. Voice IDs are TBD_ placeholders
 * until ElevenLabs voices are selected; they are only used by the generate-clips script,
 * not by the server at runtime.
 *
 * v1: 5 characters, 2 phrases each per phase (start + stop), flat random selection.
 * v1.1: Expand to weighted selection after listening session validates phrase quality.
 */

/**
 * A single voice character entry in the VOICE_MAP.
 *
 * Why: voiceId is only read by the generate-clips script -- the server
 * only needs cached clip paths. Phrases are co-located for easy editing.
 */
interface VoiceEntry {
	/** ElevenLabs voice ID (used by generate-clips.ts, not the runtime server). */
	voiceId: string
	/** Display name for logging, e.g. 'Scotty'. */
	label: string
	phrases: {
		/** Phrases to play when an agent starts a task. */
		start: string[]
		/** Phrases to play when an agent completes a task. */
		stop: string[]
	}
}

/**
 * Voice character map keyed by agent_type.
 *
 * Why: Keyed by agent_type so the router can resolve a character with a
 * single O(1) lookup. All 5 characters' clips are pre-generated and cached
 * in v1 -- ready for v2 SubagentStart/SubagentStop wiring with zero changes here.
 *
 * Voice IDs are TBD_* placeholders until ElevenLabs voices are selected in v1.1.
 */
export const VOICE_MAP: Record<string, VoiceEntry> = {
	'enterprise:builder-scotty': {
		voiceId: 'TBD_SCOTTISH_MALE',
		label: 'Scotty',
		phrases: {
			start: [
				'Scotty here, Captain. Beginning repairs.',
				"Aye, I'll get right on it.",
			],
			stop: ['Repairs complete, Captain.', 'All systems operational, Captain.'],
		},
	},
	'enterprise:validator-mccoy': {
		voiceId: 'TBD_SOUTHERN_MALE',
		label: 'McCoy',
		phrases: {
			start: [
				"I'm a doctor, not a rubber stamp. Let me take a look.",
				'McCoy here. Beginning my review.',
			],
			stop: ['Clean bill of health, Captain.', 'The examination is complete.'],
		},
	},
	'enterprise:ships-computer-cpu': {
		voiceId: 'TBD_NEUTRAL_FEMALE',
		label: 'Computer',
		phrases: {
			start: ['Working.', 'Processing request.'],
			stop: ['Analysis complete.', 'Report ready, Captain.'],
		},
	},
	'enterprise:API': {
		voiceId: 'TBD_CALM_MALE',
		label: 'Spock',
		phrases: {
			start: ['Fascinating. Commencing analysis.', 'Logical. Proceeding.'],
			stop: [
				'The mission is complete, Captain.',
				'Analysis complete. The data is conclusive.',
			],
		},
	},
	'newsroom:beat-reporter': {
		voiceId: 'TBD_NEWSMAN_MALE',
		label: 'Mickey Malone',
		phrases: {
			start: [
				"Mickey Malone here. I'm on the beat.",
				'Got a lead, boss. Chasing it down.',
			],
			stop: ['Story filed, chief.', 'The scoop is in. Read all about it.'],
		},
	},
}

/**
 * Select a random phrase for the given agent type and phase.
 *
 * Why: Flat random selection from 2 candidates is sufficient for v1.
 * Weighted selection is deferred to v1.1 after a listening session
 * validates which phrases sound natural.
 *
 * @param agentType - Agent type string, e.g. 'enterprise:builder-scotty'
 * @param phase - Event phase: 'start' or 'stop'
 * @returns A random phrase string, or null if the agent type is unknown
 */
export function selectPhrase(
	agentType: string,
	phase: 'start' | 'stop',
): string | null {
	const entry = VOICE_MAP[agentType]
	if (!entry) return null
	const candidates = entry.phrases[phase]
	if (!candidates || candidates.length === 0) return null
	return candidates[Math.floor(Math.random() * candidates.length)] ?? null
}
