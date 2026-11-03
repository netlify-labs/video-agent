// Captions from recorded narration (plan 2026-11-02 §6.6 "Cues" and "What is audible", bead va-2qq.3.13). The run's
// transcript words become cues of their own kind ({ narration: true, id, start, end, text, words }), grouped for
// reading: at most 42 characters on each of 2 lines, a new cue at a pause over 300 ms and after punctuation, and 1-6 s
// on screen. summary.json keeps every cue (withNarrationCues); captions.vtt captions only what's audible: the AI voice's cues go when the narration replaces it (or all
// original audio is muted), and a muted narration track has no cues. Pure, so the editor can use it too.
import type { Caption } from './contract.js'
import type { NarrationTracks } from './timeline.js'

export const CUE_LINE_CHARS = 42
export const CUE_LINES = 2
/** A silence longer than this starts a new cue. */
export const CUE_PAUSE_S = 0.3
export const CUE_MIN_S = 1
export const CUE_MAX_S = 6

export interface CueWord {
  text: string
  start: number
  end: number
}

export interface NarrationCue extends Caption {
  narration: true
  id: string
  words: CueWord[]
}

const ms3 = (n: number) => Math.round(n * 1000) / 1000

/** Greedy word wrap at `width` characters (a longer word gets a line of its own). */
export function wrapWords(words: string[], width = CUE_LINE_CHARS): string[] {
  const lines: string[] = []
  for (const w of words) {
    const last = lines.at(-1)
    if (last !== undefined && last.length + 1 + w.length <= width) lines[lines.length - 1] = `${last} ${w}`
    else lines.push(w)
  }
  return lines
}

/** FNV-1a, twice with different seeds: a short stable id without node:crypto (this runs in the browser too). */
function hashId(s: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  return `${fnv(0x811c9dc5)}${fnv(0x2f1b3a5d)}`.slice(0, 12)
}

/** A cue's stable id: the same start and text always give the same id (caption revisions key on it). */
export const cueId = (start: number, text: string) => `nc_${hashId(`${ms3(start).toFixed(3)}|${text}`)}`

const SENTENCE_END = /[.!?…]["')\]]*$/
const CLAUSE_END = /[,;:—–]["')\]]*$/

/**
 * Groups transcript words into cues. A new cue starts at a pause over CUE_PAUSE_S, when the next word would break
 * the 2 x 42 layout or CUE_MAX_S, and after a sentence's end (or a clause's, once a line is full) when the cue has
 * been up CUE_MIN_S. A cue shorter than CUE_MIN_S stays up longer, until the next cue starts.
 */
export function groupWords(input: readonly CueWord[]): NarrationCue[] {
  const words = input
    .map((w) => ({ text: w.text.trim(), start: ms3(w.start), end: ms3(Math.max(w.start, w.end)) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start)
  const groups: CueWord[][] = []
  let cur: CueWord[] = []
  for (const w of words) {
    const first = cur[0]
    const prev = cur.at(-1)
    if (first && prev) {
      const up = prev.end - first.start
      const chars = cur.map((x) => x.text).join(' ').length
      const split =
        // In whole milliseconds, so a 300 ms gap isn't "over" by a rounding error.
        Math.round((w.start - prev.end) * 1000) > CUE_PAUSE_S * 1000 ||
        Math.round((w.end - first.start) * 1000) > CUE_MAX_S * 1000 ||
        wrapWords([...cur, w].map((x) => x.text)).length > CUE_LINES ||
        (up >= CUE_MIN_S &&
          (SENTENCE_END.test(prev.text) || (CLAUSE_END.test(prev.text) && chars >= CUE_LINE_CHARS)))
      if (split) {
        groups.push(cur)
        cur = []
      }
    }
    cur.push(w)
  }
  if (cur.length) groups.push(cur)
  return groups.map((g, i) => {
    const start = g[0]?.start ?? 0
    const next = groups[i + 1]?.[0]?.start ?? Infinity
    const spoken = g.at(-1)?.end ?? start
    // At least CUE_MIN_S (never into the next cue), at most CUE_MAX_S, and always after its start.
    let end = Math.min(start + CUE_MAX_S, Math.max(spoken, Math.min(start + CUE_MIN_S, next)))
    if (!(end > start)) end = start + 0.001
    const text = wrapWords(g.map((w) => w.text)).join('\n')
    return { narration: true, id: cueId(start, text), start, end: ms3(end), text, words: g }
  })
}

/**
 * summary.json's captions with the narration's cues: every other cue kept as it is (so a later switch to keep or
 * under still has them), earlier narration cues replaced, interleaved by time (a stable sort).
 */
export function withNarrationCues(captions: readonly Caption[], cues: readonly NarrationCue[]): Caption[] {
  return [...captions.filter((c) => !c.narration), ...cues].sort((a, b) => a.start - b.start)
}

/**
 * The captions of what's audible (plan §6.6), applied when captions.vtt is written (summary.json keeps every cue): recorded narration's cues unless its track is muted, and every other
 * cue (the AI voice's, and on-screen text) only while the AI voice still plays: not with replace, not with
 * original.muteAll. Interleaved by time. Narration cues already in `captions` are replaced by `narration`.
 */
export function audibleCaptions(
  captions: readonly Caption[],
  narration: readonly NarrationCue[],
  tracks: Pick<NarrationTracks, 'narration' | 'aiVoice' | 'original'>,
): Caption[] {
  const aiAudible = !tracks.original.muteAll && tracks.aiVoice.mode !== 'replace'
  return [
    ...(aiAudible ? captions.filter((c) => !c.narration) : []),
    ...(tracks.narration.muted ? [] : narration),
  ].sort((a, b) => a.start - b.start)
}
