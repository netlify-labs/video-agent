// Redo a scene (docs/plans/2026-11-04-regenerate-beat.md §4.5): the splice. A scoped revision may change only the
// scenes (beats) it names. Rather than diffing the agent's file against a list of what's allowed, the splice builds what
// the composition must be: the parent, with the agent's scoped beats put in, re-laid end to end (frozen beats keep their
// lengths verbatim), later captions shifted, the music's ducking rewritten. The render uses the splice's bytes, so what
// people get is what was checked; check-contract --fix, render-job and finalize all call this, in the same style as
// app/server/lib/revoice.ts. Pure: the callers log.
import { createHash } from 'node:crypto'
import type { DefaultTreeAdapterMap } from 'parse5'
import {
  attr,
  ContractError,
  HOLD_BEAT,
  load,
  NARRATION_ID,
  read,
  save,
  validate,
  walk,
  type Caption,
  type Composition,
  type Doc,
  type Summary,
  type ValidateOptions,
  relayoutScoped,
} from './contract.js'
import { FPS, fmt, frames, sec, shiftCues, syncCaptionsFor } from './contract-core.js'
import { scopedScriptProblems } from './scope-script.js'
import { scopedStyleProblems } from './scope-style.js'
import { excluded } from './bundle-manifest.js'
import { isReference } from './bundle-references.js'
import {
  FPS_TOLERANCE,
  SAMPLE_RATE,
  VOICE_DIR,
  VOICE_JSON,
  VOICE_SCRIPT,
  voiceCaptions,
  type VoiceFile,
  type VoiceScript,
} from './voice.js'

type Node = DefaultTreeAdapterMap['node']
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
type Element = DefaultTreeAdapterMap['element']

/** Where prepare-run writes a scoped revision's beats and the parent's layout, inside the frozen copy. */
export const SCOPE_LAYOUT_FILE = 'scope.json'
export interface ScopeLayout {
  beats: string[]
  layout: { id: string; label: string | null; start: number; duration: number }[]
}

/** render-job's StepError prefix for a refused scoped render. */
export const SCOPE_VIOLATED = 'scope_violated'
/** Finalize's invalid_output message for a scoped version that changed parts outside its scope. */
export const SCOPE_REFUSED_PREFIX =
  'This run changed parts of the video outside the scenes it was asked to redo'
/** Whether an attempt's error is a scope refusal (the retry line in the prompt and the UI's fallback use it). */
export const isScopeRefusal = (message: string | null | undefined): boolean =>
  !!message && (message.startsWith(`${SCOPE_VIOLATED}:`) || message.startsWith(SCOPE_REFUSED_PREFIX))

/** A scene's length bounds when it's redone: the editor's retime bounds. */
export const SCOPED_MIN_SEC = 0.5
export const SCOPED_MAX_SEC = 120

/**
 * Whether the parent's length is locked by recorded narration (the va-narration element): its scoped beats keep their
 * exact lengths. check-contract, render-job and finalize all derive it here, so they can't disagree.
 */
export function isLockedLength(parentHtml: string): boolean {
  try {
    return [...walk(load(parentHtml).root)].some((e) => attr(e, 'id') === NARRATION_ID)
  } catch {
    return false
  }
}

export interface ScopeSide {
  html: string
  summary: Summary
  voice?: VoiceFile | null
  script?: VoiceScript | null
}

export interface ScopeInput {
  parent: ScopeSide
  agent: ScopeSide
  beats: readonly string[]
  /** Recorded narration: scoped beats keep their length (isLockedLength). */
  lockedLength: boolean
  /** Passed to validate for the parent and the splice (a narrated parent's bus length). */
  validateOptions?: ValidateOptions
}

export interface Splice {
  /** The composition the scope allows; null when it couldn't be built (see problems). */
  html: string | null
  summary: Summary | null
  /** What the agent changed outside the scope and the splice puts back (scopeProblems, va-8cy4.2.5). */
  putBack: string[]
  /** What the splice can't fix: the agent's to change, or a server bug for "internal: …" ones. */
  problems: string[]
  /** Seconds the video got longer (negative: shorter). */
  lengthDelta: number
}

/** The bytes render-job renders and archives, and finalize compares the upload with. */
export function spliceBytes(s: Pick<Splice, 'html' | 'summary'>): {
  'index.html': string
  'summary.json': string
} {
  if (s.html === null || s.summary === null) throw new Error("The splice wasn't built.")
  return { 'index.html': s.html, 'summary.json': JSON.stringify(s.summary, null, 2) }
}

const beatsOf = (root: Element) =>
  root.childNodes.filter((n): n is Element => 'tagName' in n && attr(n, 'data-va-beat') !== null)
const idOf = (b: Element) => attr(b, 'data-va-beat') ?? ''
const num = (v: string | null) => (v === null || v.trim() === '' ? NaN : Number(v))
function setAttr(el: Element, name: string, value: string) {
  const a = el.attrs.find((x) => x.name === name)
  if (a) a.value = value
  else el.attrs.push({ name, value })
}

