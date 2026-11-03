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
//   voice       at most one <audio data-va-voice=<beat id>> per beat, a direct child of it: an id, src under
//               assets/voice/, beat-local data-start/data-duration that end inside the beat (docs/spikes.md S9)
//   ducking     a layer with data-va-duck=<level> (the music) carries a volume lane that dips under every voice;
//               the patcher rewrites it after retimes and reorders
//   audio       <audio id> elements with src under assets/ and data-volume 0-4 (HyperFrames gain, up to +12 dB, which
//               loudness normalization can set): music is the root layer
//               data-va-layer="music"; voice (data-va-audio="voice") and effects live inside beats. A muted track
//               keeps data-volume="0" (HyperFrames' silence; the render mixes every timed <audio>, muted or not) and
//               its level in data-va-volume
//   narration   each voiced beat's line lives in assets/voice/script.json (the server passes it in); a voice op
//               records a new line and marks the clip data-va-revoice, and the render run re-speaks exactly the
//               marked clips (scripts/voice.ts revoice), lengthening a beat only when its new line no longer fits
//   captions    summary.json captions carry beat, textId, beatStart, beatEnd (beat-relative) plus the absolute
//               start, end and text render-job reads; the patcher keeps both in step. Voice cues (voice: true) follow
//               the spoken words instead of a text, and keep their times when a beat is stretched (audio isn't)
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
  /** A narration cue: it follows the beat's voice-over, not an on-screen text. */
  voice?: boolean
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
  /** The beat's voice-over clip, timed in the beat's clock; null when it has none. */
  voice: VoiceClip | null
}
export interface VoiceClip {
  id: string
  src: string
  start: number
  duration: number
}
export interface MediaSlot {
  slot: string
  label: string | null
  kind: 'image' | 'video'
  src: string
  beat: string | null
  fit: string | null
}
export type AudioRole = 'music' | 'voice' | 'sfx'
export interface AudioTrack {
  id: string
  role: AudioRole
  label: string | null
  src: string
  /** The level the person set, 0-1, kept while muted. */
  volume: number
  muted: boolean
  /** The beat it plays in; null for the music layer. */
  beat: string | null
}
/** A voiced beat's narration line, for the editor. */
export interface NarrationLine {
  beat: string
  text: string
  /** The line changed since it was spoken: the render re-voices it, and the preview still plays the old audio. */
  revoice: boolean
}
export interface Composition {
  duration: number
  colors: Record<string, string>
  beats: Beat[]
  layers: string[]
  audio: AudioTrack[]
  /** Voiced beats whose line is known (from the voice script), in beat order. */
  narration: NarrationLine[]
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

/** The longest narration line (scripts/voice.ts refuses longer ones too). */
export const MAX_NARRATION = 600
const REVOICE = 'data-va-revoice'
/** Narration as voice.ts speaks it: one line, single spaces. */
export const normalizeLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Beats whose voice is marked for re-voicing, in beat order. */
export function markedForRevoice(d: Doc): string[] {
  return beatsOf(d.root)
    .filter((b) => voicesOf(b).some((e) => attr(e, REVOICE) !== null))
    .map((b) => attr(b, 'data-va-beat') ?? '')
}

/** `lines` is each voiced beat's current narration (from the voice script); without it, narration is empty. */
export function read(d: Doc, lines?: Record<string, string>): Composition {
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
      voice: voiceOf(b),
    }
  })
  return {
    duration: num(attr(d.root, 'data-duration')),
    colors,
    beats,
    layers: kids(d.root)
      .filter((e) => attr(e, 'data-va-layer') !== null)
      .map((e) => attr(e, 'data-va-layer') ?? ''),
    audio: audioOf(d.root),
    narration: lines ? narrationOf(d, beats, lines) : [],
  }
}

function narrationOf(d: Doc, beats: Beat[], lines: Record<string, string>): NarrationLine[] {
  const marked = new Set(markedForRevoice(d))
  return beats.flatMap((b) => {
    const text = Object.hasOwn(lines, b.id) ? lines[b.id] : undefined
    return b.voice && text !== undefined ? [{ beat: b.id, text, revoice: marked.has(b.id) }] : []
  })
}

const voicesOf = (beat: Element) => kids(beat).filter((e) => attr(e, 'data-va-voice') !== null)

