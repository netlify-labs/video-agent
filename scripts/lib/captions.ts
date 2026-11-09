import { CUE_ID, writeVtt } from '../../app/server/lib/vtt.js'

export interface Cue {
  start: number
  end: number
  text: string
  /** A narration cue's stable id (caption revisions key on it); other cues are numbered by position. */
  id?: string
}

/**
 * WebVTT from the agent's caption cues; invalid cues are dropped, times clamped to the video. No cues (a narrated
 * version whose transcription failed or was off) is still a valid file: "WEBVTT\n\n", which finalize accepts.
 */
export function toVtt(cues: unknown, durationSec: number): string {
  const list = Array.isArray(cues) ? cues : []
  const valid = list
    .filter(
      (c): c is Cue =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Cue).text === 'string' &&
        Number.isFinite((c as Cue).start) &&
        Number.isFinite((c as Cue).end),
    )
    .map((c) => ({
      id: typeof c.id === 'string' && CUE_ID.test(c.id) && !/^\d+$/.test(c.id) ? c.id : null,
      start: Math.max(0, c.start),
      end: Math.min(durationSec, c.end),
      text: c.text.replace(/-->/g, '→').trim(),
    }))
    .filter((c) => c.text && c.end > c.start)
    .sort((a, b) => a.start - b.start)
  return writeVtt(valid.map((c, i) => ({ ...c, id: c.id ?? String(i + 1) })))
}
