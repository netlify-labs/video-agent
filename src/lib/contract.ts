// Editing contract v1 (plan v2 §8, §14 rules 18-20): read, validate and edit a composition without running it.
// Inert parser (parse5): nothing executes; text goes in as text nodes. Shared by the browser editor and the server
// (which re-applies the same operations before rendering). Conformance is validated structurally, never assumed from
// data-va-contract.
//
// A contract-1 composition:
//   root        data-composition-id, data-va-contract="1", data-duration; colours as --va-color-<role> on #root
//   beats       direct children of the root: data-va-beat=id = data-composition-id, data-start, data-duration,
//               data-va-authored-duration, track 0, back to back from 0; one script calling vaBeat('<id>', (tl, el) => …)
//   layers      data-va-layer, track ≥ 1, spanning the whole video (backgrounds, logo bugs)
//   text        unique data-va-text ids
//   media       data-va-media=<slot>, data-va-kind image|video, src under assets/media/; video slots have an id and
//               beat-local data-start/data-duration
//   captions    summary.json captions carry beat, textId, beatStart, beatEnd (beat-relative) plus the absolute
//               start, end and text render-job reads; the patcher keeps both in step
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']
type ChildNode = DefaultTreeAdapterMap['childNode']

export const FPS = 30
export const frames = (sec: number) => Math.round(sec * FPS) / FPS

export interface Caption {
  start: number
  end: number
  text: string
  beat?: string
  textId?: string
  beatStart?: number
  beatEnd?: number
}
export interface Summary {
  title?: string
  summary?: string
  captions?: Caption[]
  [k: string]: unknown
}

export interface Beat {
  id: string
  /** A plain-words name the author gave (data-va-label), for the editor; null when there's none. */
  label: string | null
  start: number
  duration: number
  authoredDuration: number
  texts: { id: string; text: string; label: string | null }[]
  media: MediaSlot[]
}
export interface MediaSlot {
  slot: string
  label: string | null
  kind: 'image' | 'video'
  src: string
  beat: string | null
  fit: string | null
}
export interface Composition {
  duration: number
  colors: Record<string, string>
  beats: Beat[]
  layers: string[]
}

export class ContractError extends Error {
  constructor(readonly violations: string[]) {
    super(violations.join(' '))
  }
}

// ───── tree helpers ─────
const isEl = (n: Node): n is Element => 'tagName' in n
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null
function setAttr(el: Element, name: string, value: string) {
  const a = el.attrs.find((x) => x.name === name)
  if (a) a.value = value
  else el.attrs.push({ name, value })
}
const kids = (el: ParentNode) => el.childNodes.filter(isEl)
function* walk(n: ParentNode): Generator<Element> {
  for (const c of n.childNodes)
    if (isEl(c)) {
      yield c
      yield* walk(c.tagName === 'template' ? (c as unknown as { content: ParentNode }).content : c)
    }
}
function textOf(n: Node): string {
  if (n.nodeName === '#text' && 'value' in n) return n.value
  return 'childNodes' in n ? n.childNodes.map(textOf).join('') : ''
}
function setText(el: Element, text: string) {
  el.childNodes = [{ nodeName: '#text', value: text, parentNode: el } as unknown as ChildNode]
}
const num = (v: string | null) => (v === null || v.trim() === '' ? NaN : Number(v))
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6)

export interface Doc {
  doc: DefaultTreeAdapterMap['document']
  root: Element
}

/** Parses and finds the composition root (the outermost element with data-composition-id). */
export function load(html: string): Doc {
  const doc = parse(html)
  const root = [...walk(doc)].find((e) => attr(e, 'data-composition-id') !== null)
  if (!root) throw new ContractError(['No element with data-composition-id.'])
  return { doc, root }
}
export const save = (d: Doc) => serialize(d.doc)

const beatsOf = (root: Element) => kids(root).filter((e) => attr(e, 'data-va-beat') !== null)
const scriptOf = (beat: Element) => kids(beat).find((e) => e.tagName === 'script')

/** Colours declared on the root, from <style> rules like `#root { --va-color-bg: #0b0d10 }`. */
function readColors(d: Doc): { colors: Record<string, string>; styles: Element[] } {
  const colors: Record<string, string> = {}
  const styles = [...walk(d.doc)].filter((e) => e.tagName === 'style')
  for (const s of styles)
    for (const m of textOf(s).matchAll(/--va-color-([a-z0-9-]+)\s*:\s*([^;}\n]+)/gi))
      if (m[1] && m[2] && !(m[1] in colors)) colors[m[1]] = m[2].trim()
  return { colors, styles }
}

