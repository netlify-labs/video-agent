// The fit guard, narration_modified (plan 2026-11-02 §6.4, bead va-2qq.6.3): in a fit-to-narration run
// (author_from_frozen) the agent rewrites the visuals, so nothing is byte-identical any more, but the recorded narration
// must sound exactly as scripts/narration.ts mixed it. render-job checks video/ before it renders. Expected values come
// from the frozen inputs (the run manifest, the frozen draft prepare-run keeps in FROZEN_DIR, proved against the
// bundle's manifest hash) and the receipt, never from files the agent could have written:
//   - the receipt is this attempt's, for the frozen recipe and takes, mixed at the frozen target; the bus has its digest;
//   - exactly one narration element, a direct child of the root, with exactly the attributes writeNarration gives it
//     at the frozen target (narrationAttrs): no other level, effect chain, automation, group, fade or timing;
//   - no other narration-role audio: nothing else plays the bus (by path or by its bytes) or claims its role or id;
//   - the path from it to the master bus is the frozen one: the root's effect chain, automation and level, and no
//     data-hidden on the way (HyperFrames' effective audio graph: element, group, master; core/audioGroups);
//   - every AI voice (data-va-voice) stays silent: a fit always replaces it (§12 decision 11);
//   - no audible <audio>, or <video> whose soundtrack HyperFrames mixes, overlaps the speech unless the frozen draft
//     already had it audible;
//   - the root lasts exactly the frozen target, the composition passes the contract with the bus's length, the
//     narration's caption cues are the transcript's, and nothing from .va-run/ is in video/.
// The lock persists through later revisions until someone edits the narration (§6.4): checkNarrationKept applies
// the same checks to a revision of a narrated version, against the parent's composition prepare-run keeps and the
// bus's reference digest.
// Trust boundary: as for the keep-visuals guard, this catches accidental agent edits, not a hostile runner.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize as normalizePath } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { bundleManifest, manifestHash } from './bundle-manifest.js'
import { isReference } from './bundle-references.js'
import {
  attr,
  FPS,
  isEl,
  load,
  NARRATION_ID,
  NARRATION_SRC,
  narrationAttrs,
  read,
  speechSeconds,
  validate,
  walk,
  type Summary,
} from './contract.js'
import { groupWords } from './narration-captions.js'
import { readPcm16 } from './narration-cleanup.js'
import { busProblems, leakedTakes, receiptProblems } from './narration-guard.js'
import type { NarrationReceipt, NarrationTranscript } from './narration-run.js'
import type { RunManifest } from './run-manifest.js'
import { SAMPLE_RATE } from './timeline.js'

type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const has = (el: Element, name: string) => el.attrs.some((a) => a.name === name)
const label = (el: Element) => `<${el.tagName}${attr(el, 'id') ? ` id="${attr(el, 'id') ?? ''}"` : ''}>`
const parents = (el: Element): Element[] => {
  const out: Element[] = []
  for (let p = el.parentNode; p && isEl(p); p = p.parentNode) out.push(p)
  return out
}

/** Attributes that change what an element (or a group or the master on its way) contributes to the mix. */
const PATH_ATTRS = [
  'data-hidden',
  'data-fx-chain',
  'data-automation',
  'data-volume',
  'data-audio-group',
  'data-hf-render-id',
  'data-hf-group-render-id',
]
/** The narration's way to the master bus, as data: each ancestor's tag and audio attributes. */
const pathOf = (el: Element) =>
  JSON.stringify(parents(el).map((p) => [p.tagName, ...PATH_ATTRS.map((a) => attr(p, a))]))