/** A deep copy of a parse5 subtree, attached to `parent`. */
function clone<T extends Node>(node: T, parent: unknown): T {
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parentNode') copy[k] = parent
    else if (k === 'childNodes') copy[k] = (v as Node[]).map((c) => clone(c, copy))
    else if (k === 'content' && v) copy[k] = clone(v as Node, null)
    else if (k === 'attrs') copy[k] = (v as { name: string; value: string }[]).map((a) => ({ ...a }))
    else if (k === 'sourceCodeLocation') continue
    else copy[k] = v
  }
  return copy as unknown as T
}

const fail = (problems: string[], parentTotal = 0, agentTotal = parentTotal): Splice => ({
  html: null,
  summary: null,
  putBack: [],
  problems,
  lengthDelta: agentTotal - parentTotal,
})

/** Beat ids (validate's messages say Beat "x") as the scene names people see. */
const asScenes = (message: string, labels: Map<string, string>) =>
  message.replace(/Beat "([a-z0-9-]+)"/g, (_m, id: string) => `Scene "${labels.get(id) ?? id}"`)

/** The composition the scope allows, with what it put back and what's still wrong (plan §4.5 steps 1-9). */
export function spliceScoped(i: ScopeInput): Splice {
  const scoped = new Set(i.beats)

  // 1. The parent must keep the contract: reviseVideo only scopes editable versions, so this is a server bug.
  const parentViolations = validate(i.parent.html, i.parent.summary, i.validateOptions)
  if (parentViolations.length)
    return fail([
      `internal: the parent doesn't keep the editing contract (${parentViolations.slice(0, 3).join(' ')})`,
    ])
  const parentDoc = load(i.parent.html)
  const parent = read(parentDoc)
  const labels = new Map(parent.beats.map((b) => [b.id, b.label ?? b.id]))
  const scene = (id: string) => `Scene "${labels.get(id) ?? id}"`
  const parentTotal = num(attr(parentDoc.root, 'data-duration'))
  // As the parent wrote them, read before the splice changes this document.
  const parentDur = new Map(beatsOf(parentDoc.root).map((b) => [idOf(b), attr(b, 'data-duration') ?? '']))

  // reviseVideo refuses these first; checked again so a bad manifest can't build a splice.
  const realBeats = parent.beats.filter((b) => b.id !== HOLD_BEAT)
  const internal: string[] = []
  if (scoped.size === 0) internal.push('internal: the scope names no scenes.')
  for (const id of scoped) {
    if (id === HOLD_BEAT)
      internal.push('internal: the held last frame (va-hold) is not a scene that can be redone.')
    else if (!labels.has(id))
      internal.push(`internal: the scope names "${id}", which isn't a scene of the parent.`)
  }
  const last = realBeats.at(-1)
  if (parent.beats.some((b) => b.id === HOLD_BEAT) && last && scoped.has(last.id))
    internal.push(`internal: ${scene(last.id)} ends under recorded narration and holds its last frame.`)
  if (internal.length) return fail(internal, parentTotal)

  // 2. The agent's file, read but not validated (its derived values are expected to be stale).
  let agentDoc: Doc
  try {
    agentDoc = load(i.agent.html)
  } catch (e) {
    return fail(
      [`The composition can't be read: ${e instanceof ContractError ? e.violations.join(' ') : String(e)}`],
      parentTotal,
    )
  }
  const parentIds = parent.beats.map((b) => b.id)
  const agentBeats = beatsOf(agentDoc.root)
  const agentIds = agentBeats.map(idOf)
  const listProblems = beatListProblems(parentIds, agentIds, scene)
  if (listProblems.length) return fail(listProblems, parentTotal)

  // 3. The parent with the agent's scoped beats in.
  const d = parentDoc
  const agentStarts = new Map<string, number>()
  for (const id of scoped) {
    const mine = agentBeats.find((b) => idOf(b) === id)
    const theirs = beatsOf(d.root).find((b) => idOf(b) === id)
    if (!mine || !theirs) continue
    agentStarts.set(id, num(attr(mine, 'data-start')))
    const at = d.root.childNodes.indexOf(theirs)
    d.root.childNodes[at] = clone(mine, d.root)
  }

  // 4. Scoped beats: whole frames (or exactly as long as before under recorded narration), fresh authored length.
  const problems: string[] = []
  for (const b of beatsOf(d.root).filter((x) => scoped.has(idOf(x)))) {
    const id = idOf(b)
    const before = parentDur.get(id) ?? ''
    const dur = num(attr(b, 'data-duration'))
    let next: string
    if (!(dur > 0)) {
      problems.push(`${scene(id)} needs a positive data-duration.`)
      next = before
    } else if (i.lockedLength) {
      if (Math.abs(dur - num(before)) > 1e-6)
        problems.push(
          `${scene(id)}: keep each scoped scene exactly as long as it is now (${before}s): the recorded narration is locked.`,
        )
      next = before
    } else {
      const snapped = frames(dur)
      if (snapped < SCOPED_MIN_SEC || snapped > SCOPED_MAX_SEC)
        problems.push(
          `${scene(id)} lasts ${fmt(dur)}s; a scene lasts between ${SCOPED_MIN_SEC} and ${SCOPED_MAX_SEC} seconds.`,
        )
      next = fmt(snapped)
    }
    setAttr(b, 'data-duration', next)
    setAttr(b, 'data-va-authored-duration', next)
    problems.push(...scopedStyleProblems(b, id), ...scopedScriptProblems(b, id))
  }
  if (problems.length) return fail(problems, parentTotal)

  // 5. Re-lay: frozen durations verbatim, the root, layers, speech and ducking follow.
  try {
    relayoutScoped(d, scoped)
  } catch (e) {
    return fail([asScenes(e instanceof Error ? e.message : String(e), labels)], parentTotal)
  }
  for (const b of beatsOf(d.root).filter((x) => !scoped.has(idOf(x))))
    if (attr(b, 'data-duration') !== parentDur.get(idOf(b)))
      return fail([`internal: frozen ${scene(idOf(b))} changed length.`], parentTotal)
  const total = num(attr(d.root, 'data-duration'))

  // 6-7. Captions and the summary.
  const comp = read(d)
  const summary = spliceSummary(i, parent, comp, scoped, agentStarts)

  // 8. The splice must keep the contract; what doesn't is the agent's to fix.
  const html = save(d)
  const violations = validate(html, summary, i.validateOptions).map((v) => asScenes(v, labels))
  // 9. What the agent changed outside the scope (scopeProblems, va-8cy4.2.5).
  const putBack = scopeProblems(i, { html, summary })
  return { html, summary, putBack, problems: violations, lengthDelta: total - parentTotal }
}

