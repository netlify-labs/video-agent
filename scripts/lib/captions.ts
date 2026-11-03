export interface Cue {
  start: number
  end: number
  text: string
}

const ts = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`
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
      start: Math.max(0, c.start),
      end: Math.min(durationSec, c.end),
      text: c.text.replace(/-->/g, '→').trim(),
    }))
    .filter((c) => c.text && c.end > c.start)
    .sort((a, b) => a.start - b.start)
  if (!valid.length) return 'WEBVTT\n\n'
  return [
    'WEBVTT',
    '',
    ...valid.flatMap((c, i) => [String(i + 1), `${ts(c.start)} --> ${ts(c.end)}`, c.text, '']),
  ].join('\n')
}
