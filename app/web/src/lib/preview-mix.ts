// The composition preview's audio mix while narration is auditioned (docs/plans/2026-11-02-record-your-own-voiceover.md
// §5.4): what the bridge's `mix{tracks}` command (app/server/preview/bridge.js) should do to the iframe's <audio> elements,
// by role, for a NarrationOp. The levels follow writeNarration's rules and the music's dip is the shared duckPoints,
// computed on the composition with the op's narration written in, so the preview ducks where the render will.
import { duckPoints, load, writeNarration, type AudioRole, type Doc } from '../../../server/lib/contract'
import { dbToGain, placeSpans, type NarrationOp, type Span } from '../../../server/lib/timeline'

/** A volume point of a HyperFrames automation lane: t seconds from the element's start, v a gain (0-4). */
export interface LanePoint {
  t: number
  v: number
}

/**
 * One role's mix. `gain` multiplies each element's own level (data-volume; 0-4); `muted` silences it; `lane`
 * replaces its volume automation (null removes it, absent keeps the composition's own). The runtime interpolates
 * the lane on the composition clock, so keyframes are sent once per change, not per frame.
 */
export interface TrackMix {
  gain?: number
  muted?: boolean
  lane?: LanePoint[] | null
}

/** The bridge's mix command payload. A role left out plays as the composition has it. */
export type MixTracks = Partial<Record<AudioRole, TrackMix>>

/**
 * The preview mix for auditioning `op`:
 * - narration: the iframe's own bus (a rendered version's bus.wav) is muted, since the parent plays the clips;
 * - voice: replace mutes the AI voice, under lowers it by aiVoice.volumeDb, keep leaves it;
 * - original.muteAll, or narration solo, mutes music, voice and effects;
 * - music: with tracks.music.duck, the lane dips to duckDb under narration speech (and audible AI voices); without
 *   it, a layer with its own data-va-duck keeps dipping under the AI voices still audible, and others keep their lane.
 * `takeSpans` is each take's speech summary in source samples (a take without one counts as speech throughout).
 */
export function previewMix(
  html: string,
  op: NarrationOp,
  takeSpans: ReadonlyMap<string, readonly Span[]> = new Map(),
): MixTracks {
  const { tracks } = op
  const silenced = tracks.original.muteAll || tracks.narration.solo
  const voice: TrackMix =
    silenced || tracks.aiVoice.mode === 'replace'
      ? { muted: true }
      : tracks.aiVoice.mode === 'under'
        ? { gain: dbToGain(tracks.aiVoice.volumeDb) }
        : {}
  const mix: MixTracks = {
    narration: { muted: true },
    voice,
    sfx: silenced ? { muted: true } : {},
    music: silenced ? { muted: true } : {},
  }
  if (silenced) return mix
  const lane = musicLane(html, op, takeSpans)
  if (lane === undefined) return mix
  mix.music = { lane }
  return mix
}

/** The music's volume lane for the preview; undefined to leave it as the composition has it (or it doesn't parse). */
export function musicLane(
  html: string,
  op: NarrationOp,
  takeSpans: ReadonlyMap<string, readonly Span[]> = new Map(),
): LanePoint[] | undefined {
  let d: Doc
  try {
    d = load(html)
  } catch {
    return undefined
  }
  const { music } = op.tracks
  const level = music.duck ? Math.min(1, dbToGain(music.duckDb)) : ownDuckLevel(d)
  // writeNarration mutes the AI voice per mode, so duckPoints skips it, as in the render.
  writeNarration(d, op, music.duck ? placeSpans(op.clips, takeSpans) : [])
  if (level === null) return undefined
  return duckPoints(d, level) ?? undefined
}

/** The music layer's own data-va-duck level, or null. */
function ownDuckLevel(d: Doc): number | null {
  for (const n of d.root.childNodes) {
    if (!('attrs' in n)) continue
    const get = (name: string) => n.attrs.find((a) => a.name === name)?.value
    if (get('data-va-layer') !== 'music') continue
    const v = Number(get('data-va-duck') ?? NaN)
    if (v >= 0 && v <= 1) return v
  }
  return null
}
