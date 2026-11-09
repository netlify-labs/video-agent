// The monitor mix's stems and their scheduling math (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, §2.2
// step 2). Pure: the stem monitor (stem-monitor.ts) owns the Web Audio nodes and asks this what to play, where to
// start it for a picture plan, and how its gain moves.
//
// - Stems are the composition's own <audio> elements (music, AI voice, effects), levelled by the render's rules:
//   writeNarration with the take's tracks mutes the AI voice in replace mode, lowers it in under mode and leaves it in
//   keep mode, and original.muteAll mutes the rest. A track the person muted stays out. The draft has no narration
//   bus file, so the narration layer is never a stem: existing narration plays from its clips (stem-monitor.ts).
// - Music is pre-ducked (owner decision 14): its volume lane is preview-mix's musicLane, computed from narration that
//   already exists (the op's clips over each take's speech summary, plus the AI voices still audible). The take being
//   recorded never feeds it, so the music never pumps while the person speaks.
// - Times are composition seconds. A MonitorPlan (monitor-schedule.ts) says context time `when` is heard with
//   composition `offset` on screen, so composition t plays at when + (t − offset).
import { load, read, writeNarration, type AudioRole, type Doc } from '../../../../server/lib/contract'
import {
  SAMPLE_RATE,
  dbToGain,
  type AiVoiceMode,
  type NarrationOp,
  type NarrationTracks,
  type Span,
} from '../../../../server/lib/timeline'
import { DEFAULT_TRACKS } from '../../lib/narration-panel'
import { musicLane, type LanePoint } from '../../lib/preview-mix'
import type { MonitorPlan } from '../clock/monitor-schedule'

/** Where the monitor is heard (§2.1 Output setup): fixed for the whole take. */
export type OutputMode = 'headphones' | 'speakers'

/** Speakers mode's default monitor level: ducked to −30 dB (null in the setup mutes it instead). */
export const SPEAKERS_LEVEL_DB = -30

/** The take's choice of what happens to the AI voice (the setup panel's Original audio), over the op's tracks. */
export interface MonitorAudio {
  aiVoice: { mode: AiVoiceMode; volumeDb: number }
  /** Mute all original audio: no music, AI voice or effects in the monitor. */
  muteAll?: boolean
}

/** One composition <audio> the monitor plays. */
export interface MonitorStem {
  id: string
  role: Exclude<AudioRole, 'narration'>
  src: string
  beat: string | null
  /** Composition seconds the element starts at (a beat's audio: the beat's start plus its beat-local data-start). */
  start: number
  /** Seconds it plays for (data-duration; Infinity when it has none: the file's length). */
  duration: number
  /** Its level (data-volume after the take's tracks are written in, 0-4). */
  gain: number
  fadeIn: number
  fadeOut: number
  /** Volume points, t seconds from the element's start; null for none. */
  lane: LanePoint[] | null
}

/** The tracks the monitor plays for a take: the op's (or the defaults with no op yet), with the take's AI voice. */
export function monitorTracks(op: NarrationOp | null, audio?: MonitorAudio): NarrationTracks {
  const base: NarrationTracks = op?.tracks ?? structuredClone(DEFAULT_TRACKS)
  if (!audio) return base
  return {
    ...base,
    aiVoice: { ...audio.aiVoice },
    original: { muteAll: audio.muteAll ?? base.original.muteAll },
  }
}

/** The op the monitor levels the composition with: the existing clips under the take's tracks. */
export function monitorOp(op: NarrationOp | null, audio?: MonitorAudio): NarrationOp {
  return {
    op: 'narration',
    schema: 1,
    sampleRate: SAMPLE_RATE,
    clips: op?.clips ?? [],
    tracks: monitorTracks(op, audio),
    cleanup: op?.cleanup ?? 'off',
  }
}

// ---- reading the stems

interface El {
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: El[]
  content?: El
}
const get = (e: El, name: string) => e.attrs?.find((a) => a.name === name)?.value ?? null
const num = (v: string | null, d: number) => {
  const n = v === null || v.trim() === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : d
}
function* audios(e: El): Generator<El> {
  for (const c of e.childNodes ?? []) {
    if (c.tagName === 'audio') yield c
    yield* audios(c.tagName === 'template' && c.content ? c.content : c)
  }
}