/** Added, removed, renamed, moved or repeated beats, by scene name. One-in-one-out only in v1. */
function beatListProblems(parentIds: string[], agentIds: string[], scene: (id: string) => string): string[] {
  const p: string[] = []
  const removed = parentIds.filter((id) => !agentIds.includes(id))
  const added = agentIds.filter((id) => !parentIds.includes(id))
  for (const id of new Set(agentIds.filter((x, n) => agentIds.indexOf(x) !== n)))
    p.push(`Scene "${id}" appears twice; keep one.`)
  if (
    removed.length === 1 &&
    added.length === 1 &&
    agentIds.indexOf(added[0] ?? '') === parentIds.indexOf(removed[0] ?? '')
  )
    p.push(
      `${scene(removed[0] ?? '')} was renamed to "${added[0] ?? ''}"; keep its id "${removed[0] ?? ''}".`,
    )
  else {
    for (const id of removed) p.push(`${scene(id)} was removed; redoing scenes keeps every scene.`)
    for (const id of added) p.push(`Scene "${id}" is new; redoing scenes can't add one.`)
  }
  if (!p.length && agentIds.join() !== parentIds.join())
    p.push(`The scenes were moved; keep them in this order: ${parentIds.join(', ')}.`)
  return p
}

/**
 * The splice's summary: the agent's cues for scoped beats (voiced ones recomputed from voice.json), the parent's
 * others shifted by their beat's start delta without re-snapping, recorded-narration cues as they were; the agent's
 * title and summary; credits from both.
 */
function spliceSummary(
  i: ScopeInput,
  parent: Composition,
  comp: Composition,
  scoped: ReadonlySet<string>,
  agentStarts: ReadonlyMap<string, number>,
): Summary {
  const parentStart = new Map(parent.beats.map((b) => [b.id, b.start]))
  const newStart = new Map(comp.beats.map((b) => [b.id, b.start]))
  const frozen: Caption[] = []
  for (const c of i.parent.summary.captions ?? []) {
    if (!c.beat) frozen.push({ ...c })
    else if (!scoped.has(c.beat))
      frozen.push(...shiftCues([c], (newStart.get(c.beat) ?? 0) - (parentStart.get(c.beat) ?? 0)))
  }
  const voiced = new Set(
    (i.agent.voice?.beats ?? [])
      .map((v) => v.beat)
      .filter((b) => scoped.has(b) && comp.beats.find((x) => x.id === b)?.voice),
  )
  // Text cues of scoped beats, beat-relative (derived from the agent's own start when missing), then made absolute.
  const fresh = (i.agent.summary.captions ?? [])
    .filter((c) => c.beat && scoped.has(c.beat) && !voiced.has(c.beat) && !c.voice && !c.narration)
    .map((c): Caption => {
      const from = agentStarts.get(c.beat ?? '') ?? 0
      return {
        ...c,
        beatStart: c.beatStart ?? Math.max(0, c.start - from),
        beatEnd: c.beatEnd ?? Math.max(0, c.end - from),
      }
    })
  const texts = syncCaptionsFor(comp, { captions: fresh }).captions ?? []
  const voices = voiceCaptions(
    comp.beats.filter((b) => voiced.has(b.id)),
    { beats: (i.agent.voice?.beats ?? []).filter((v) => voiced.has(v.beat)) },
  )
  const captions: Caption[] = [...frozen, ...texts, ...voices]
  captions.sort(
    (a, b) =>
      a.start - b.start ||
      (a.beat ?? '').localeCompare(b.beat ?? '') ||
      (a.textId ?? '').localeCompare(b.textId ?? ''),
  )
  const credits = [
    ...new Set([...stringsOf(i.parent.summary.credits), ...stringsOf(i.agent.summary.credits)]),
  ]
  const out: Summary = { ...i.parent.summary }
  if (typeof i.agent.summary.title === 'string') out.title = i.agent.summary.title
  if (typeof i.agent.summary.summary === 'string') out.summary = i.agent.summary.summary
  out.captions = captions
  if (credits.length) out.credits = credits
  return out
}