export function read(d: Doc): Composition {
  const { colors } = readColors(d)
  const beats = beatsOf(d.root).map((b): Beat => {
    const id = attr(b, 'data-va-beat') ?? ''
    const inner = [...walk(b)]
    return {
      id,
      label: labelOf(b),
      start: num(attr(b, 'data-start')),
      duration: num(attr(b, 'data-duration')),
      authoredDuration: num(attr(b, 'data-va-authored-duration') ?? attr(b, 'data-duration')),
      texts: inner
        .filter((e) => attr(e, 'data-va-text') !== null)
        .map((e) => ({ id: attr(e, 'data-va-text') ?? '', text: textOf(e).trim(), label: labelOf(e) })),
      media: inner.filter((e) => attr(e, 'data-va-media') !== null).map((e) => mediaOf(e, id)),
    }
  })
  return {
    duration: num(attr(d.root, 'data-duration')),
    colors,
    beats,
    layers: kids(d.root)
      .filter((e) => attr(e, 'data-va-layer') !== null)
      .map((e) => attr(e, 'data-va-layer') ?? ''),
  }
}

/** data-va-label, trimmed and bounded; it's display text only. */
function labelOf(e: Element): string | null {
  return attr(e, 'data-va-label')?.trim().slice(0, 80) || null
}

function mediaOf(e: Element, beat: string | null): MediaSlot {
  const style = attr(e, 'style') ?? ''
  return {
    slot: attr(e, 'data-va-media') ?? '',
    label: labelOf(e),
    kind: attr(e, 'data-va-kind') === 'video' ? 'video' : 'image',
    src: attr(e, 'src') ?? '',
    beat,
    fit: /object-fit\s*:\s*(cover|contain)/.exec(style)?.[1] ?? null,
  }
}

/** Every way the composition breaks contract v1; empty when it conforms. */
export function validate(html: string, summary?: Summary): string[] {
  const v: string[] = []
  let d: Doc
  try {
    d = load(html)
  } catch (e) {
    return e instanceof ContractError ? e.violations : ['The HTML could not be read.']
  }
  const { root } = d
  if (attr(root, 'data-va-contract') !== '1') v.push('The root needs data-va-contract="1".')
  const total = num(attr(root, 'data-duration'))
  if (!(total > 0)) v.push('The root needs a positive data-duration.')
  if (!/vendor\/va-contract\.js/.test(html)) v.push('Load vendor/va-contract.js before the beats.')

  const beats = beatsOf(root)
  if (beats.length === 0) v.push('There are no beats (direct children of the root with data-va-beat).')
  const ids = beats.map((b) => attr(b, 'data-va-beat') ?? '')
  let t = 0
  beats.forEach((b, i) => {
    const id = ids[i] ?? ''
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id))
      v.push(`Beat id "${id}" must be lowercase letters, digits and dashes.`)
    if (ids.indexOf(id) !== i) v.push(`Beat id "${id}" is used twice.`)
    if (attr(b, 'data-composition-id') !== id) v.push(`Beat "${id}" needs data-composition-id="${id}".`)
    const start = num(attr(b, 'data-start'))
    const dur = num(attr(b, 'data-duration'))
    if (!(dur > 0)) v.push(`Beat "${id}" needs a positive data-duration.`)
    if (!(num(attr(b, 'data-va-authored-duration') ?? attr(b, 'data-duration')) > 0))
      v.push(`Beat "${id}" needs data-va-authored-duration.`)
    if (Math.abs(start - t) > 0.5 / FPS)
      v.push(`Beat "${id}" should start at ${fmt(t)}s, right after the beat before it.`)
    const track = attr(b, 'data-track-index')
    if (track !== null && track !== '0') v.push(`Beat "${id}" must be on track 0.`)
    const script = scriptOf(b)
    const code = script ? textOf(script) : ''
    if (!new RegExp(`vaBeat\\(\\s*['"]${id}['"]`).test(code))
      v.push(`Beat "${id}" needs a script calling vaBeat('${id}', …).`)
    if (/\bdocument\s*\.|window\.__timelines/.test(code))
      v.push(`Beat "${id}"'s script must select inside its own element (el), not document or __timelines.`)
    for (const other of ids)
      if (other !== id && new RegExp(`['"#]${other}['"\\]]`).test(code))
        v.push(`Beat "${id}" refers to beat "${other}".`)
    t += dur
  })
  if (beats.length && Math.abs(t - total) > 0.5 / FPS)
    v.push(`The beats add up to ${fmt(t)}s but the root says ${fmt(total)}s.`)

  for (const e of kids(root)) {
    if (attr(e, 'data-va-beat') !== null || e.tagName === 'script' || e.tagName === 'style') continue
    if (attr(e, 'data-va-layer') !== null) {
      const track = num(attr(e, 'data-track-index'))
      if (!(track >= 1)) v.push(`Layer "${attr(e, 'data-va-layer') ?? ''}" must be on track 1 or higher.`)
      if (num(attr(e, 'data-start')) !== 0 || Math.abs(num(attr(e, 'data-duration')) - total) > 0.5 / FPS)
        v.push(`Layer "${attr(e, 'data-va-layer') ?? ''}" must span the whole video.`)
    } else if (attr(e, 'data-start') !== null)
      v.push(
        `<${e.tagName}${attr(e, 'id') ? ` id="${attr(e, 'id') ?? ''}"` : ''}> is timed but is neither a beat nor a layer.`,
      )
  }

  const textIds = [...walk(root)].map((e) => attr(e, 'data-va-text')).filter((x): x is string => x !== null)
  for (const [i, id] of textIds.entries())
    if (textIds.indexOf(id) !== i) v.push(`Text id "${id}" is used twice.`)

  for (const e of [...walk(root)].filter((x) => attr(x, 'data-va-media') !== null)) {
    const slot = attr(e, 'data-va-media') ?? ''
    const kind = attr(e, 'data-va-kind')
    if (kind !== 'image' && kind !== 'video')
      v.push(`Media slot "${slot}" needs data-va-kind="image" or "video".`)
    if (kind === 'video' && e.tagName !== 'video')
      v.push(`Media slot "${slot}" is a video slot on a <${e.tagName}>.`)
    if (kind === 'image' && e.tagName !== 'img')
      v.push(`Media slot "${slot}" is an image slot on a <${e.tagName}>.`)
    if (!/^assets\/media\/[^/]+$/.test(attr(e, 'src') ?? ''))
      v.push(`Media slot "${slot}" must use a file in assets/media/.`)
    if (
      kind === 'video' &&
      (!attr(e, 'id') || attr(e, 'data-start') === null || attr(e, 'data-duration') === null)
    )
      v.push(`Video slot "${slot}" needs an id, data-start and data-duration.`)
  }

  const { colors } = readColors(d)
  if (Object.keys(colors).length === 0) v.push('Declare colours as --va-color-<role> on the root.')

  if (summary?.captions) {
    const known = new Map(read(d).beats.flatMap((b) => b.texts.map((x) => [x.id, b.id] as const)))
    for (const c of summary.captions) {
      if (!c.textId || !c.beat) {
        v.push('Every caption needs beat and textId.')
        break
      }
      if (known.get(c.textId) !== c.beat)
        v.push(`Caption "${c.textId}" doesn't match a text in beat "${c.beat}".`)
    }
  }
  return [...new Set(v)]
}