function ownLane(e: El): LanePoint[] | null {
  try {
    const a = JSON.parse(get(e, 'data-automation') ?? '') as {
      lanes?: { target?: string; points?: LanePoint[] }[]
    }
    const p = a.lanes?.find((l) => l.target === 'volume')?.points
    return Array.isArray(p) && p.length ? p : null
  } catch {
    return null
  }
}

/**
 * The stems for a take. `html` is the draft's composition (index.html), `op` the existing narration (null before the
 * first take), `audio` the take's Original audio choice, `takeSpans` each take's speech summary in source samples
 * (the music's dip; a take without one counts as speech throughout). Unparseable html gives no stems.
 */
export function monitorStems(
  html: string,
  op: NarrationOp | null,
  audio?: MonitorAudio,
  takeSpans: ReadonlyMap<string, readonly Span[]> = new Map(),
): MonitorStem[] {
  const mop = monitorOp(op, audio)
  let d: Doc
  try {
    d = load(html)
  } catch {
    return []
  }
  // The render's levels for these tracks; duckPoints is musicLane's own (on its own copy of the document).
  writeNarration(d, mop)
  const comp = read(d)
  const tracks = new Map(comp.audio.map((a) => [a.id, a]))
  const beats = new Map(comp.beats.map((b) => [b.id, b]))
  const silenced = mop.tracks.narration.solo
  const lane = musicLane(html, mop, takeSpans)
  const out: MonitorStem[] = []
  for (const top of (d.root as unknown as El).childNodes ?? []) {
    const beatId = get(top, 'data-va-beat')
    const beatStart = beatId === null ? 0 : (beats.get(beatId)?.start ?? 0)
    for (const e of top.tagName === 'audio' ? [top] : audios(top)) {
      const t = tracks.get(get(e, 'id') ?? '')
      if (!t || t.muted || t.role === 'narration' || silenced) continue
      const gain = Math.max(0, t.volume)
      if (gain === 0) continue
      out.push({
        id: t.id,
        role: t.role,
        src: t.src,
        beat: t.beat,
        start: beatStart + num(get(e, 'data-start'), 0),
        duration: num(get(e, 'data-duration'), Infinity),
        gain,
        fadeIn: Math.max(0, num(get(e, 'data-fade-in'), 0)),
        fadeOut: Math.max(0, num(get(e, 'data-fade-out'), 0)),
        lane: t.role === 'music' && lane !== undefined ? lane : ownLane(e),
      })
    }
  }
  return out
}

// ---- levels over time

/** A lane's value `t` seconds into its element: linear between points, held before the first and after the last. */
export function laneAt(lane: readonly LanePoint[] | null, t: number): number {
  if (!lane?.length) return 1
  const first = lane[0]
  if (!first || t <= first.t) return first?.v ?? 1
  for (let i = 1; i < lane.length; i++) {
    const a = lane[i - 1]
    const b = lane[i]
    if (!a || !b || t > b.t) continue
    return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
  }
  return lane[lane.length - 1]?.v ?? 1
}

/** The stem's gain at composition second `t`: its level × its lane × its fades (linear, as HyperFrames'). */
export function stemGainAt(stem: MonitorStem, t: number): number {
  const into = t - stem.start
  const left = stem.start + stem.duration - t
  if (into < 0 || left <= 0) return 0
  let g = stem.gain * laneAt(stem.lane, into)
  if (stem.fadeIn > 0 && into < stem.fadeIn) g *= into / stem.fadeIn
  if (Number.isFinite(left) && stem.fadeOut > 0 && left < stem.fadeOut) g *= left / stem.fadeOut
  return g
}

/** A stem's AudioBufferSourceNode start for a plan: start(when, offset, duration), duration null for to-the-end. */
export interface StemStart {
  id: string
  when: number
  offset: number
  duration: number | null
}

/**
 * Where to start a stem for `plan`: one that begins after the plan's offset starts later by the difference, one that
 * is already playing starts at `when` that far in, one that has ended isn't started (null).
 */