const srcPath = (src: string | null) =>
  src ? normalizePath(src.replace(/^\.\//, '')).split('\\').join('/') : ''

/** A video element whose soundtrack HyperFrames mixes (core/audibleVideo: not muted, data-has-audio not "false"). */
const audibleVideo = (el: Element) =>
  el.tagName === 'video' && !has(el, 'muted') && (attr(el, 'data-has-audio') ?? 'true') === 'true'

interface Source {
  el: Element
  /** tag, id and src: the same element in the frozen draft and the run's composition. */
  key: string
  audible: boolean
  /** Seconds of the video it can sound in; [0, Infinity) when its timing can't be read statically. */
  start: number
  end: number
}

/**
 * The mixed sources of a document (HyperFrames' parseAudioElements, conservatively): every <audio> with an id and a
 * src, and every <video> whose soundtrack is audible. Silent when hidden (itself or an ancestor), at data-volume 0, or
 * in a group that is hidden or at volume 0. Times are absolute: its own data-start plus every enclosing composition's.
 */
function sourcesOf(doc: ParentNode): Source[] {
  const all = [...walk(doc)]
  const groups = new Map(
    all.filter((e) => e.tagName === 'hf-audio-group' && attr(e, 'id')).map((e) => [attr(e, 'id') ?? '', e]),
  )
  const num = (v: string | null) => (v === null || v.trim() === '' ? NaN : Number(v))
  const out: Source[] = []
  for (const el of all) {
    const src = attr(el, 'src')
    if (!src || !((el.tagName === 'audio' && attr(el, 'id')) || el.tagName === 'video')) continue
    const group = groups.get(attr(el, 'data-hf-group-render-id') ?? attr(el, 'data-audio-group') ?? '')
    const silent =
      (el.tagName === 'video' && !audibleVideo(el)) ||
      [el, ...parents(el)].some((e) => has(e, 'data-hidden')) ||
      num(attr(el, 'data-volume')) === 0 ||
      (group !== undefined && (has(group, 'data-hidden') || num(attr(group, 'data-volume')) === 0))
    // Enclosing compositions (beats) offset a clip's clock; the root's own start is the video's 0.
    const clocks = parents(el).filter((p) => attr(p, 'data-composition-id') !== null)
    const offsets = clocks.slice(0, -1).map((p) => num(attr(p, 'data-start')) || 0)
    const own = attr(el, 'data-start') === null ? 0 : num(attr(el, 'data-start'))
    const start = offsets.reduce((a, b) => a + b, own)
    const dur = num(attr(el, 'data-duration'))
    const end = num(attr(el, 'data-end'))
    const known = Number.isFinite(start) && offsets.every(Number.isFinite)
    out.push({
      el,
      key: `${el.tagName}#${attr(el, 'id') ?? ''}@${srcPath(src)}`,
      audible: !silent,
      start: known ? start : 0,
      end: !known
        ? Infinity
        : Number.isFinite(end)
          ? start - own + end
          : Number.isFinite(dur)
            ? start + dur
            : Infinity,
    })
  }
  return out
}

/** Elements that are, or pose as, the narration: its role, layer, id or render id, or a src that is the bus. */
const narrationLike = (doc: ParentNode) =>
  [...walk(doc)].filter(
    (e) =>
      attr(e, 'data-va-audio') === 'narration' ||
      attr(e, 'data-va-layer') === 'narration' ||
      attr(e, 'id') === NARRATION_ID ||
      attr(e, 'data-hf-render-id') === NARRATION_ID ||
      srcPath(attr(e, 'src')) === NARRATION_SRC,
  )

const sortedAttrs = (as: { name: string; value: string }[]) =>
  JSON.stringify([...as].map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort())

/**
 * Checks a fit run's video/ (after scripts/narration.ts, the transcription and the agent's authoring) against the
 * frozen inputs and the receipt. Returns the problems (empty when the run may render).
 */
export function checkNarrationModified(
  frozenDir: string,
  videoDir: string,
  receipt: NarrationReceipt | null,
  m: RunManifest,
  transcript: NarrationTranscript | null = null,
): string[] {
  const n = m.bundle?.narration
  if (m.kind !== 'author_from_frozen' || !m.bundle || !n)
    return ['This run is not a fit to recorded narration.']
  if (!receipt) return ['scripts/narration.ts left no receipt: it has to run before the agent authors.']
  const problems = [...receiptProblems(receipt, m), ...busProblems(videoDir, receipt)]
  if (receipt.target.samples !== n.targetSamples || receipt.target.manifestSamples !== n.targetSamples)
    problems.push(
      `The narration was mixed for ${receipt.target.samples / SAMPLE_RATE}s, not the frozen target of ${n.targetSamples / SAMPLE_RATE}s.`,
    )
  const leaked = leakedTakes(videoDir, receipt, m)
  if (leaked.length) problems.push(`video/ holds recorded narration from .va-run/: ${leaked.join(', ')}.`)

  // The frozen draft, proved by the bundle's manifest hash before anything is read from it.
  const frozenIndex = join(frozenDir, 'index.html')
  if (!existsSync(frozenIndex))
    return [...problems, `The frozen draft prepare-run keeps in ${frozenDir} is missing.`]
  const kept = bundleManifest(frozenDir).files.filter((f) => !isReference(f.path))
  if (manifestHash(kept, []) !== m.bundle.manifestHash)
    return [...problems, `The frozen draft in ${frozenDir} isn't the bundle this run restored.`]
  const target = n.targetSamples / SAMPLE_RATE
  const speech = n.op.tracks.narration.muted ? [] : receipt.spans
  return [
    ...problems,
    ...lockProblems(videoDir, readFileSync(frozenIndex, 'utf8'), {
      attrs: narrationAttrs(target, speech),
      speech: speechSeconds(speech, target),
      seconds: target,
      bus: receipt.bus,
      voices: 'muted',
      cues: transcript?.status === 'ok' ? groupWords(transcript.words) : [],
      what: 'a fit',
    }),
  ]
}

/** What the locked narration must look like, from frozen inputs and the receipt (or the restored source). */
interface Lock {
  /** The narration element's exact attributes. */
  attrs: { name: string; value: string }[]
  /** Where it speaks, in seconds of the video. */
  speech: [number, number][]
  /** The root's exact length. */
  seconds: number
  bus: { sha256: string; samples: number }
  /** AI voices: always muted (a fit replaces them), or as the frozen composition had them (a revision). */
  voices: 'muted' | 'frozen'
  /** summary.json's narration caption cues. */
  cues: unknown[]
  what: string
}

/** The checks a locked narration shares, fit or revision: element, path, sources, length, contract, cues. */
function lockProblems(videoDir: string, frozenHtml: string, lock: Lock): string[] {
  const actualPath = join(videoDir, 'index.html')
  const summaryPath = join(videoDir, 'summary.json')
  if (!existsSync(actualPath) || !existsSync(summaryPath))
    return ['video/index.html or video/summary.json is missing.']
  const actual = readFileSync(actualPath, 'utf8')
  let summary: Summary
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
  } catch {
    return ["video/summary.json can't be read."]
  }
  const problems: string[] = []
  const doc = parse(actual)
  const frozen = parse(frozenHtml)
  // The master bus: the outermost composition (core/audioGroups resolveMasterBusElement), as contract.load finds it.
  const root = [...walk(doc)].find((e) => attr(e, 'data-composition-id') !== null)
  if (!root) return ['video/index.html has no composition root.']

  // Exactly one narration element, exactly as the narration step wrote it.
  const buses = narrationLike(doc)
  const bus = buses.length === 1 ? buses[0] : undefined
  if (!bus)
    problems.push(
      buses.length
        ? `There are ${buses.length} narration elements (${buses.map(label).join(', ')}); keep the one <audio id="${NARRATION_ID}"> the narration step wrote.`
        : `The narration element <audio id="${NARRATION_ID}"> was removed.`,
    )
  else {
    if (bus.tagName !== 'audio' || bus.parentNode !== root)
      problems.push(`The narration must stay an <audio id="${NARRATION_ID}"> directly in the root.`)
    if (sortedAttrs(bus.attrs) !== sortedAttrs(lock.attrs)) {
      const got = new Map(bus.attrs.map((a) => [a.name, a.value]))
      const diff = [
        ...lock.attrs.filter((a) => got.get(a.name) !== a.value).map((a) => a.name),
        ...bus.attrs.filter((a) => !lock.attrs.some((w) => w.name === a.name)).map((a) => a.name),
      ]
      problems.push(
        `The narration element changed (${[...new Set(diff)].join(', ')}): its level, effects, automation, timing and speech are locked.`,
      )
    }
    const was = narrationLike(frozen)[0]
    if (was && pathOf(bus) !== pathOf(was))
      problems.push(
        "The narration's path to the master bus changed (an effect chain, automation, level, group or data-hidden on the root or around it).",
      )
  }

  // Sources: AI voices as the lock says, nothing else plays the bus, and nothing new sounds over the speech.
  const busFile = join(videoDir, NARRATION_SRC)
  const busSize = existsSync(busFile) ? statSync(busFile).size : -1
  const frozenAudible = new Set(
    sourcesOf(frozen)
      .filter((s) => s.audible)
      .map((s) => s.key),
  )
  for (const s of sourcesOf(doc)) {
    if (s.el === bus) continue
    if (attr(s.el, 'data-va-voice') !== null && lock.voices === 'muted') {
      if (s.audible)
        problems.push(
          `The AI voice ${label(s.el)} plays: a fit replaces the AI voice-over, so every data-va-voice stays muted.`,
        )
      continue
    }
    // A copy of the bus under another name is the narration twice.
    const file = join(videoDir, srcPath(attr(s.el, 'src')))
    if (
      s.audible &&
      existsSync(file) &&
      statSync(file).isFile() &&
      statSync(file).size === busSize &&
      sha256(readFileSync(file)) === lock.bus.sha256
    ) {
      problems.push(`${label(s.el)} plays a copy of the narration bus.`)
      continue
    }
    if (!s.audible || frozenAudible.has(s.key)) continue
    const over = lock.speech.find(([a, b]) => s.start < b && s.end > a)
    if (over)
      problems.push(
        `${label(s.el)} is new and sounds over the narration's speech at ${over[0]}-${over[1]}s; leave it out, move it to a pause, or mute it (data-volume="0", or muted on a <video>).`,
      )
  }

  // The root lasts exactly the narration's length, and the composition keeps the contract with the bus's.
  let duration = NaN
  try {
    duration = read(load(actual)).duration
  } catch {
    // reported below
  }
  if (Math.round(duration * FPS) !== Math.round(lock.seconds * FPS))
    problems.push(
      `The beats add up to ${duration}s; ${lock.what} must last exactly ${lock.seconds}s (${Math.round(lock.seconds * FPS)} frames at ${FPS} fps).`,
    )
  for (const v of validate(actual, summary, { narration: { busSamples: lock.bus.samples } }))
    problems.push(`Contract: ${v}`)
  // The narration's captions are as transcribed (absolute times: retiming the beats doesn't move them).
  const cues = (summary.captions ?? []).filter((c) => c.narration)
  if (JSON.stringify(cues) !== JSON.stringify(lock.cues))
    problems.push("summary.json's narration captions aren't the ones transcribed from the narration.")
  return problems
}

/**
 * Checks a revision of a version with recorded narration (plan 2026-11-02 §6.4 "Locks persist ... through later
 * revisions"): the agent changes what was asked, but the narration stays as the parent had it. Expected values come
 * from the restored source prepare-run keeps in FROZEN_DIR and the bus's reference digest in the run manifest: the
 * same narration element and path, the same bus at the same length, the parent's narration captions, and no new sound
 * over its speech (AI voices stay as they were). Returns the problems (empty when the run may render).
 */
export function checkNarrationKept(frozenDir: string, videoDir: string, m: RunManifest): string[] {
  const ref = m.source?.references?.find((r) => r.path === NARRATION_SRC)
  if (m.kind !== 'revision' || !ref) return ['This run is not a revision of a narrated version.']
  const frozenIndex = join(frozenDir, 'index.html')
  const frozenSummary = join(frozenDir, 'summary.json')
  if (!existsSync(frozenIndex) || !existsSync(frozenSummary))
    return [`The parent's composition prepare-run keeps in ${frozenDir} is missing.`]
  const html = readFileSync(frozenIndex, 'utf8')
  const was = narrationLike(parse(html))[0]
  if (!was) return ["The parent's composition has no narration element to keep."]
  const problems: string[] = []
  const busPath = join(videoDir, NARRATION_SRC)
  let samples = NaN
  if (!existsSync(busPath)) problems.push(`video/${NARRATION_SRC} is missing.`)
  else {
    const bytes = readFileSync(busPath)
    if (sha256(bytes) !== ref.sha256)
      problems.push(`video/${NARRATION_SRC} isn't the parent's narration bus.`)
    try {
      samples = readPcm16(bytes).samples.length
    } catch {
      problems.push(`video/${NARRATION_SRC} isn't a 24 kHz PCM16 WAV.`)
    }
  }
  if (!Number.isFinite(samples)) return problems
  let speech: [number, number][] = []
  try {
    speech = JSON.parse(attr(was, 'data-va-speech') ?? '[]') as [number, number][]
  } catch {
    // an unreadable frozen speech list locks nothing extra; the element check still compares it
  }
  let cues: unknown[]
  try {
    cues = ((JSON.parse(readFileSync(frozenSummary, 'utf8')) as Summary).captions ?? []).filter(
      (c) => c.narration,
    )
  } catch {
    return [...problems, `The parent's summary.json in ${frozenDir} can't be read.`]
  }
  return [
    ...problems,
    ...lockProblems(videoDir, html, {
      attrs: was.attrs,
      speech,
      seconds: samples / SAMPLE_RATE,
      bus: { sha256: ref.sha256, samples },
      voices: 'frozen',
      cues,
      what: 'this video',
    }),
  ]
}
