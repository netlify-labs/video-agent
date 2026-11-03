// The keep-visuals guard (plan 2026-11-02 §6.3, modelled on checkRevoiced): render-job checks a narrated
// render-unchanged run's video/ against the frozen bundle and scripts/narration.ts's receipt before it renders.
// Expected values come from the frozen inputs (the run manifest, prepare-run's FROZEN_DIR copies) and the receipt,
// never from files the agent could have written. The receipt is trusted for what only cleanup knows (the speech spans)
// and checked against everything else. Trust boundary: as for re-voicing, this catches accidental agent edits, not a
// hostile runner (the runner is the trust model's boundary, 2026-10-31 plan "Roles and privacy (R)", rule 5).
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { bundleManifest, manifestHash } from './bundle-manifest.js'
import { isReference } from './bundle-references.js'
import {
  FPS,
  HOLD_STILL_SRC,
  holdBeatOf,
  load,
  NARRATION_ID,
  NARRATION_SRC,
  read,
  save,
  speechSeconds,
  validate,
  type Summary,
} from './contract.js'
import { readPcm16 } from './narration-cleanup.js'
import {
  mayChange,
  narrationTransform,
  optionalFrozenFilesFor,
  type NarrationReceipt,
} from './narration-run.js'
import { expectRevoiced, FROZEN_DIR } from './revoice.js'
import type { RunManifest } from './run-manifest.js'
import { SAMPLE_RATE } from './timeline.js'

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** parse5's serialization, so quoting and entity spelling don't count as an edit. */
const normalize = (html: string) => save(load(html))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const audioCount = (html: string) => (html.match(/<audio\b/gi) ?? []).length

/** data-va-speech of the root's narration element, as written (null without one). */
function speechAttr(html: string): string | null {
  const { root } = load(html)
  for (const n of root.childNodes as { tagName?: string; attrs?: { name: string; value: string }[] }[]) {
    if (n.tagName !== 'audio' || !n.attrs?.some((a) => a.name === 'id' && a.value === NARRATION_ID)) continue
    return n.attrs.find((a) => a.name === 'data-va-speech')?.value ?? null
  }
  return null
}

/** video/ paths that hold a take's bytes or sit under a .va-run/ (symlinks included), whatever the hash excludes. */
function leakedTakes(videoDir: string, receipt: NarrationReceipt, m: RunManifest): string[] {
  const takes = new Set([
    ...(m.bundle?.narration?.takes ?? []).map((t) => t.sha256),
    ...receipt.inputs.flatMap((t) => [t.sha256, t.wavSha256]),
  ])
  const sizes = new Set([
    ...(m.bundle?.narration?.takes ?? []).map((t) => t.bytes),
    ...receipt.inputs.map((t) => 44 + t.samples * 2),
  ])
  const bad: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = relative(videoDir, full).split(sep).join('/')
      const st = lstatSync(full)
      if (name === '.va-run') bad.push(rel)
      else if (st.isDirectory()) {
        if (name !== 'node_modules') walk(full)
      } else if (st.isFile() && sizes.has(st.size)) {
        const digest = sha256(readFileSync(full))
        // A bypassed single-clip bus can equal its take: the bus narration.ts wrote is the one allowed copy.
        if (takes.has(digest) && !(rel === NARRATION_SRC && digest === receipt.bus.sha256)) bad.push(rel)
      }
    }
  }
  if (existsSync(videoDir)) walk(videoDir)
  return bad
}

