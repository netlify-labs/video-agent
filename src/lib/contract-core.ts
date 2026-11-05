// The frame math of editing contract v1, on numbers and the Composition model rather than markup, so every engine and
// every path that re-lays a composition agrees (roadmap shared rule 5; redo a scene §4.5; render engines §4.1).
// contract.ts applies these to the HyperFrames markup; a props-based contract can apply them to its own data.
import type { Caption, Composition, Summary } from './contract.js'

export const FPS = 30
/** Seconds snapped to whole frames. */
export const frames = (s: number) => Math.round(s * FPS) / FPS
/** Seconds to the microsecond, as the markup stores them. */
export const sec = (n: number) => Math.round(n * 1e6) / 1e6
export const fmt = (n: number) => String(sec(n))
/** How far a start or an end may be from where it should be: half a frame. */
export const FRAME_SLACK = 0.5 / FPS

export interface BeatSpan {
  start: number
  duration: number
}

/**
 * Beats back to back from 0 in whole frames. Each end is the running, unsnapped sum snapped, so a beat that isn't
 * frame-aligned (3.85 s = 115.5 frames) pushes its rounding into the next beat instead of adding a frame per beat.
 * What the editor, narration and re-voice paths do (contract.ts relayout).
 */
export function layoutBeats(durations: readonly number[]): { beats: BeatSpan[]; total: number } {
  let t = 0
  let end = 0
  const beats = durations.map((d) => {
    end += d
    const span = { start: t, duration: frames(end) - t }
    t = frames(end)
    return span
  })
  return { beats, total: t }
}

/**
 * Beats back to back for a scoped revision (redo a scene, plan §4.5): frozen beats keep their duration exactly as the
 * parent wrote it (an authored parent was never relaid, so 3.85 s stays 3.85 s); scoped ones must already be whole
 * frames. Each start is the plain sum of the durations before it, which is what validate expects. Throws, naming the
 * beat, for a scoped duration that isn't whole frames or any duration that isn't positive.
 */
export function layoutScoped(beats: readonly { id: string; duration: number; scoped: boolean }[]): {
  beats: BeatSpan[]
  total: number
} {
  let t = 0
  const spans = beats.map((b) => {
    if (!(b.duration > 0)) throw new Error(`Beat "${b.id}" needs a positive duration.`)
    if (b.scoped && Math.abs(frames(b.duration) - b.duration) > 1e-6)
      throw new Error(`Beat "${b.id}" must last whole frames (${fmt(b.duration)}s isn't).`)
    const span = { start: t, duration: b.duration }
    t += b.duration
    return span
  })
  return { beats: spans, total: t }
}

/** Whether a voice-over clip (beat-relative start and length) ends inside its beat, give or take half a frame. */
export const voiceFits = (beatDuration: number, start: number, duration: number) =>
  start + duration <= beatDuration + FRAME_SLACK

/**
 * Absolute caption times and texts from the beat-relative, keyed ones. Text captions stretch with their beat (its
 * duration over its authored duration); voice ones follow the audio, which keeps its speed. Captions of beats that no
 * longer exist are dropped; ones with no beat (recorded narration) are kept as they are.
 */
export function syncCaptionsFor(c: Composition, summary: Summary): Summary {
  if (!summary.captions) return summary
  const beats = new Map(c.beats.map((b) => [b.id, b]))
  const texts = new Map(c.beats.flatMap((b) => b.texts.map((x) => [x.id, x.text] as const)))
  const captions = summary.captions
    .filter((x) => !x.beat || beats.has(x.beat))
    .map((x) => {
      const b = x.beat ? beats.get(x.beat) : undefined
      if (!b || x.beatStart === undefined || x.beatEnd === undefined) return x
      const k = x.voice ? 1 : b.duration / b.authoredDuration
      return {
        ...x,
        start: frames(b.start + x.beatStart * k),
        end: frames(Math.min(b.start + b.duration, b.start + x.beatEnd * k)),
        text: (x.textId && texts.get(x.textId)) || x.text,
      }
    })
    .sort((a, b) => a.start - b.start)
  return { ...summary, captions }
}

/**
 * Moves cues by a beat's start delta without re-rounding them, so a frozen beat that didn't move keeps its cue times
 * exactly (syncCaptionsFor snaps every cue, which could move a frozen one by a frame).
 */
export function shiftCues(cues: readonly Caption[], delta: number): Caption[] {
  if (delta === 0) return cues.map((c) => ({ ...c }))
  return cues.map((c) => ({ ...c, start: sec(c.start + delta), end: sec(c.end + delta) }))
}