function voiceOf(beat: Element): VoiceClip | null {
  const e = voicesOf(beat)[0]
  if (!e) return null
  return {
    id: attr(e, 'id') ?? '',
    src: attr(e, 'src') ?? '',
    start: num(attr(e, 'data-start')),
    duration: num(attr(e, 'data-duration')),
  }
}

const AUDIO_ROLES: readonly string[] = ['music', 'voice', 'sfx']
/** HyperFrames' data-volume is a gain up to about +12 dB; loudness normalization sets values above 1. */
export const MAX_VOLUME = 4
/** A file the composition carries (library media, the brand's music, effects): under assets/, no way out. */
const AUDIO_SRC = /^assets(?:\/[^/\\.?#:][^/\\?#:]*)+$/

/** Every <audio id> in the composition: HyperFrames leaves out audio without an id, so the editor does too. */
function audioOf(root: Element): AudioTrack[] {
  return kids(root).flatMap((top) => {
    const beat = attr(top, 'data-va-beat')
    return [top, ...walk(top)]
      .filter((e) => e.tagName === 'audio' && attr(e, 'id'))
      .map((e): AudioTrack => {
        // Voice-over clips are marked data-va-voice (scripts/voice.ts); an explicit data-va-audio wins.
        const role =
          attr(e, 'data-va-audio') ??
          (attr(e, 'data-va-voice') !== null
            ? 'voice'
            : attr(e, 'data-va-layer') === 'music'
              ? 'music'
              : 'sfx')
        const muted = attr(e, 'data-va-muted') !== null
        const level = num(muted ? attr(e, 'data-va-volume') : attr(e, 'data-volume'))
        return {
          id: attr(e, 'id') ?? '',
          role: AUDIO_ROLES.includes(role) ? (role as AudioRole) : 'sfx',
          label: labelOf(e),
          src: attr(e, 'src') ?? '',
          volume: Number.isFinite(level) ? level : 1,
          muted,
          beat,
        }
      })
  })
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

  for (const e of [...walk(root)].filter((x) => attr(x, 'data-va-voice') !== null)) {
    const id = attr(e, 'data-va-voice') ?? ''
    const parent = e.parentNode as Element | null
    if (!parent || attr(parent, 'data-va-beat') !== id || !beats.includes(parent)) {
      v.push(`Voice "${id}" must be a direct child of beat "${id}".`)
      continue
    }
    if (e.tagName !== 'audio') v.push(`Voice "${id}" must be an <audio>.`)
    if (!attr(e, 'id')) v.push(`Voice "${id}" needs an id (audio without one is left out of the mix).`)
    if (!/^assets\/voice\/[A-Za-z0-9_.-]+$/.test(attr(e, 'src') ?? ''))
      v.push(`Voice "${id}" must use a file in assets/voice/.`)
    const start = num(attr(e, 'data-start'))
    const dur = num(attr(e, 'data-duration'))
    if (!(start >= 0) || !(dur > 0)) v.push(`Voice "${id}" needs data-start and a positive data-duration.`)
    else {
      const beatDur = num(attr(parent, 'data-duration'))
      if (start + dur > beatDur + 0.5 / FPS)
        v.push(
          `Beat "${id}" is ${fmt(beatDur)}s but its voice-over runs to ${fmt(start + dur)}s; make the beat longer.`,
        )
    }
  }
  for (const e of [...walk(root)].filter(
    (x) => attr(x, REVOICE) !== null && attr(x, 'data-va-voice') === null,
  ))
    v.push(
      `<${e.tagName}${attr(e, 'id') ? ` id="${attr(e, 'id') ?? ''}"` : ''}> has ${REVOICE}, which only goes on a voice.`,
    )
  for (const b of beats)
    if (voicesOf(b).length > 1) v.push(`Beat "${attr(b, 'data-va-beat') ?? ''}" has more than one voice.`)

  for (const l of kids(root).filter((e) => attr(e, 'data-va-duck') !== null)) {
    const want = duckPoints(d, num(attr(l, 'data-va-duck')))
    if (!want) v.push(`data-va-duck on "${attr(l, 'data-va-layer') ?? ''}" must be a level between 0 and 1.`)
    else if (!sameLane(volumeLane(attr(l, 'data-automation')), want))
      v.push(
        `The music's ducking doesn't match the voice-over; run npx tsx scripts/voice.ts sync (it rewrites the volume lane).`,
      )
  }
  const audioIds: string[] = []
  for (const e of [...walk(root)].filter((x) => x.tagName === 'audio')) {
    const id = attr(e, 'id') ?? ''
    const name = id ? `Audio "${id}"` : 'An <audio>'
    if (id && audioIds.includes(id)) v.push(`Audio id "${id}" is used twice.`)
    audioIds.push(id)
    if (!AUDIO_SRC.test(attr(e, 'src') ?? '')) v.push(`${name} must use a file in assets/.`)
    for (const a of ['data-volume', 'data-va-volume']) {
      const level = num(attr(e, a))
      if (attr(e, a) !== null && !(level >= 0 && level <= MAX_VOLUME))
        v.push(`${name} needs ${a} between 0 and ${MAX_VOLUME}.`)
    }
    const role = attr(e, 'data-va-audio')
    if (role !== null && !AUDIO_ROLES.includes(role))
      v.push(`${name} has data-va-audio="${role}"; use music, voice or sfx.`)
    if (attr(e, 'data-va-muted') !== null && num(attr(e, 'data-volume')) !== 0)
      v.push(`${name} is muted, so it needs data-volume="0".`)
  }
  for (const e of kids(root).filter((x) => attr(x, 'data-va-layer') === 'music'))
    if (e.tagName !== 'audio' || !attr(e, 'id')) v.push('The music layer must be an <audio> with an id.')

  const { colors } = readColors(d)
  if (Object.keys(colors).length === 0) v.push('Declare colours as --va-color-<role> on the root.')

  if (summary?.captions) {
    const comp = read(d)
    const known = new Map(comp.beats.flatMap((b) => b.texts.map((x) => [x.id, b.id] as const)))
    const voiced = new Set(comp.beats.filter((b) => b.voice).map((b) => b.id))
    for (const c of summary.captions) {
      if (c.voice) {
        if (!c.beat || !voiced.has(c.beat))
          v.push(`Voice caption "${c.text.slice(0, 40)}" needs the beat whose voice-over it follows.`)
        continue
      }
      if (!c.textId || !c.beat) {
        v.push('Every caption needs beat and textId (or voice: true for narration).')
        break
      }
      if (known.get(c.textId) !== c.beat)
        v.push(`Caption "${c.textId}" doesn't match a text in beat "${c.beat}".`)
    }
  }
  return [...new Set(v)]
}

// ───── ducking ─────
interface LanePoint {
  t: number
  v: number
}
const DUCK_DOWN = 0.25
const DUCK_UP = 0.4

/**
 * The music's volume points for the voice-over: full level, down to `level` just before each voice, back up after
 * it. Voices closer than a second apart share one dip. Null when the level isn't a number in 0-1.
 */
export function duckPoints(d: Doc, level: number): LanePoint[] | null {
  if (!(level >= 0 && level <= 1)) return null
  const comp = read(d)
  const r = (n: number) => Math.round(n * 1000) / 1000
  const spans: [number, number][] = []
  let t = 0
  for (const b of comp.beats) {
    if (b.voice && b.voice.duration > 0) {
      const s = t + b.voice.start
      const e = s + b.voice.duration
      const last = spans[spans.length - 1]
      if (last && s - last[1] < 1) last[1] = e
      else spans.push([s, e])
    }
    t += b.duration
  }
  const points: LanePoint[] = [{ t: 0, v: spans[0] && spans[0][0] <= DUCK_DOWN ? level : 1 }]
  for (const [s, e] of spans) {
    if (s > DUCK_DOWN) points.push({ t: r(s - DUCK_DOWN), v: 1 }, { t: r(s), v: level })
    points.push({ t: r(e), v: level })
    if (e + DUCK_UP < t) points.push({ t: r(e + DUCK_UP), v: 1 })
  }
  return points.filter((p, i) => i === 0 || p.t > (points[i - 1]?.t ?? -1))
}

function volumeLane(raw: string | null): LanePoint[] | null {
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as { lanes?: { target?: string; points?: LanePoint[] }[] }
    return a.lanes?.find((l) => l.target === 'volume')?.points ?? null
  } catch {
    return null
  }
}

const sameLane = (a: LanePoint[] | null, b: LanePoint[]) =>
  !!a &&
  a.length === b.length &&
  a.every((p, i) => Math.abs(p.t - (b[i]?.t ?? NaN)) <= 0.02 && Math.abs(p.v - (b[i]?.v ?? NaN)) <= 0.01)

/** Rewrites the volume lane of every ducked layer, keeping its other lanes. */
export function applyDucking(d: Doc) {
  for (const l of kids(d.root).filter((e) => attr(e, 'data-va-duck') !== null)) {
    const points = duckPoints(d, num(attr(l, 'data-va-duck')))
    if (!points) continue
    let auto: { version?: number; lanes?: { target?: string }[] } = {}
    try {
      auto = JSON.parse(attr(l, 'data-automation') ?? '{}') as typeof auto
    } catch {
      auto = {}
    }
    const lanes = (auto.lanes ?? []).filter((x) => x.target !== 'volume')
    setAttr(
      l,
      'data-automation',
      JSON.stringify({ ...auto, version: 1, lanes: [...lanes, { target: 'volume', points }] }),
    )
  }
}

// ───── edits ─────
export type EditOp =
  | { op: 'text'; id: string; text: string }
  | { op: 'retime'; beat: string; duration: number }
  | { op: 'reorder'; order: string[] }
  | { op: 'delete'; beat: string }
  | { op: 'color'; role: string; value: string }
  | { op: 'media'; slot: string; src: string; kind: 'image' | 'video'; fit: 'cover' | 'contain' }
  | {
      op: 'audio'
      id: string
      src?: string | undefined
      volume?: number | undefined
      muted?: boolean | undefined
    }
  | { op: 'voice'; beat: string; text: string }

export interface EditOptions {
  /** Colours a role may take (the brand palette). Empty: any #rgb/#rrggbb. */
  palette?: string[]
  /** Each voiced beat's line as it was spoken (from the voice script); voice ops need it. */
  narration?: Record<string, string>
}

/** Lays the beats back to back from 0 in whole frames and sets the root, layer and video-slot durations to match. */
function relayout(d: Doc) {
  let t = 0
  let end = 0 // where the beats end unsnapped, so snapping doesn't add a frame per beat to the total
  for (const b of beatsOf(d.root)) {
    setAttr(b, 'data-start', fmt(t))
    // Whole frames, so the starts land where validate expects even when the agent wrote, say, 3.85 s (115.5 frames).
    end += num(attr(b, 'data-duration'))
    const dur = frames(end) - t
    setAttr(b, 'data-duration', fmt(dur))
    for (const vid of [...walk(b)].filter((e) => attr(e, 'data-va-kind') === 'video')) {
      setAttr(vid, 'data-start', '0')
      setAttr(vid, 'data-duration', fmt(dur)) // longer clips are trimmed to the beat
    }
    t = frames(end)
  }
  setAttr(d.root, 'data-duration', fmt(t))
  for (const l of kids(d.root).filter((e) => attr(e, 'data-va-layer') !== null)) {
    setAttr(l, 'data-start', '0')
    setAttr(l, 'data-duration', fmt(t))
  }
  applyDucking(d)
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
      // Text captions stretch with their beat; voice ones follow the audio, which keeps its speed.
      const k = c.voice ? 1 : b.duration / b.authoredDuration
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
  // The lines after the edits: voice ops replace them, and the caller writes them back to the voice script.
  const narration = opts.narration ? { ...opts.narration } : undefined
  for (const op of ops) applyOne(d, op, opts, narration)
  relayout(d)
  const out = save(d)
  const nextSummary = syncCaptions(d, summary)
  const after = validate(out, nextSummary)
  if (after.length) throw new ContractError(after)
  return { html: out, summary: nextSummary, composition: read(load(out), narration), narration }
}

function applyOne(d: Doc, op: EditOp, opts: EditOptions, narration: Record<string, string> | undefined) {
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
    case 'audio': {
      const el = [...walk(d.root)].find((e) => e.tagName === 'audio' && attr(e, 'id') === op.id)
      if (!el) throw new ContractError([`There's no audio "${op.id}".`])
      if (op.src !== undefined && op.src !== attr(el, 'src')) {
        if (!/^assets\/media\/[A-Za-z0-9_.-]+$/.test(op.src))
          throw new ContractError(['Audio comes from assets/media/.'])
        setAttr(el, 'src', op.src)
        // A trim point belongs to the old file.
        el.attrs = el.attrs.filter((a) => a.name !== 'data-media-start')
      }
      const track = audioOf(d.root).find((t) => t.id === op.id)
      const volume = op.volume ?? track?.volume ?? 1
      if (!(volume >= 0 && volume <= MAX_VOLUME))
        throw new ContractError([`Volume goes from 0 to ${MAX_VOLUME}.`])
      const level = fmt(Math.round(volume * 100) / 100)
      // HyperFrames mixes every timed <audio> whatever its muted attribute says, so muting is data-volume="0".
      el.attrs = el.attrs.filter((a) => !['data-volume', 'data-va-volume', 'data-va-muted'].includes(a.name))
      if (op.muted ?? track?.muted) {
        setAttr(el, 'data-volume', '0')
        setAttr(el, 'data-va-volume', level)
        setAttr(el, 'data-va-muted', '')
      } else setAttr(el, 'data-volume', level)
      return
    }
    case 'voice': {
      const el = voicesOf(beat(op.beat))[0]
      const spoken =
        opts.narration && Object.hasOwn(opts.narration, op.beat) ? opts.narration[op.beat] : undefined
      if (!el || spoken === undefined || !narration)
        throw new ContractError([`Beat "${op.beat}" has no narration to change.`])
      const text = normalizeLine(op.text)
      if (!text) throw new ContractError(['A narration line needs some words.'])
      if (text.length > MAX_NARRATION)
        throw new ContractError([`Keep a narration line under ${MAX_NARRATION} characters.`])
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f<>]/.test(text))
        throw new ContractError(['A narration line is plain text: no < or > and no control characters.'])
      narration[op.beat] = text
      // Back to the spoken words: nothing to re-voice.
      if (text === normalizeLine(spoken)) el.attrs = el.attrs.filter((a) => a.name !== REVOICE)
      else setAttr(el, REVOICE, '')
      return
    }
  }
}