const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// ───── what the agent changed outside the scope ─────

const RAW_TEXT = new Set(['script', 'style', 'pre', 'textarea'])
const isEl = (n: Node): n is Element => 'tagName' in n
const kidsOf = (n: Element) => n.childNodes.filter(isEl)

/**
 * A subtree as a canonical string: attributes sorted, whitespace-only text dropped, other text whitespace-collapsed
 * (trimmed only inside script, style, pre and textarea), comments ignored. `skip` drops derived attributes.
 */
function canon(n: Node, skip: (el: Element, attr: string) => boolean, raw = false): string {
  if (n.nodeName === '#text') {
    const v = 'value' in n ? n.value : ''
    const t = raw ? v.trim() : v.replace(/\s+/g, ' ').trim()
    return t ? JSON.stringify(t) : ''
  }
  if (!isEl(n)) return ''
  const attrs = n.attrs
    .filter((a) => !skip(n, a.name))
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
  const inner = n.tagName === 'template' ? (n as unknown as { content: Element }).content : n
  const kids = inner.childNodes.map((c) => canon(c, skip, raw || RAW_TEXT.has(n.tagName))).filter(Boolean)
  return `<${n.tagName} ${attrs.join(' ')}>${kids.join('')}</${n.tagName}>`
}

/** Values the splice derives, never compared: beat starts, the totals, video slots and the music's ducking lane. */
function derived(el: Element, name: string): boolean {
  if (name === 'data-start' && (attr(el, 'data-va-beat') !== null || attr(el, 'data-va-layer') !== null))
    return true
  if (
    name === 'data-duration' &&
    (attr(el, 'data-va-contract') !== null || attr(el, 'data-va-layer') !== null)
  )
    return true
  if ((name === 'data-duration' || name === 'data-start') && attr(el, 'data-va-kind') === 'video') return true
  if (name === 'data-automation' && attr(el, 'data-va-duck') !== null) return true
  return false
}

const ATTR_WORDS: Record<string, string> = {
  'data-volume': 'volume',
  'data-va-volume': 'volume',
  src: 'file',
  'data-fade-in': 'fade-in',
  'data-fade-out': 'fade-out',
}

/** What changed inside a frozen scene, in a few words: the first text, script or element that differs. */
function whatChanged(a: Element, b: Element): string {
  const texts = (e: Element) => [...walk(e)].filter((x) => attr(x, 'data-va-text') !== null)
  for (const t of texts(a)) {
    const id = attr(t, 'data-va-text') ?? ''
    const other = texts(b).find((x) => attr(x, 'data-va-text') === id)
    if (!other || canon(t, derived) !== canon(other, derived)) {
      const label = attr(t, 'data-va-label')?.trim()
      return label ? `its ${label.toLowerCase()} text` : `its "${id}" text`
    }
  }
  const scripts = (e: Element) =>
    [...walk(e)].filter((x) => x.tagName === 'script').map((x) => canon(x, derived))
  if (scripts(a).join() !== scripts(b).join()) return 'its script'
  const styles = (e: Element) =>
    [...walk(e)].filter((x) => x.tagName === 'style').map((x) => canon(x, derived))
  if (styles(a).join() !== styles(b).join()) return 'its styles'
  const own = (e: Element) => canon({ ...e, childNodes: [] }, derived)
  if (own(a) !== own(b)) return 'its attributes'
  return 'its contents'
}

/** Root-level children that aren't beats or layers, by tag and order: "A root-level <script> changed". */
function plainKids(parent: Element, root: Element | null) {
  return kidsOf(parent).filter(
    (e) => e !== root && attr(e, 'data-va-beat') === null && attr(e, 'data-va-layer') === null,
  )
}

function compareList(a: Element[], b: Element[], where: string, out: string[]) {
  const tags = new Set([...a, ...b].map((e) => e.tagName))
  for (const tag of tags) {
    const x = a.filter((e) => e.tagName === tag).map((e) => canon(e, derived))
    const y = b.filter((e) => e.tagName === tag).map((e) => canon(e, derived))
    if (x.length > y.length) out.push(`A ${where} <${tag}> was added.`)
    else if (x.length < y.length) out.push(`A ${where} <${tag}> was removed.`)
    else if (x.some((v, n) => v !== y[n])) out.push(`A ${where} <${tag}> changed.`)
  }
}