// ───── edits ─────
export type EditOp =
  | { op: 'text'; id: string; text: string }
  | { op: 'retime'; beat: string; duration: number }
  | { op: 'reorder'; order: string[] }
  | { op: 'delete'; beat: string }
  | { op: 'color'; role: string; value: string }
  | { op: 'media'; slot: string; src: string; kind: 'image' | 'video'; fit: 'cover' | 'contain' }

export interface EditOptions {
  /** Colours a role may take (the brand palette). Empty: any #rgb/#rrggbb. */
  palette?: string[]
}

/** Lays the beats back to back from 0 and sets the root, layer and video-slot durations to match. */
function relayout(d: Doc) {
  let t = 0
  for (const b of beatsOf(d.root)) {
    setAttr(b, 'data-start', fmt(t))
    const dur = num(attr(b, 'data-duration'))
    for (const vid of [...walk(b)].filter((e) => attr(e, 'data-va-kind') === 'video')) {
      setAttr(vid, 'data-start', '0')
      setAttr(vid, 'data-duration', fmt(dur)) // longer clips are trimmed to the beat
    }
    t = frames(t + dur)
  }
  setAttr(d.root, 'data-duration', fmt(t))
  for (const l of kids(d.root).filter((e) => attr(e, 'data-va-layer') !== null)) {
    setAttr(l, 'data-start', '0')
    setAttr(l, 'data-duration', fmt(t))
  }
}

/** Absolute caption times and texts from the beat-relative, keyed ones. */
function syncCaptions(d: Doc, summary: Summary): Summary {
  if (!summary.captions) return summary
  const comp = read(d)
  const beats = new Map(comp.beats.map((b) => [b.id, b]))
  const texts = new Map(comp.beats.flatMap((b) => b.texts.map((x) => [x.id, x.text] as const)))
  const captions = summary.captions
    .filter((c) => !c.beat || beats.has(c.beat))
    .map((c) => {
      const b = c.beat ? beats.get(c.beat) : undefined
      if (!b || c.beatStart === undefined || c.beatEnd === undefined) return c
      const k = b.duration / b.authoredDuration // captions stretch with their beat
      return {
        ...c,
        start: frames(b.start + c.beatStart * k),
        end: frames(Math.min(b.start + b.duration, b.start + c.beatEnd * k)),
        text: (c.textId && texts.get(c.textId)) || c.text,
      }
    })
    .sort((a, b) => a.start - b.start)
  return { ...summary, captions }
}

