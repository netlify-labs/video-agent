// Narration timeline model (docs/plans/2026-11-02-record-your-own-voiceover.md §5.5, §6.1, §6.3 step 3): the one
// place where clip placement, overlap resolution, joins, fades and gain are decided, so the browser preview, the
// server validator and the run's bus mixer agree to the sample. Pure and framework-free: no I/O, no DOM, no Node
// built-ins, so it runs in browser workers and in Node.
//
// Coordinates are integer samples at SAMPLE_RATE. A clip plays source samples [srcStart, srcEnd) of one take
// starting at composition sample `start`, so source sample s sounds at start + (s - srcStart). Only visuals quantize
// to frames (the frame helpers below); audio never moves to a frame boundary on its own.

/** Every narration coordinate (source and composition) is an integer sample at this rate. */
export const SAMPLE_RATE = 24_000
/** Length of a crossfade at a join between two clips: 20 ms, centred on the edit point. */
export const XFADE_SAMPLES = 480
/** Length of the declick fades used at a join when a crossfade has no handle audio: 10 ms each side. */
export const EDGE_FADE_SAMPLES = XFADE_SAMPLES / 2
/** Music stays ducked this long after speech stops, so it doesn't pump between phrases. */
export const DUCK_RELEASE_MS = 1_500
export const DUCK_RELEASE_SAMPLES = (DUCK_RELEASE_MS * SAMPLE_RATE) / 1000
/** The narration may run past the base video by at most this much (keep-visuals trims or holds the last frame). */
export const MAX_EXTENSION_SAMPLES = 120 * SAMPLE_RATE
/** No output is ever longer than 15 minutes. */
export const MAX_OUTPUT_SAMPLES = 15 * 60 * SAMPLE_RATE
/** A user fade is at most 2 s and at most half its clip. */
export const MAX_FADE_SAMPLES = 2 * SAMPLE_RATE
/** Clip gain bounds in dB; null means silent. */
export const GAIN_DB_RANGE = [-60, 12] as const
/** One narration op places at most this many clips, from at most this many distinct takes. */
export const MAX_NARRATION_CLIPS = 200
export const MAX_NARRATION_TAKES = 32

/** Recording alignment: composition seconds t = a + b·sample over the take (§5.3). Identity for uploads. */
export interface Fit {
  a: number
  b: number
  residualMs: number
}

export const IDENTITY_FIT: Fit = { a: 0, b: 1 / SAMPLE_RATE, residualMs: 0 }

/** One clip of the narration op (§6.1). `fit` and `offsetSamples` are provenance: `start` already includes them. */
export interface NarrationClip {
  /** Stable slot id; a split piece gets `${id}~n`. */
  id: string
  mediaId: string
  /** Integer samples into the source; srcEnd > srcStart. */
  srcStart: number
  srcEnd: number
  fit: Fit
  /** Calibration + manual offset, in samples. */
  offsetSamples: number
  /** Composition position of srcStart, integer samples. */
  start: number
  /** Finite, within GAIN_DB_RANGE; null = silent. */
  gainDb: number | null
  /** 0..min(len/2, MAX_FADE_SAMPLES). */
  fadeInSamples: number
  fadeOutSamples: number
}

export type AiVoiceMode = 'replace' | 'under' | 'keep'

export interface NarrationTracks {
  narration: { volumeDb: number; muted: boolean; solo: boolean }
  aiVoice: { mode: AiVoiceMode; volumeDb: number }
  music: { duck: boolean; duckDb: number }
  original: { muteAll: boolean }
}

export type NarrationCleanup = 'off' | 'light'

/** The whole-track narration edit op (§6.1). The zod schema lives with the other edit ops. */
export interface NarrationOp {
  op: 'narration'
  schema: 1
  sampleRate: typeof SAMPLE_RATE
  clips: NarrationClip[]
  tracks: NarrationTracks
  cleanup: NarrationCleanup
}

/** A half-open range [start, end) in samples. */
export type Span = [start: number, end: number]

// ---- placement

export const clipLength = (c: NarrationClip): number => c.srcEnd - c.srcStart
export const clipEnd = (c: NarrationClip): number => c.start + clipLength(c)

/** Composition sample at which source sample `sourceSample` of the clip sounds. */
export function compositionTime(c: NarrationClip, sourceSample: number): number {
  return c.start + (sourceSample - c.srcStart)
}

/** Source sample of the clip's take that sounds at composition sample `t` (may be outside [srcStart, srcEnd)). */
export function sourceSampleAt(c: NarrationClip, t: number): number {
  return c.srcStart + (t - c.start)
}

