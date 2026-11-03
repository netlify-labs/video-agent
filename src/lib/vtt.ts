// WebVTT cues with stable ids, read and written the same way by the render (scripts/lib/captions.ts), caption
// revisions (src/domain/captions.ts) and the transcript editor in the browser. Pure: no Node imports.
//
// Each cue's identifier line is its id: a narration cue's own (nc_…, src/lib/narration-captions.ts), otherwise its
// position. Cue text is escaped for WebVTT (&, <, >), so a correction can never add markup.

export interface VttCue {
  id: string
  /** Seconds. */
  start: number
  end: number
  text: string
}

/** Ids a cue may carry on its identifier line; anything else gets its position. */
export const CUE_ID = /^[A-Za-z0-9_~.-]{1,64}$/

const ts = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`
}

const parseTs = (s: string): number | null => {
  const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(s.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

export const escapeCueText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

/** A WebVTT file from cues already in order; "WEBVTT\n\n" for none (a valid empty file). */
export function writeVtt(cues: readonly VttCue[]): string {
  if (!cues.length) return 'WEBVTT\n\n'
  return [
    'WEBVTT',
    '',
    ...cues.flatMap((c) => [c.id, `${ts(c.start)} --> ${ts(c.end)}`, escapeCueText(c.text), '']),
  ].join('\n')
}

/** The cues of a WebVTT file, text unescaped; a cue without an identifier gets its position. Bad blocks are skipped. */
export function parseVtt(text: string): VttCue[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  const cues: VttCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim())
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0 || at > 1) continue
    const [a, b] = (lines[at] ?? '').split('-->')
    const start = parseTs(a ?? '')
    const end = parseTs((b ?? '').trim().split(/\s+/)[0] ?? '')
    if (start === null || end === null) continue
    const id = at === 1 ? (lines[0] ?? '').trim() : ''
    cues.push({
      id: id || String(cues.length + 1),
      start,
      end,
      text: unescape(
        lines
          .slice(at + 1)
          .join('\n')
          .replace(/\n+$/, ''),
      ),
    })
  }
  return cues
}
