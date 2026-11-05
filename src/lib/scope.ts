// Redo a scene (docs/plans/2026-11-04-regenerate-beat.md §4.5): the splice. A scoped revision may change only the
// scenes (beats) it names. Rather than diffing the agent's file against a list of what's allowed, the splice builds what
// the composition must be: the parent, with the agent's scoped beats put in, re-laid end to end (frozen beats keep their
// lengths verbatim), later captions shifted, the music's ducking rewritten. The render uses the splice's bytes, so what
// people get is what was checked; check-contract --fix, render-job and finalize all call this, in the same style as
// src/lib/revoice.ts. Pure: the callers log.
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
import { fmt, frames, shiftCues, syncCaptionsFor } from './contract-core.js'
import { scopedScriptProblems } from './scope-script.js'
import { scopedStyleProblems } from './scope-style.js'
import { voiceCaptions, type VoiceFile, type VoiceScript } from './voice.js'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

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
  const putBack = comparePutBack(i, { html, summary })
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

/**
 * Every difference between the agent's file and the splice outside the scope, in plain words. Filled in by
 * va-8cy4.2.5 (scopeProblems, the semantic compare); until then nothing is reported as put back.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function comparePutBack(_i: ScopeInput, _splice: { html: string; summary: Summary }): string[] {
  return []
}