/**
 * Composition start for a recorded take placed from its sync fit: source sample srcStart sounds at
 * round((a + b·srcStart)·SAMPLE_RATE) + offsetSamples. The slope is held to 1/SAMPLE_RATE by the recorder (a take
 * stops when it drifts), so the integer model keeps one offset per clip and the fit stays as provenance.
 */
export function placeTake(fit: Fit, offsetSamples: number, srcStart = 0): number {
  return Math.round((fit.a + fit.b * srcStart) * SAMPLE_RATE) + offsetSamples
}

// ---- overlap resolution

/** The longest user fade a clip of `length` samples may have. */
export const maxFade = (length: number): number => Math.min(Math.floor(length / 2), MAX_FADE_SAMPLES)

const clampFades = (c: NarrationClip): NarrationClip => {
  const m = maxFade(clipLength(c))
  return {
    ...c,
    fadeInSamples: Math.max(0, Math.min(c.fadeInSamples, m)),
    fadeOutSamples: Math.max(0, Math.min(c.fadeOutSamples, m)),
  }
}

/** The part of clip `c` that plays in composition [from, to); a cut side loses its user fade. */
function piece(c: NarrationClip, from: number, to: number, id: string): NarrationClip {
  return clampFades({
    ...c,
    id,
    start: from,
    srcStart: sourceSampleAt(c, from),
    srcEnd: sourceSampleAt(c, to),
    fadeInSamples: from > c.start ? 0 : c.fadeInSamples,
    fadeOutSamples: to < clipEnd(c) ? 0 : c.fadeOutSamples,
  })
}

/**
 * Non-overlapping clips sorted by start. Clips are laid down in array order and a later clip wins where it overlaps
 * an earlier one: the earlier clip is trimmed or split around it, non-destructively (only srcStart, srcEnd and start
 * change, so every surviving sample keeps its composition time). The first surviving piece of a clip keeps its id; a
 * second piece gets the first free `${base}~n` (n from 2; base is the id without a `~n` suffix). Empty clips are
 * dropped. Idempotent.
 */