export function stemStart(stem: MonitorStem, plan: MonitorPlan): StemStart | null {
  const end = stem.start + stem.duration
  if (end <= plan.offset) return null
  const fin = Number.isFinite(end)
  if (stem.start >= plan.offset)
    return {
      id: stem.id,
      when: plan.when + (stem.start - plan.offset),
      offset: 0,
      duration: fin ? stem.duration : null,
    }
  return {
    id: stem.id,
    when: plan.when,
    offset: plan.offset - stem.start,
    duration: fin ? end - plan.offset : null,
  }
}

/** One AudioParam event: setValueAtTime ('set') or linearRampToValueAtTime ('ramp') of `value` at context `at`. */
export interface GainEvent {
  kind: 'set' | 'ramp'
  at: number
  value: number
}

/**
 * The stem's gain automation for a plan: its level where it starts, then a linear ramp to every breakpoint after that
 * (lane points and fade edges), in context time. Between breakpoints stemGainAt is linear, so the ramps are exact.
 */
export function stemGainEvents(stem: MonitorStem, plan: MonitorPlan): GainEvent[] {
  const s = stemStart(stem, plan)
  if (!s) return []
  const ctx = (t: number) => plan.when + (t - plan.offset)
  const from = Math.max(stem.start, plan.offset)
  const end = stem.start + stem.duration
  const marks = new Set<number>()
  for (const p of stem.lane ?? []) marks.add(stem.start + p.t)
  if (stem.fadeIn > 0) marks.add(stem.start + stem.fadeIn)
  if (stem.fadeOut > 0 && Number.isFinite(end)) {
    marks.add(end - stem.fadeOut)
    marks.add(end)
  }
  const at = [...marks].filter((t) => t > from && t <= end).sort((a, b) => a - b)
  // A fade-in starts at 0; the first ramp brings it up.
  const startValue = from === stem.start && stem.fadeIn > 0 ? 0 : stemGainAt(stem, from)
  return [
    { kind: 'set', at: s.when, value: startValue },
    ...at.map((t) => ({
      kind: 'ramp' as const,
      at: ctx(t),
      value: t >= end ? 0 : stemGainAt(stem, t),
    })),
  ]
}

// ---- the armed punch range

/** Edge ramps when the monitor mutes (and unmutes) existing narration at a punch range: 5 ms, no click. */
export const ARM_RAMP_SEC = 0.005

/**
 * Automation that mutes existing narration inside an armed punch range `[from, to)` (composition samples; `to` may
 * be Infinity for "from the punch point until stop") for a plan, from context time `now` on: full level now, down
 * to 0 over ARM_RAMP_SEC ending at the punch point, back up over ARM_RAMP_SEC from its end. Inside the range already:
 * 0 from now. No range: full level.
 */
export function armedRangeEvents(range: Span | null, plan: MonitorPlan, now: number): GainEvent[] {
  if (!range) return [{ kind: 'set', at: now, value: 1 }]
  const ctx = (sample: number) => plan.when + (sample / SAMPLE_RATE - plan.offset)
  const a = ctx(range[0])
  const b = Number.isFinite(range[1]) ? ctx(range[1]) : Infinity
  if (b <= now) return [{ kind: 'set', at: now, value: 1 }]
  const out: GainEvent[] = []
  if (a - ARM_RAMP_SEC > now)
    out.push({ kind: 'set', at: now, value: 1 }, { kind: 'set', at: a - ARM_RAMP_SEC, value: 1 })
  else out.push({ kind: 'set', at: now, value: a > now ? 1 : 0 })
  out.push({ kind: 'ramp', at: Math.max(now, a), value: 0 })
  if (Number.isFinite(b))
    out.push({ kind: 'set', at: b, value: 0 }, { kind: 'ramp', at: b + ARM_RAMP_SEC, value: 1 })
  return out
}

/** The monitor's master level: full on headphones; on speakers ducked to `speakersLevelDb`, or muted when null. */
export function monitorLevel(output: OutputMode, speakersLevelDb: number | null = SPEAKERS_LEVEL_DB): number {
  return output === 'headphones' ? 1 : dbToGain(speakersLevelDb)
}

/** The existing narration's track level: the op's narration volume, 0 when the track is muted. */
export function narrationLevel(tracks: NarrationTracks): number {
  return tracks.narration.muted ? 0 : dbToGain(tracks.narration.volumeDb)
}