/**
 * Every way the agent's composition differs from the splice outside the scope, in plain words, each once. A file that
 * is only re-indented or has its attributes reordered has none. These are what check-contract --fix puts back, and
 * the body of render-job's scope_violated and finalize's refusal.
 */
export function scopeProblems(i: ScopeInput, splice: { html: string; summary: Summary }): string[] {
  const out: string[] = []
  const scoped = new Set(i.beats)
  let a: Doc
  try {
    a = load(i.agent.html)
  } catch {
    return ["The composition can't be read."]
  }
  const b = load(splice.html)
  const labels = new Map(read(b).beats.map((x) => [x.id, x.label ?? x.id]))
  const scene = (id: string) => `Scene "${labels.get(id) ?? id}"`
  const find = (d: Doc, tag: string) => [...walk(d.doc as unknown as Element)].find((e) => e.tagName === tag)

  // <html> and <head>.
  const [htmlA, htmlB] = [find(a, 'html'), find(b, 'html')]
  if (
    htmlA &&
    htmlB &&
    canon({ ...htmlA, childNodes: [] }, derived) !== canon({ ...htmlB, childNodes: [] }, derived)
  )
    out.push('The <html> element changed.')
  const [headA, headB] = [find(a, 'head'), find(b, 'head')]
  if (headA && headB && canon(headA, derived) !== canon(headB, derived)) {
    const count = (h: Element, tag: string) => kidsOf(h).filter((e) => e.tagName === tag).length
    const added = [...new Set(kidsOf(headA).map((e) => e.tagName))].find(
      (t) => count(headA, t) > count(headB, t),
    )
    const removed = [...new Set(kidsOf(headB).map((e) => e.tagName))].find(
      (t) => count(headB, t) > count(headA, t),
    )
    out.push(
      added
        ? `<head> changed (a <${added}> was added).`
        : removed
          ? `<head> changed (a <${removed}> was removed).`
          : '<head> changed.',
    )
  }
  // Around the root, inside <body>.
  const [bodyA, bodyB] = [find(a, 'body'), find(b, 'body')]
  if (bodyA && bodyB) compareList(plainKids(bodyA, a.root), plainKids(bodyB, b.root), 'page-level', out)

  // The root's own attributes, but its length.
  const rootAttrs = (e: Element) =>
    new Map(e.attrs.filter((x) => !derived(e, x.name)).map((x) => [x.name, x.value]))
  const [ra, rb] = [rootAttrs(a.root), rootAttrs(b.root)]
  for (const name of [...new Set([...ra.keys(), ...rb.keys()])].sort())
    if (ra.get(name) !== rb.get(name)) out.push(`Root attribute ${name} changed.`)

  // Frozen scenes.
  const beatMap = (d: Doc) =>
    new Map(
      kidsOf(d.root)
        .filter((e) => attr(e, 'data-va-beat') !== null)
        .map((e) => [idOf(e), e]),
    )
  const [beatsA, beatsB] = [beatMap(a), beatMap(b)]
  for (const [id, eb] of beatsB) {
    if (scoped.has(id)) continue
    const ea = beatsA.get(id)
    if (!ea) continue // a removed scene is a splice problem, reported there
    if (canon(ea, derived) !== canon(eb, derived)) out.push(`${scene(id)} changed (${whatChanged(ea, eb)}).`)
  }
  // Layers: the music, backgrounds, logo bugs, recorded narration.
  const layerMap = (d: Doc) =>
    new Map(
      kidsOf(d.root)
        .filter((e) => attr(e, 'data-va-layer') !== null)
        .map((e) => [attr(e, 'data-va-layer') ?? '', e]),
    )
  const [layersA, layersB] = [layerMap(a), layerMap(b)]
  for (const name of [...new Set([...layersA.keys(), ...layersB.keys()])].sort()) {
    const [la, lb] = [layersA.get(name), layersB.get(name)]
    if (!la) out.push(`The ${name} layer was removed.`)
    else if (!lb) out.push(`A ${name} layer was added.`)
    else if (canon(la, derived) !== canon(lb, derived)) {
      const [xa, xb] = [rootAttrs(la), rootAttrs(lb)]
      const changed = [...new Set([...xa.keys(), ...xb.keys()])].sort().filter((k) => xa.get(k) !== xb.get(k))
      out.push(
        changed.length
          ? `The ${name} layer's ${[...new Set(changed.map((k) => ATTR_WORDS[k] ?? k))].join(', ')} changed.`
          : `The ${name} layer changed.`,
      )
    }
  }
  // Root-level <script>, <style> and anything else that isn't a beat or a layer.
  compareList(plainKids(a.root, null), plainKids(b.root, null), 'root-level', out)

  out.push(...captionProblems(i, scoped, scene), ...voiceProblems(i, scoped, scene))
  return [...new Set(out)]
}

/**
 * Other scenes' cues the agent wrote that aren't the parent's (by beat, text id, text and beat-relative times, in any
 * order). Leaving them out is fine: the splice puts them back.
 */
