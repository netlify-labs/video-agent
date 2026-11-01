// The voice-over choice (SPIKES.md S9) as requests send it and as versions and plans store it.
import type { PlanBrief, Voiceover } from './types.js'

export interface VoiceoverInput {
  enabled: boolean
  voice?: string | undefined
  speed?: number | undefined
  script?: string[] | undefined
}

/** What a version or plan stores: null when off; unset fields stay null so the run picks them. */
export function voiceoverFrom(input: VoiceoverInput): Voiceover | null {
  if (!input.enabled) return null
  const script = (input.script ?? []).map((l) => l.trim()).filter(Boolean)
  return { voice: input.voice ?? null, speed: input.speed ?? null, script: script.length ? script : null }
}

/**
 * A plan's voice-over with the brief's narration as the script. The brief was written from the person's script when
 * they gave one, and they may have edited it since, so its narration wins; the plan's script is the fallback.
 */
export function withPlanNarration(v: Voiceover | null, brief: PlanBrief | null): Voiceover | null {
  if (!v || !brief) return v
  const lines = brief.beats.map((b) => b.narration?.trim() ?? '').filter(Boolean)
  return lines.length ? { ...v, script: lines } : v
}