export function resolve(clips: readonly NarrationClip[]): NarrationClip[] {
  const used = new Set(clips.map((c) => c.id))
  const freshId = (id: string) => {
    const base = id.replace(/~\d+$/, '')
    let n = 2
    while (used.has(`${base}~${n}`)) n++
    const next = `${base}~${n}`
    used.add(next)
    return next
  }
  let out: NarrationClip[] = []
  for (const c of clips) {
    if (clipLength(c) <= 0) continue
    const cs = c.start
    const ce = clipEnd(c)
    const next: NarrationClip[] = []
    for (const r of out) {
      const rs = r.start
      const re = clipEnd(r)
      if (re <= cs || rs >= ce) {
        next.push(r)
        continue
      }
      const head = rs < cs
      if (head) next.push(piece(r, rs, cs, r.id))
      if (re > ce) next.push(piece(r, ce, re, head ? freshId(r.id) : r.id))
    }
    next.push(clampFades(c))
    out = next
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---- gain and fades

/** Linear gain for a dB value; null is silent. */
export function dbToGain(db: number | null): number {
  return db === null ? 0 : 10 ** (db / 20)
}

/** dB for a linear gain; zero (or less) is null, silent. */
export function gainToDb(gain: number): number | null {
  return gain > 0 ? 20 * Math.log10(gain) : null
}

/**
 * Fade curves are equal-power (quarter sine) everywhere, edge fades included, so one curve shapes every fade and a
 * crossfade keeps constant power: fadeIn(x)² + fadeOut(x)² = 1. `x` runs 0..1 across the fade; sample i of an
 * n-sample fade is at x = (i + 0.5) / n, so neither end is exactly 0 or 1 and both sides of a crossfade sample the
 * curve at the same points.
 */
export const fadeIn = (x: number): number => Math.sin((Math.PI / 2) * Math.min(1, Math.max(0, x)))
export const fadeOut = (x: number): number => Math.cos((Math.PI / 2) * Math.min(1, Math.max(0, x)))
const at = (i: number, n: number) => (i + 0.5) / n

/** How a clip side meets its neighbour (or silence). */
export type Join =
  /** No neighbour, or the neighbour continues the same source: play straight through (only user fades apply). */
  | { kind: 'none' }
  /** Equal-power crossfade of XFADE_SAMPLES centred on the edit point, using handle audio past the edit. */
  | { kind: 'xfade'; samples: number }
  /** Declick fade inside the clip body, ending (or starting) at the edit point. */
  | { kind: 'edge'; samples: number }

/** A resolved clip as it plays: its joins and the composition range it sounds in, handles included. */
export interface Segment {
  clip: NarrationClip
  head: Join
  tail: Join
  /** Composition range [from, to) in which this segment contributes, including crossfade handles. */
  from: number
  to: number
}

const NONE: Join = { kind: 'none' }

/**
 * How each resolved clip plays. Where clip A ends exactly where clip B starts:
 * - same take and continuous source (an untouched split): no fades, the audio plays straight through;
 * - both clips at least XFADE_SAMPLES long and both takes have XFADE_SAMPLES/2 of handle audio past the edit (after
 *   A's srcEnd, before B's srcStart): an equal-power crossfade centred on the edit;
 * - otherwise: EDGE_FADE_SAMPLES declick fades inside each body (at most half the clip).
 * A side next to silence has no join; its user fade (if any) shapes it. `takeSamples` gives each take's length.
 */
export function segments(
  clips: readonly NarrationClip[],
  takeSamples: ReadonlyMap<string, number>,
): Segment[] {
  const r = resolve(clips)
  const half = XFADE_SAMPLES / 2
  const joins = r.map(() => ({ head: NONE, tail: NONE }))
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1]
    const b = r[i]
    const ja = joins[i - 1]
    const jb = joins[i]
    if (!a || !b || !ja || !jb || clipEnd(a) !== b.start) continue
    if (a.mediaId === b.mediaId && a.srcEnd === b.srcStart) continue
    const handles =
      clipLength(a) >= XFADE_SAMPLES &&
      clipLength(b) >= XFADE_SAMPLES &&
      a.srcEnd + half <= (takeSamples.get(a.mediaId) ?? 0) &&
      b.srcStart - half >= 0
    if (handles) {
      ja.tail = { kind: 'xfade', samples: XFADE_SAMPLES }
      jb.head = { kind: 'xfade', samples: XFADE_SAMPLES }
    } else {
      ja.tail = { kind: 'edge', samples: Math.min(EDGE_FADE_SAMPLES, Math.floor(clipLength(a) / 2)) }
      jb.head = { kind: 'edge', samples: Math.min(EDGE_FADE_SAMPLES, Math.floor(clipLength(b) / 2)) }
    }
  }
  return r.map((clip, i) => {
    const { head, tail } = joins[i] ?? { head: NONE, tail: NONE }
    return {
      clip,
      head,
      tail,
      from: clip.start - (head.kind === 'xfade' ? head.samples / 2 : 0),
      to: clipEnd(clip) + (tail.kind === 'xfade' ? tail.samples / 2 : 0),
    }
  })
}

/**
 * The fade envelope (0..1, clip gain excluded) of a segment at composition sample t. User fades shape the clip body
 * [start, end); join curves multiply on top, and crossfade handles outside the body get only the join curve.
 */
export function envelope(seg: Segment, t: number): number {
  const { clip, head, tail } = seg
  if (t < seg.from || t >= seg.to) return 0
  const s = clip.start
  const e = clipEnd(clip)
  let g = 1
  if (clip.fadeInSamples > 0 && t >= s && t < s + clip.fadeInSamples)
    g *= fadeIn(at(t - s, clip.fadeInSamples))
  if (clip.fadeOutSamples > 0 && t < e && t >= e - clip.fadeOutSamples)
    g *= fadeOut(at(t - (e - clip.fadeOutSamples), clip.fadeOutSamples))
  if (head.kind === 'xfade') {
    const from = s - head.samples / 2
    if (t < from + head.samples) g *= fadeIn(at(t - from, head.samples))
  } else if (head.kind === 'edge' && head.samples > 0 && t < s + head.samples)
    g *= fadeIn(at(t - s, head.samples))
  if (tail.kind === 'xfade') {
    const from = e - tail.samples / 2
    if (t >= from) g *= fadeOut(at(t - from, tail.samples))
  } else if (tail.kind === 'edge' && tail.samples > 0 && t >= e - tail.samples)
    g *= fadeOut(at(t - (e - tail.samples), tail.samples))
  return g
}

// ---- mixing

/**
 * The narration bus: `targetSamples` of mono Float32 at SAMPLE_RATE. Each take in `takes` is that media's decoded
 * source at SAMPLE_RATE; a clip whose take is missing throws. Source samples outside a take read as silence. With
 * `tracks`, the narration track's volume and mute apply (solo is a monitor control and doesn't). No limiting or
 * clipping: the run pre-limits the bus afterwards. Deterministic: the same inputs give the same bytes.
 */