function captionProblems(
  i: ScopeInput,
  scoped: ReadonlySet<string>,
  scene: (id: string) => string,
): string[] {
  const key = (c: Caption) =>
    c.beat
      ? JSON.stringify([c.textId ?? null, c.text, !!c.voice, ms(c.beatStart), ms(c.beatEnd)])
      : JSON.stringify([c.id ?? null, c.text, ms(c.start), ms(c.end)])
  const group = (cs: Caption[] | undefined) => {
    const m = new Map<string, string[]>()
    for (const c of cs ?? []) {
      if (c.beat && scoped.has(c.beat)) continue
      const g = c.beat ?? ''
      m.set(g, [...(m.get(g) ?? []), key(c)])
    }
    return m
  }
  const [mine, theirs] = [group(i.agent.summary.captions), group(i.parent.summary.captions)]
  const out: string[] = []
  for (const [g, keys] of mine)
    if ([...keys].sort().join('\n') !== [...(theirs.get(g) ?? [])].sort().join('\n'))
      out.push(g ? `${scene(g)}'s captions changed.` : "The recorded narration's captions changed.")
  return out
}
const ms = (n: number | undefined) => (n === undefined ? null : Math.round(n * 1000))

/** Other scenes' voice-over (voice.json entries and script.json lines) and the voice itself. */
function voiceProblems(i: ScopeInput, scoped: ReadonlySet<string>, scene: (id: string) => string): string[] {
  const out: string[] = []
  const [pv, av] = [i.parent.voice ?? null, i.agent.voice ?? null]
  if (pv && av) {
    for (const f of ['provider', 'voice', 'speed'] as const)
      if (pv[f] !== av[f]) out.push(`The voice-over's ${f} changed.`)
  }
  if (pv) {
    const theirs = new Map(pv.beats.map((x) => [x.beat, JSON.stringify(x)]))
    const mine = new Map((av?.beats ?? []).map((x) => [x.beat, JSON.stringify(x)]))
    for (const id of [...new Set([...theirs.keys(), ...mine.keys()])])
      if (!scoped.has(id) && theirs.get(id) !== mine.get(id)) out.push(`${scene(id)}'s voice-over changed.`)
  }
  const [ps, as] = [i.parent.script ?? null, i.agent.script ?? null]
  if (ps) {
    if (as && (ps.voice !== as.voice || ps.speed !== as.speed))
      out.push("The voice-over script's voice or speed changed.")
    const theirs = new Map(ps.lines.map((l) => [l.beat, l.text]))
    const mine = new Map((as?.lines ?? []).map((l) => [l.beat, l.text]))
    for (const id of [...new Set([...theirs.keys(), ...mine.keys()])])
      if (!scoped.has(id) && theirs.get(id) !== mine.get(id))
        out.push(`${scene(id)}'s voice-over line changed.`)
  }
  return out
}

// ───── files ─────

export const CREDITS_FILE = 'assets/music/credits.json'

/**
 * Files a scoped run may rewrite, besides the scoped scenes' new files: the composition, its captions, the voice-over
 * files and the run-fetched credits (append-only, checked by creditsAppendOnly). Other features add theirs with
 * registerDerivedFiles. Screen recordings' (the kept plan.json and the scoped steps' cursor and hold files) are listed
 * here, so every scope check has them whatever it imported.
 */
export const DERIVED_FILES: ((beats: readonly string[], comp: Composition | null) => string[])[] = [
  (beats) => [
    'index.html',
    'summary.json',
    VOICE_SCRIPT,
    VOICE_JSON,
    CREDITS_FILE,
    ...beats.map((b) => `${VOICE_DIR}/${b}.wav`),
  ],
  // Screen recordings (screen-recording plan §5.2 scoped revisions): the kept plan, and the scoped steps' cursor and
  // hold files. Never analysis.json or redact.js, and never another step's files.
  (beats, comp) => {
    const recorded = (comp?.beats ?? []).filter((b) => b.recording)
    if (!recorded.length) return []
    return [
      'assets/recording/plan.json',
      ...recorded
        .filter((b) => beats.includes(b.id))
        .flatMap((b) => {
          const step = b.recording?.step ?? b.id
          return [`assets/recording/${step}.cursor.js`, `assets/recording/${step}.hold.jpg`]
        }),
    ]
  },
]
export const registerDerivedFiles = (
  fn: (beats: readonly string[], comp: Composition | null) => string[],
) => {
  DERIVED_FILES.push(fn)
}
export const derivedFiles = (beats: readonly string[], comp: Composition | null = null): string[] => [
  ...new Set(DERIVED_FILES.flatMap((fn) => fn(beats, comp))),
]

/**
 * Every parent file outside the derived set that the agent's set lacks or changed, by path. New files are fine (the
 * scoped scenes' images and sound effects). Reference files (the narration bus) belong to the narration lock, and
 * excluded paths (dot folders, feedback/, hydrated library media) never count. The held last frame's still is
 * compared like any other file: a scoped run has no narration step to rewrite it.
 */
