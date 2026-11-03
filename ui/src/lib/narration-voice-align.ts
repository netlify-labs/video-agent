// Align to AI voice (docs/plans/2026-11-02-record-your-own-voiceover.md §2.4, phase 6): the draft's AI voice stems,
// fetched next to its preview page and decoded once, placed on the composition timeline for alignToVoice
// (src/lib/narration-align.ts), and the one editor command that applies a suggestion.
import { alignToVoice, type AlignSuggestion, type VoiceStem } from '../../../src/lib/narration-align'
import { secondsToSamples, type NarrationClip } from '../../../src/lib/timeline'
import type { NarrationCommand } from './narration-commands'
import type { Decoder } from './narration-decode'
import type { TimelineComposition } from '../components/timeline'

/** An AI voice clip on the composition: its file (relative to the preview page) and where and how long it plays. */
export interface VoicePlacement {
  src: string
  start: number
  length: number
}

/** The AI voice clips the timeline shows, in composition samples. */
export function voicePlacements(c: Pick<TimelineComposition, 'beats'>): VoicePlacement[] {
  return c.beats.flatMap((b) =>
    b.voice?.src
      ? [
          {
            src: b.voice.src,
            start: secondsToSamples(b.start + b.voice.start),
            length: secondsToSamples(b.voice.duration),
          },
        ]
      : [],
  )
}

/**
 * The stems, fetched relative to `pageUrl` (the draft's preview link) and decoded to 24 kHz mono, each cut to the
 * length it plays. A file used twice is fetched once; one that fails is left out.
 */
export async function loadVoiceStems(
  pageUrl: string,
  voices: readonly VoicePlacement[],
  decode: Decoder,
  get: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<VoiceStem[]> {
  const files = new Map<string, Promise<Float32Array | null>>()
  const load = (src: string) => {
    let p = files.get(src)
    if (!p) {
      p = (async () => {
        try {
          const res = await get(new URL(src, pageUrl).href)
          return res.ok ? await decode(await res.arrayBuffer()) : null
        } catch {
          return null
        }
      })()
      files.set(src, p)
    }
    return p
  }
  const out: VoiceStem[] = []
  for (const v of voices) {
    const mono = await load(v.src)
    if (mono?.length) out.push({ start: v.start, samples: mono.subarray(0, Math.max(0, v.length)) })
  }
  return out
}

/** Where the clip's take starts on the composition now (its sample 0), the centre of the search. */
export const takeOrigin = (c: NarrationClip): number => c.start - c.srcStart

/** A suggestion for the clip's take, or null. */
export const suggestFor = (
  mono: Float32Array,
  stems: readonly VoiceStem[],
  clip: NarrationClip,
): AlignSuggestion | null => alignToVoice(mono, stems, { near: takeOrigin(clip) })

/**
 * The one command (one undo step) that puts the take where the suggestion says: a take with extra audio before the
 * voice (a negative start) starts at 0 with that lead-in trimmed off.
 */
export function alignCommand(clip: NarrationClip, s: AlignSuggestion): NarrationCommand {
  const start = s.start + clip.srcStart
  return start >= 0
    ? { type: 'move', clipId: clip.id, start }
    : { type: 'move', clipId: clip.id, start: 0, srcStart: clip.srcStart - start }
}