/**
 * Applies edits in order and returns the new composition and summary. Validates before and after: a composition
 * that doesn't conform isn't edited, and an edit that would break it is refused.
 */
export function applyEdits(html: string, summary: Summary, ops: EditOp[], opts: EditOptions = {}) {
  const before = validate(html, summary)
  if (before.length) throw new ContractError(before)
  const d = load(html)
  for (const op of ops) applyOne(d, op, opts)
  relayout(d)
  const out = save(d)
  const nextSummary = syncCaptions(d, summary)
  const after = validate(out, nextSummary)
  if (after.length) throw new ContractError(after)
  return { html: out, summary: nextSummary, composition: read(load(out)) }
}

function applyOne(d: Doc, op: EditOp, opts: EditOptions) {
  const beats = beatsOf(d.root)
  const beat = (id: string) => {
    const b = beats.find((x) => attr(x, 'data-va-beat') === id)
    if (!b) throw new ContractError([`There's no beat "${id}".`])
    return b
  }
  switch (op.op) {
    case 'text': {
      const el = [...walk(d.root)].find((e) => attr(e, 'data-va-text') === op.id)
      if (!el) throw new ContractError([`There's no text "${op.id}".`])
      if (op.text.length > 500) throw new ContractError(['Keep text under 500 characters.'])
      setText(el, op.text)
      return
    }
    case 'retime': {
      const dur = frames(op.duration)
      if (!(dur >= 0.5 && dur <= 120)) throw new ContractError(['A beat lasts between 0.5 and 120 seconds.'])
      setAttr(beat(op.beat), 'data-duration', fmt(dur))
      return
    }
    case 'reorder': {
      const ids = beats.map((b) => attr(b, 'data-va-beat') ?? '')
      if (op.order.length !== ids.length || [...op.order].sort().join() !== [...ids].sort().join())
        throw new ContractError(['A reorder must list every beat once.'])
      const sorted = op.order.map(beat)
      // Put the beats back in the new order where the first beat was, keeping layers and scripts where they are.
      const first = d.root.childNodes.indexOf(beats[0] as ChildNode)
      d.root.childNodes = d.root.childNodes.filter((n) => !beats.includes(n as Element))
      d.root.childNodes.splice(first, 0, ...sorted)
      return
    }
    case 'delete': {
      if (beats.length <= 1) throw new ContractError(["The last beat can't be deleted."])
      const b = beat(op.beat)
      d.root.childNodes = d.root.childNodes.filter((n) => n !== b)
      return
    }
    case 'color': {
      const value = op.value.trim().toLowerCase()
      const palette = (opts.palette ?? []).map((c) => c.toLowerCase())
      if (palette.length ? !palette.includes(value) : !/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(value))
        throw new ContractError([`${op.value} isn't in the brand palette.`])
      const { colors, styles } = readColors(d)
      if (!(op.role in colors)) throw new ContractError([`There's no colour role "${op.role}".`])
      for (const s of styles) {
        const text = textOf(s)
        const next = text.replace(
          new RegExp(`(--va-color-${op.role}\\s*:\\s*)([^;}\\n]+)`, 'i'),
          `$1${value}`,
        )
        if (next !== text) setText(s, next)
      }
      return
    }
    case 'media': {
      const el = [...walk(d.root)].find((e) => attr(e, 'data-va-media') === op.slot)
      if (!el) throw new ContractError([`There's no media slot "${op.slot}".`])
      if (attr(el, 'data-va-kind') !== op.kind)
        throw new ContractError([
          `Slot "${op.slot}" takes ${attr(el, 'data-va-kind') ?? 'other'} media, not ${op.kind}.`,
        ])
      if (!/^assets\/media\/[A-Za-z0-9_.-]+$/.test(op.src))
        throw new ContractError(['Media comes from assets/media/.'])
      setAttr(el, 'src', op.src)
      const style = (attr(el, 'style') ?? '').replace(/object-fit\s*:\s*[a-z-]+\s*;?/gi, '').trim()
      setAttr(
        el,
        'style',
        `${style}${style && !style.endsWith(';') ? '; ' : style ? ' ' : ''}object-fit: ${op.fit}`,
      )
      if (op.kind === 'video') {
        setAttr(el, 'muted', '') // slot audio is muted
        el.attrs = el.attrs.filter((a) => a.name !== 'data-has-audio')
      }
      return
    }
  }
}