export function scopeFileProblems(
  parent: ReadonlyMap<string, string>,
  agent: ReadonlyMap<string, string>,
  derived: readonly string[],
): string[] {
  const skip = new Set(derived)
  const out: string[] = []
  for (const [path, hash] of [...parent].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (skip.has(path) || excluded(path) || isReference(path)) continue
    const mine = agent.get(path)
    if (mine === undefined) out.push(`${path} was deleted; files the other scenes use must stay.`)
    else if (mine !== hash) out.push(`${path} changed; files the other scenes use must stay as they are.`)
  }
  return out
}

/** assets/music/credits.json may only grow: every earlier entry unchanged and in its place. */
export function creditsAppendOnly(parentJson: string | null, agentJson: string | null): string[] {
  if (parentJson === null) return []
  const parse = (s: string | null): unknown[] | null => {
    try {
      const v: unknown = s === null ? null : JSON.parse(s)
      // An array of entries (app/server/lib/openverse-rules.ts readRunCredits).
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const [before, after] = [parse(parentJson), parse(agentJson)]
  if (!before) return []
  if (!after)
    return [`${CREDITS_FILE} is missing or unreadable; keep its entries and add new ones after them.`]
  for (const [n, entry] of before.entries())
    if (JSON.stringify(after[n]) !== JSON.stringify(entry))
      return [`${CREDITS_FILE} changed an existing credit; keep its entries and add new ones after them.`]
  return []
}

/**
 * The voice-over of the scoped scenes, as the re-voice guard checks it: the voice and its other scenes' entries are
 * scopeProblems'; here, each scoped entry that changed says its scoped line and its WAV is as long as voice.json
 * says. `wavBytes` gives a file's size (null when missing). A parent with no voice.json has nothing to check.
 */
export function scopedVoiceProblems(
  i: Pick<ScopeInput, 'parent' | 'agent' | 'beats'>,
  wavBytes: (path: string) => number | null,
): string[] {
  const [was, now] = [i.parent.voice ?? null, i.agent.voice ?? null]
  if (!was) return []
  if (!now) return [`${VOICE_JSON} was removed; the other scenes' voice-over needs it.`]
  const out: string[] = []
  for (const b of now.beats.filter((x) => i.beats.includes(x.beat))) {
    const old = was.beats.find((x) => x.beat === b.beat)
    if (old && JSON.stringify(old) === JSON.stringify(b)) continue
    const line = i.agent.script?.lines.find((l) => l.beat === b.beat)
    if (!line || line.text.replace(/\s+/g, ' ').trim() !== b.text)
      out.push(`Scene "${b.beat}"'s new voice-over doesn't say its line in ${VOICE_SCRIPT}.`)
    const size = wavBytes(b.file)
    const seconds = size === null ? NaN : (size - 44) / 2 / SAMPLE_RATE
    if (!(Math.abs(seconds - b.duration) <= FPS_TOLERANCE))
      out.push(`${b.file} isn't the ${b.duration}s ${VOICE_JSON} says; run npx tsx scripts/voice.ts again.`)
  }
  return out
}

// ───── the HyperFrames scope check (render engines' ScopeCheck) ─────

/**
 * Redo a scene for HyperFrames, over two sets of files (the parent's, the agent's): the splice and every check.
 * `problems` is everything that keeps the render from going ahead (what was put back included); `putBack` is the part
 * the splice fixes by itself; `files` is index.html and summary.json as the splice writes them, whenever it could be
 * built, so check-contract --fix can write them even while other problems remain. render-job and finalize refuse any
 * problem. Matches app/server/domain/engines.ts ScopeCheck (render-engines plan), with putBack and lengthDelta added.
 */
export function hyperframesScopeCheck(
  parent: ReadonlyMap<string, Uint8Array>,
  agent: ReadonlyMap<string, Uint8Array>,
  beats: string[],
): { problems: string[]; putBack: string[]; files: Map<string, Uint8Array> | null; lengthDelta: number } {
  const dec = (m: ReadonlyMap<string, Uint8Array>, p: string) => {
    const b = m.get(p)
    return b ? new TextDecoder().decode(b) : null
  }
  const json = (m: ReadonlyMap<string, Uint8Array>, p: string, who: string, out: string[]): unknown => {
    const s = dec(m, p)
    if (s === null) return null
    try {
      return JSON.parse(s)
    } catch {
      out.push(`${who} ${p} isn't valid JSON.`)
      return null
    }
  }
  const unreadable: string[] = []
  const parentHtml = dec(parent, 'index.html')
  const agentHtml = dec(agent, 'index.html')
  if (parentHtml === null)
    return { problems: ['internal: the parent has no index.html.'], putBack: [], files: null, lengthDelta: 0 }
  if (agentHtml === null)
    return { problems: ['index.html is missing.'], putBack: [], files: null, lengthDelta: 0 }
  const side = (m: ReadonlyMap<string, Uint8Array>, html: string, who: string): ScopeSide => ({
    html,
    summary: (json(m, 'summary.json', who, unreadable) ?? {}) as Summary,
    voice: json(m, VOICE_JSON, who, unreadable) as VoiceFile | null,
    script: json(m, VOICE_SCRIPT, who, unreadable) as VoiceScript | null,
  })
  const i: ScopeInput = {
    parent: side(parent, parentHtml, 'The parent’s'),
    agent: side(agent, agentHtml, 'The composition’s'),
    beats,
    lockedLength: isLockedLength(parentHtml),
  }
  if (unreadable.length) return { problems: unreadable, putBack: [], files: null, lengthDelta: 0 }
  const splice = spliceScoped(i)
  const hashes = (m: ReadonlyMap<string, Uint8Array>) => new Map([...m].map(([p, b]) => [p, sha256(b)]))
  const comp = ((): Composition | null => {
    try {
      return read(load(parentHtml))
    } catch {
      return null
    }
  })()
  const problems = [
    ...splice.problems,
    ...splice.putBack,
    ...scopeFileProblems(hashes(parent), hashes(agent), derivedFiles(beats, comp)),
    ...creditsAppendOnly(dec(parent, CREDITS_FILE), dec(agent, CREDITS_FILE)),
    ...scopedVoiceProblems(i, (p) => agent.get(p)?.byteLength ?? null),
  ]
  const files =
    splice.html === null
      ? null
      : new Map(Object.entries(spliceBytes(splice)).map(([p, s]) => [p, new TextEncoder().encode(s)]))
  return { problems, putBack: splice.putBack, files, lengthDelta: splice.lengthDelta }
}

// ───── which scenes a request may redo ─────

export const MAX_SCOPED_BEATS = 20
const SCOPE_BEAT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/**
 * The beat rules for a scoped revision (plan §4.1): 1-20 ids, each a scene of the parent, not every scene, and not the
 * held last frame or the scene it holds. The beats come back de-duplicated and in the parent's order, so the stored
 * scope, the manifest and the prompt don't depend on the order a client sent. reviseVideo and local mode both use
 * this, so they refuse with the same words.
 */
export function scopeRules(
  parentBeats: readonly { id: string; label: string | null }[],
  requested: readonly string[],
): { beats: string[] } | { refusal: string } {
  const unique = [...new Set(requested)]
  if (unique.length === 0) return { refusal: 'Pick at least one scene to redo.' }
  if (unique.length > MAX_SCOPED_BEATS) return { refusal: `Pick at most ${MAX_SCOPED_BEATS} scenes to redo.` }
  const bad = unique.filter((b) => !SCOPE_BEAT_ID.test(b))
  if (bad.length)
    return {
      refusal: `Scene ids are lowercase letters, digits and dashes: ${bad.map((b) => `"${b.slice(0, 60)}"`).join(', ')}.`,
    }
  const held = parentBeats.some((b) => b.id === HOLD_BEAT)
  const real = parentBeats.filter((b) => b.id !== HOLD_BEAT)
  const unknown = unique.filter((b) => b !== HOLD_BEAT && !real.some((x) => x.id === b))
  if (unknown.length) {
    const list = real.map((b) => (b.label ? `${b.id} (${b.label})` : b.id)).join(', ')
    const names = unknown.map((b) => `"${b}"`).join(', ')
    return {
      refusal: `There's no scene ${names}${unknown.length > 1 ? ' among them' : ''}. This video's scenes: ${list}.`,
    }
  }
  const last = real.at(-1)?.id
  if (unique.includes(HOLD_BEAT) || (held && last !== undefined && unique.includes(last)))
    return {
      refusal:
        'This scene ends the video under your recorded narration and holds its last frame; redo it with a whole-video revision.',
    }
  if (real.every((b) => unique.includes(b.id)))
    return { refusal: "That's every scene: revise the whole video instead (leave out scope)." }
  return { beats: real.map((b) => b.id).filter((id) => unique.includes(id)) }
}

/**
 * Stills of a scoped revision's neighbours, from the parent MP4 (plan §4.3): one per boundary that touches a scoped
 * scene. Before a scoped scene, the previous scene's last frame; after it, the next scene's first frame (what the
 * scene has to cut from and into). A boundary between two scoped scenes gives one still, not two. At most 40.
 * The reconciler and local mode both use this, so they make the same stills.
 */
export function scopeStills(
  beats: readonly { id: string; start: number; duration: number }[],
  scoped: readonly string[],
): { atSec: number; path: string; what: 'before' | 'after'; beat: string }[] {
  const out: { atSec: number; path: string; what: 'before' | 'after'; beat: string }[] = []
  for (let i = 0; i + 1 < beats.length; i++) {
    const left = beats[i]
    const right = beats[i + 1]
    if (!left || !right) continue
    if (scoped.includes(left.id))
      out.push({
        atSec: sec(right.start),
        path: `feedback/scope/${left.id}-after.jpg`,
        what: 'after',
        beat: left.id,
      })
    else if (scoped.includes(right.id))
      out.push({
        atSec: sec(Math.max(0, right.start - 1 / FPS)),
        path: `feedback/scope/${right.id}-before.jpg`,
        what: 'before',
        beat: right.id,
      })
  }
  return out.slice(0, 40)
}