/**
 * Checks a narrated video/ (after any re-voice and scripts/narration.ts) against the frozen bundle and the receipt:
 *   - the receipt is this attempt's, for the frozen recipe, from exactly the frozen takes;
 *   - video/assets/narration/bus.wav has the receipt's digest and sample count, at the length it was mixed for;
 *   - every other file is byte-identical to the frozen bundle (the re-voice exceptions too, when there are lines to
 *     re-voice), with the files the steps write (narration-run.ts mayChange) recomputed instead:
 *   - index.html is the frozen one (re-voiced, when there are lines) with exactly the narration transform
 *     (narrationTransform over the receipt's spans), and its data-va-speech is speechSeconds(receipt.spans);
 *   - summary.json is the frozen one with only the narration's cues (none until captions land, va-2qq.3.13);
 *   - with a held last frame (the frozen data-va-hold beat), video/assets/hold/last.png is the PNG the receipt says
 *     the run rendered of the base's last frame; without one there is no still;
 *   - the narrated composition passes the contract with the bus's length, and nothing from .va-run/ is in video/.
 * Returns the problems (empty when the run may render).
 */
export function checkNarration(
  frozenDir: string,
  videoDir: string,
  receipt: NarrationReceipt | null,
  m: RunManifest,
): string[] {
  const n = m.bundle?.narration
  if (!m.bundle || !n) return ['This render has no recorded narration to check.']
  if (!receipt) return ['scripts/narration.ts left no receipt: it has to run before render-job.']
  const problems: string[] = []

  // The receipt: this attempt, the frozen recipe and takes.
  if (receipt.attemptId !== m.attemptId || receipt.jobId !== m.jobId)
    problems.push(
      `The narration receipt is from attempt ${receipt.attemptId}, not this run's (${m.attemptId}).`,
    )
  if (receipt.pipeline !== n.recipe.pipeline || receipt.recipe.cleanup !== n.recipe.cleanup)
    problems.push("The narration receipt's recipe isn't the one this render froze.")
  const takes = (xs: { mediaId: string; sha256: string }[]) =>
    xs
      .map((t) => `${t.mediaId}:${t.sha256}`)
      .sort()
      .join()
  if (takes(receipt.inputs) !== takes(n.takes))
    problems.push("The narration receipt's takes aren't the ones this render froze.")

  // The bus.
  const busPath = join(videoDir, NARRATION_SRC)
  if (!existsSync(busPath)) problems.push(`video/${NARRATION_SRC} is missing.`)
  else {
    const bytes = readFileSync(busPath)
    if (sha256(bytes) !== receipt.bus.sha256)
      problems.push(`video/${NARRATION_SRC} isn't the bus scripts/narration.ts wrote.`)
    let samples = NaN
    try {
      samples = readPcm16(bytes).samples.length
    } catch {
      // reported below
    }
    if (samples !== receipt.bus.samples || receipt.bus.samples !== receipt.target.samples)
      problems.push(`video/${NARRATION_SRC} has ${samples} samples; the receipt says ${receipt.bus.samples}.`)
  }

  // Every file the steps don't write, and the frozen index.html and summary.json they start from.
  let base: { html: string; summary: Summary } | undefined
  if (m.bundle.revoice) {
    const r = expectRevoiced(videoDir, frozenDir, m.bundle.revoice)
    problems.push(...r.problems)
    base = r.want
  } else {
    const frozen = (p: string) => (existsSync(join(frozenDir, p)) ? readFileSync(join(frozenDir, p)) : null)
    const html = frozen('index.html')
    const summary = frozen('summary.json')
    if (!html || !summary)
      return [...problems, `The frozen copies prepare-run keeps in ${FROZEN_DIR} are missing.`]
    // The kept files plus the frozen copies must hash to the bundle's manifest, which also proves the copies.
    const kept = bundleManifest(videoDir).files.filter(
      (f) => !isReference(f.path) && !mayChange(f.path, m.bundle),
    )
    // A base's held-frame still, when the bundle had one, counts as frozen too (the narration step replaces it).
    const files = [
      ...kept,
      { path: 'index.html', sha256: sha256(html) },
      { path: 'summary.json', sha256: sha256(summary) },
      ...optionalFrozenFilesFor(m.bundle).flatMap((p) => {
        const b = frozen(p)
        return b ? [{ path: p, sha256: sha256(b) }] : []
      }),
    ]
    if (manifestHash(files, []) !== m.bundle.manifestHash)
      problems.push('Files other than the narration changed since prepare-run restored video/.')
    try {
      base = { html: html.toString('utf8'), summary: JSON.parse(summary.toString('utf8')) as Summary }
    } catch {
      problems.push(`The frozen summary.json in ${FROZEN_DIR} can't be read.`)
    }
  }

  const leaked = leakedTakes(videoDir, receipt, m)
  if (leaked.length) problems.push(`video/ holds recorded narration from .va-run/: ${leaked.join(', ')}.`)
  if (!base) return problems

  // index.html and summary.json: exactly the narration transform of the (re-voiced) frozen files.
  const actualPath = join(videoDir, 'index.html')
  const summaryPath = join(videoDir, 'summary.json')
  if (!existsSync(actualPath) || !existsSync(summaryPath))
    return [...problems, 'video/index.html or video/summary.json is missing.']
  const actual = readFileSync(actualPath, 'utf8')
  let actualSummary: unknown
  try {
    actualSummary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  } catch {
    return [...problems, "video/summary.json can't be read."]
  }
  let want: { html: string; summary: Summary }
  try {
    want = narrationTransform(base.html, base.summary, n.op, receipt.spans)
  } catch (e) {
    return [
      ...problems,
      `The narration can't be written into the frozen composition: ${e instanceof Error ? e.message : String(e)}`,
    ]
  }
  // The held frame: exactly the still the run rendered when the composition holds its last frame, none otherwise.
  const hold = holdBeatOf(load(want.html))
  const stillPath = join(videoDir, HOLD_STILL_SRC)
  if (hold) {
    const at = Math.round(((Math.round(hold.start * FPS) - 1) / FPS) * 1e6) / 1e6
    const still = existsSync(stillPath) ? readFileSync(stillPath) : null
    if (!receipt.hold || receipt.hold.atSeconds !== at || receipt.hold.holdSeconds !== hold.duration)
      problems.push("The narration receipt has no still of the held frame's base frame.")
    else if (!still || sha256(still) !== receipt.hold.sha256 || !PNG.every((b, i) => still[i] === b))
      problems.push(`video/${HOLD_STILL_SRC} isn't the held frame scripts/narration.ts rendered.`)
  } else {
    if (receipt.hold)
      problems.push('The narration receipt has a held-frame still, but the composition holds no frame.')
    if (existsSync(stillPath))
      problems.push(`video/${HOLD_STILL_SRC} is there, but the composition holds no frame.`)
  }

  let duration = NaN
  try {
    duration = read(load(actual)).duration
  } catch {
    // the comparison below reports it
  }
  if (Math.round(duration * SAMPLE_RATE) !== receipt.target.samples)
    problems.push(
      `The composition is ${duration}s, but the narration was mixed for ${receipt.target.samples / SAMPLE_RATE}s.`,
    )
  let speech: unknown = null
  try {
    speech = JSON.parse(speechAttr(actual) ?? 'null')
  } catch {
    // not a list: reported as a mismatch
  }
  if (!same(speech, speechSeconds(receipt.spans, duration)))
    problems.push("The narration's data-va-speech isn't the speech the receipt measured.")
  if (audioCount(actual) !== audioCount(want.html))
    problems.push(
      `index.html has ${audioCount(actual)} <audio> elements; the narration step makes ${audioCount(want.html)}.`,
    )
  if (normalize(actual) !== normalize(want.html))
    problems.push(
      `index.html differs from the frozen composition${m.bundle.revoice ? ' with the re-voiced lines' : ''} with the narration written in.`,
    )
  if (!same(actualSummary, want.summary))
    problems.push(
      `summary.json differs from the frozen captions${m.bundle.revoice ? ' with the re-voiced lines' : ''} with the narration's.`,
    )
  for (const v of validate(actual, actualSummary as Summary, {
    narration: { busSamples: receipt.bus.samples },
  }))
    problems.push(`Contract: ${v}`)
  return problems
}
