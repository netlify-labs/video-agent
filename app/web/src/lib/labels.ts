// Plain-words names for the editor (plan v2 §8). Compositions may label beats, text and media slots with
// data-va-label; older ones only have ids like "problem-cmd-1", which read as "Command 1" inside the Problem beat.
const WORDS: Record<string, string> = {
  api: 'API',
  bg: 'background',
  btn: 'button',
  cmd: 'command',
  cta: 'call to action',
  desc: 'description',
  fg: 'foreground',
  id: 'ID',
  img: 'image',
  msg: 'message',
  nav: 'navigation',
  num: 'number',
  pr: 'PR',
  sub: 'subtitle',
  ui: 'UI',
  url: 'URL',
}

/** "problem-cmd-1" in beat "problem" → "Command 1"; "brand-bg" → "Brand background". */
export function humanize(id: string, beat?: string): string {
  const own = beat && id.startsWith(`${beat}-`) ? id.slice(beat.length + 1) : id
  const words = (own || id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase())
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The author's label when there is one, else the id in plain words. */
export const labelFor = (label: string | null | undefined, id: string, beat?: string) =>
  label?.trim() || humanize(id, beat)