/** A re-spoken line for applyRevoice: the new file's length, the shortest its beat can be, and its cues. */
export interface RevoicedLine {
  beat: string
  file: string
  duration: number
  /** The beat's length before, and the shortest it can be with this voice (lead + voice + quiet after). */
  minBeat: number
  /** The cues, in seconds into the beat. */
  cues: { text: string; start: number; end: number }[]
}

/**
 * The composition after re-voicing (scripts/voice.ts revoice; render-job recomputes it to check the run changed
 * nothing else): each marked clip takes its new file length and loses the mark, and a beat whose new line is longer
 * than the old one grows to fit it when it no longer does (later beats move, captions keep in step, the music's dip
 * follows). A shorter line never shortens its beat. The re-voiced beats' narration captions are replaced by the new
 * cues. Throws ContractError when a marked clip isn't re-voiced or a line is for a clip that isn't marked.
 */
export function applyRevoice(html: string, summary: Summary, lines: RevoicedLine[]) {
  const before = validate(html, summary)
  if (before.length) throw new ContractError(before)
  const d = load(html)
  const lengthened: { beat: string; from: number; to: number }[] = []
  const marked = markedForRevoice(d)
  for (const id of marked)
    if (!lines.some((l) => l.beat === id))
      throw new ContractError([`Beat "${id}" is marked but wasn't re-voiced.`])
  for (const l of lines) {
    const b = beatsOf(d.root).find((x) => attr(x, 'data-va-beat') === l.beat)
    const el = b && voicesOf(b)[0]
    if (!b || !el || attr(el, REVOICE) === null)
      throw new ContractError([`Beat "${l.beat}" isn't marked for re-voicing.`])
    const old = num(attr(el, 'data-duration'))
    setAttr(el, 'src', l.file)
    setAttr(el, 'data-duration', fmt(l.duration))
    el.attrs = el.attrs.filter((a) => a.name !== REVOICE)
    const dur = num(attr(b, 'data-duration'))
    if (l.duration > old && dur < l.minBeat) {
      const to = Math.ceil(l.minBeat * FPS - 1e-6) / FPS
      setAttr(b, 'data-duration', fmt(to))
      lengthened.push({ beat: l.beat, from: dur, to: frames(to) })
    }
  }
  relayout(d)
  const out = save(d)
  const redone = new Set(lines.map((l) => l.beat))
  const captions = [
    ...(summary.captions ?? []).filter((c) => !(c.voice && c.beat && redone.has(c.beat))),
    ...lines.flatMap((l) =>
      l.cues.map((c) => ({
        start: 0,
        end: 0,
        text: c.text,
        beat: l.beat,
        voice: true,
        beatStart: c.start,
        beatEnd: c.end,
      })),
    ),
  ]
  const nextSummary = syncCaptions(d, { ...summary, captions })
  const after = validate(out, nextSummary)
  if (after.length) throw new ContractError(after)
  return { html: out, summary: nextSummary, lengthened }
}