export function mixToBuffer(
  clips: readonly NarrationClip[],
  takes: ReadonlyMap<string, Float32Array>,
  targetSamples: number,
  tracks?: Pick<NarrationTracks, 'narration'>,
): Float32Array {
  const out = new Float32Array(targetSamples)
  if (tracks?.narration.muted) return out
  const trackGain = tracks ? dbToGain(tracks.narration.volumeDb) : 1
  const lengths = new Map([...takes].map(([id, pcm]) => [id, pcm.length]))
  for (const seg of segments(clips, lengths)) {
    const src = takes.get(seg.clip.mediaId)
    if (!src) throw new Error(`mixToBuffer: no audio for take ${seg.clip.mediaId}`)
    const gain = dbToGain(seg.clip.gainDb) * trackGain
    if (gain === 0) continue
    const from = Math.max(0, seg.from)
    const to = Math.min(targetSamples, seg.to)
    for (let t = from; t < to; t++) {
      const v = src[sourceSampleAt(seg.clip, t)] ?? 0
      if (v !== 0) out[t] = (out[t] ?? 0) + v * gain * envelope(seg, t)
    }
  }
  return out
}

// ---- speech spans in composition time

/** Spans sorted and merged where they overlap, touch, or are less than `gap` samples apart. */
export function mergeSpans(spans: readonly Span[], gap = 0): Span[] {
  const sorted = spans.filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: Span[] = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s - last[1] < Math.max(gap, 1)) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/**
 * Where narration speech sounds, in composition samples: each audible clip's take spans (source samples) cut to the
 * clip and moved to its position, merged where they touch. A take with no summary counts as speech for the whole
 * clip (API-only uploads until a run measures the bus). Silent clips (gainDb null) contribute nothing. Merge the
 * result with DUCK_RELEASE_SAMPLES for the duck lane.
 */
export function placeSpans(
  clips: readonly NarrationClip[],
  takeSpans: ReadonlyMap<string, readonly Span[]>,
): Span[] {
  const out: Span[] = []
  for (const c of resolve(clips)) {
    if (c.gainDb === null) continue
    for (const [s, e] of takeSpans.get(c.mediaId) ?? [[c.srcStart, c.srcEnd] as Span]) {
      const from = Math.max(s, c.srcStart)
      const to = Math.min(e, c.srcEnd)
      if (to > from) out.push([compositionTime(c, from), compositionTime(c, to)])
    }
  }
  return mergeSpans(out)
}

// ---- output-duration limit

/** End of the last resolved clip, or 0. */
export function outputEnd(clips: readonly NarrationClip[]): number {
  return clips.reduce((m, c) => (clipLength(c) > 0 ? Math.max(m, clipEnd(c)) : m), 0)
}

/** The longest output allowed for a base video of `baseSamples`: base + 120 s, never over 15 min. */
export function outputLimit(baseSamples: number): number {
  return Math.min(baseSamples + MAX_EXTENSION_SAMPLES, MAX_OUTPUT_SAMPLES)
}

/** Whether an output ending at `endSamples` (last clip end, or hold-frame end) is within the limit. */
export function withinOutputLimit(endSamples: number, baseSamples: number): boolean {
  return endSamples <= outputLimit(baseSamples)
}

// ---- time and frames (visuals only)

export const samplesToSeconds = (samples: number): number => samples / SAMPLE_RATE
export const secondsToSamples = (seconds: number): number => Math.round(seconds * SAMPLE_RATE)

/** The frame showing at composition sample `sample`. */
export function frameAt(sample: number, fps: number): number {
  return Math.floor((sample * fps) / SAMPLE_RATE)
}

/** First sample of frame `frame`. */
export function frameStart(frame: number, fps: number): number {
  return Math.round((frame * SAMPLE_RATE) / fps)
}

/** `sample` moved to the nearest frame boundary. */
export function snapToFrame(sample: number, fps: number): number {
  return frameStart(Math.round((sample * fps) / SAMPLE_RATE), fps)
}

/** `sample` moved by `frames` whole frames, keeping any sub-frame offset (a recorded take's sync is sample-exact). */
export function nudge(sample: number, frames: number, fps: number): number {
  return sample + Math.round((frames * SAMPLE_RATE) / fps)
}

/** Whole frames needed to show `samples` of audio (a frame-quantized duration, e.g. a hold-frame target). */
export function framesFor(samples: number, fps: number): number {
  return Math.ceil((samples * fps) / SAMPLE_RATE)
}
