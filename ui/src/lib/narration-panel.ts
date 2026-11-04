// The editor's Narration section as data (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3-§2.5, §6.1): the
// narration op in the draft's op list (one whole-track snapshot, saved with the other ops), a new clip for a take,
// the lanes the timeline shows, and the render dialog's duration and overflow preview. Pure: no React, no fetch.
import { load, read, type VoiceClip } from '../../../src/lib/contract'
import {
  audibleEnd,
  clipEnd,
  fitTarget,
  holdFrameEnd,
  IDENTITY_FIT,
  outputLimit,
  resolve,
  withinOutputLimit,
  type NarrationClip,
  type NarrationOp,
  type NarrationTracks,
} from '../../../src/lib/timeline'
import type { TimelineComposition } from '../components/timeline'

/**
 * A new track's settings (§2.1): your voice at 0 dB, the AI voice replaced (kept at −12 dB for Under), the music
 * ducked 12 dB under speech, Light cleanup.
 */
export const DEFAULT_TRACKS: NarrationTracks = {
  narration: { volumeDb: 0, muted: false, solo: false },
  aiVoice: { mode: 'replace', volumeDb: -12 },
  music: { duck: true, duckDb: -12 },
  original: { muteAll: false },
}

export const emptyNarration = (): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: 24_000,
  clips: [],
  tracks: structuredClone(DEFAULT_TRACKS),
  cleanup: 'light',
})

/** JSON with object keys sorted, so two op lists compare equal however their keys were ordered (jsonb reorders). */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  )
}

/** Whether two op lists say the same thing (the draft is saved when they don't). */
export const sameOps = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  stableJson(a) === stableJson(b)

/** The draft's narration op, or null. */
export function narrationOf(ops: readonly { op: string }[]): NarrationOp | null {
  return (ops.find((o) => o.op === 'narration') as NarrationOp | undefined) ?? null
}

/** A track nobody has touched: no clips and the default settings. It isn't saved (a draft without one is the same). */
export const isEmptyNarration = (op: NarrationOp): boolean =>
  !op.clips.length && op.cleanup === 'light' && stableJson(op.tracks) === stableJson(DEFAULT_TRACKS)

/** The op to save for what the panel shows: null when it's empty. */
export const narrationToSave = (op: NarrationOp | null): NarrationOp | null =>
  op && !isEmptyNarration(op) ? op : null

/** `ops` without any narration op, then `narration` (when there is one) last: the op list a save sends. */
export function withNarration<T extends { op: string }>(
  ops: readonly T[],
  narration: NarrationOp | null,
): (T | NarrationOp)[] {
  const rest: (T | NarrationOp)[] = ops.filter((o) => o.op !== 'narration')
  return narration ? [...rest, narration] : rest
}

/** A clip id not used in `op`: nar_1, nar_2, … (a split piece of one gets nar_n~2). */
export function freshClipId(op: NarrationOp, taken: ReadonlySet<string> = new Set()): string {
  const used = new Set([...op.clips.map((c) => c.id.replace(/~\d+$/, '')), ...taken])
  let n = 1
  while (used.has(`nar_${n}`)) n++
  return `nar_${n}`
}

/** A whole take as a clip at `start`: an upload or a library pick has no sync fit, so its position is `start`. */
export function takeClip(id: string, mediaId: string, samples: number, start: number): NarrationClip {
  return {
    id,
    mediaId,
    srcStart: 0,
    srcEnd: Math.max(1, Math.floor(samples)),
    fit: IDENTITY_FIT,
    offsetSamples: 0,
    start: Math.max(0, Math.round(start)),
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
  }
}

// ---- lanes

/** Each voiced beat's AI voice clip, read from the draft's composition; empty when it can't be read. */
export function voicesFromHtml(html: string | null): Map<string, VoiceClip> {
  if (!html) return new Map()
  try {
    return new Map(read(load(html)).beats.flatMap((b) => (b.voice ? [[b.id, b.voice] as const] : [])))
  } catch {
    return new Map()
  }
}

/** The parts of the editor's composition (the Edit DTO, edited live) the timeline needs. */
export interface EditorComposition {
  beats: readonly { id: string; label: string | null; duration: number }[]
  audio: TimelineComposition['audio']
}

/**
 * The timeline's lanes for the composition being edited: the beats back to back in their current order and length
 * (so a retime shows before it saves), with the AI voice clips the draft's composition has, and its audio layers.
 */
export function timelineComposition(
  c: EditorComposition,
  voices: ReadonlyMap<string, VoiceClip>,
): TimelineComposition {
  let at = 0
  const beats = c.beats.map((b) => {
    const beat = {
      id: b.id,
      label: b.label,
      start: at,
      duration: b.duration,
      voice: voices.get(b.id) ?? null,
    }
    at += b.duration
    return beat
  })
  return { duration: at, beats, audio: c.audio }
}

// ---- the render dialog's preview

export interface RenderPreview {
  /** Where the narration is first and last heard, in composition samples (0, 0 without audible clips). */
  start: number
  end: number
  /** The visuals' length. */
  video: number
  /** How far the narration runs past the visuals (0 when it doesn't). */
  overflow: number
  /** The output's length if the last frame is held, and whether that's within the limit. */
  holdEnd: number
  holdAllowed: boolean
  /** The longest output allowed (the video + 120 s, never over 15 min). */
  limit: number
  /** The last clip still heard past the end, for Trim to jump to. */
  overflowClipId: string | null
  /**
   * A fit's length (§2.5, §6.4): the last word plus 0.5 s in whole frames, shorter or longer than the video, and
   * whether it's within the limit and anything is heard at all.
   */
  fitEnd: number
  fitAllowed: boolean
}

/** Where the narration sits against a video of `video` samples, and what holding its last frame would make (§2.5). */
export function renderPreview(op: NarrationOp, video: number, fps: number): RenderPreview {
  const audible = resolve(op.clips).filter((c) => c.gainDb !== null)
  const end = audibleEnd(audible)
  const holdEnd = holdFrameEnd(audible, video, fps)
  const over = audible.filter((c) => clipEnd(c) > video)
  return {
    start: audible[0]?.start ?? 0,
    end,
    video,
    overflow: Math.max(0, end - video),
    holdEnd,
    holdAllowed: withinOutputLimit(holdEnd, video),
    limit: outputLimit(video),
    overflowClipId: over[over.length - 1]?.id ?? null,
    fitEnd: fitTarget(audible, fps),
    fitAllowed: end > 0 && withinOutputLimit(fitTarget(audible, fps), video),
  }
}
