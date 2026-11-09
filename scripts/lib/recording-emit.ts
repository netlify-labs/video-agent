// recording.ts emit (screen-recording plan §5.2 emit, §5.3; va-rsk5.3.5): a recording scene's markup from the kept plan,
// so the agent never writes keyframe JSON by hand, plus the data files it loads:
// - assets/recording/<step>.cursor.js: the cursor path (scripts/lib/recording-plan.ts cursorPath) simplified at 0.5 px
//   (time-aware Ramer-Douglas-Peucker: a point is kept unless it sits within 0.5 px of where the cursor would be at its
//   time on the line between its neighbours, so pauses survive), in the one-statement form of app/server/lib/recording.ts;
// - assets/recording/redact.js: the plan's locked hidden areas, whole (rewritten on every emit, identical each time);
// - assets/recording/<step>.hold.jpg when the scene is slower than 0.5x: the frame at `out`, JPEG q85, at most 2560 wide.
// `holdsOnly` writes just the stills index.html's held slots name and lack (render-unchanged runs); it never changes
// index.html. The slot follows the contract (app/server/lib/contract.ts recording rules; spike D1: data-start="0", no
// basis attribute, in and out snapped to frames).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load, read, recHoldSrc } from '../../app/server/lib/contract.js'
import { fmt, frames } from '../../app/server/lib/contract-core.js'
import {
  cursorScript,
  cursorSrc,
  LOCKED_SRC,
  RATE_RANGE,
  rateOf,
  redactScript,
  round4,
  STEP_ID,
  type ClickKey,
  type LockedEntry,
  type PlanV1,
} from '../../app/server/lib/recording.js'
import type { Trace } from '../../app/server/lib/recording-trace.js'
import type { Analysis } from './recording-analyze.js'
import { cursorPath, stableJson } from './recording-plan.js'
import { log, StepError } from './run-tools.js'

const SIMPLIFY_PX = 0.5
const HOLD_MAX_WIDTH = 2560
const STILL_WARN_BYTES = 1024 * 1024

/** Time-aware Ramer-Douglas-Peucker on [t, x, y] (fractions), tolerance in source px. */
export function simplifyPath(
  points: ClickKey[],
  width: number,
  height: number,
  tolPx = SIMPLIFY_PX,
): ClickKey[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    const [ta, xa, ya] = points[a] as ClickKey
    const [tb, xb, yb] = points[b] as ClickKey
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const [t, x, y] = points[i] as ClickKey
      const k = tb > ta ? (t - ta) / (tb - ta) : 0
      const d = Math.hypot((x - (xa + (xb - xa) * k)) * width, (y - (ya + (yb - ya) * k)) * height)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst > tolPx) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** The kept plan; a `focus` the agent put back is stripped and the file rewritten (the archive carries no names). */
export function readKeptPlan(path: string): PlanV1 {
  if (!existsSync(path)) throw new StepError(`No plan at ${path}: run recording.ts plan first.`)
  const plan = JSON.parse(readFileSync(path, 'utf8')) as PlanV1
  if (plan.steps.some((s) => s.focus !== undefined)) {
    for (const s of plan.steps) delete s.focus
    writeFileSync(path, stableJson(plan))
    log('recording.emit_strip_focus', { path })
  }
  return plan
}

/** The recording's file in the composition's assets/media/, by media id (any extension). */
function mediaName(videoDir: string, mediaId: string): string | null {
  const dir = join(videoDir, 'assets', 'media')
  return existsSync(dir) ? (readdirSync(dir).find((f) => f.startsWith(`${mediaId}.`)) ?? null) : null
}

/** A JSON attribute value inside single quotes, numbers to 4 places. */
const jsonAttr = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? round4(x) + 0 : x))
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
const textAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function writeFile(videoDir: string, rel: string, body: string | Uint8Array) {
  const path = join(videoDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return { path: rel, bytes: statSync(path).size }
}

/** The plan's locked hidden areas as redact.js entries. */
export const lockedEntries = (plan: PlanV1): LockedEntry[] =>
  plan.locked.map((e) => ({ ...e, origin: e.id.startsWith('s') ? 'setup' : 'trace' }))

/** One frame at `t` as a JPEG (q85, at most 2560 wide). */
function writeStill(file: string, t: number, out: string) {
  mkdirSync(dirname(out), { recursive: true })
  const r = spawnSync('ffmpeg', [
    ...['-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1'],
    ...['-vf', `scale='min(${HOLD_MAX_WIDTH},iw)':-2`, '-q:v', '2', out],
  ])
  if (r.status !== 0) throw new StepError(`ffmpeg hold still: ${r.stderr.toString().slice(-300)}`)
  const bytes = statSync(out).size
  if (bytes > STILL_WARN_BYTES)
    log('recording.emit_warning', { still: out, bytes, note: 'checkpoints over 2 MB are skipped' })
  return bytes
}

export interface EmitOptions {
  videoDir: string
  plan: PlanV1
  step: string
  analysis: Analysis
  trace: Trace | null
  beat?: string | undefined
  label?: string | undefined
  start?: number | undefined
  /** The scene's seconds; default the plan's estimate for the step. */
  duration?: number | undefined
}

/** The scene's markup, with its data files (and hold still) written under videoDir. */
export function emitStep(o: EmitOptions) {
  const started = Date.now()
  const step = o.plan.steps.find((s) => s.id === o.step)
  if (!step)
    throw new StepError(`No step "${o.step}" in the plan (${o.plan.steps.map((s) => s.id).join(', ')}).`)
  if (!STEP_ID.test(step.id))
    throw new StepError(`Step id "${step.id}" must be lowercase letters, digits and dashes.`)
  const beat = o.beat ?? step.id
  const inS = frames(step.in)
  const outS = frames(step.out)
  const span = outS - inS
  if (!(span > 0)) throw new StepError(`Step "${step.id}" needs in before out.`)
  const duration = frames(o.duration ?? o.plan.estimate.steps[step.id] ?? span)
  if (!(duration > 0)) throw new StepError('--duration must be positive.')
  if (span / duration > RATE_RANGE[1] + 1e-9)
    throw new StepError(
      `Step "${step.id}" shows ${fmt(span)} s of the recording, so its scene needs at least ${fmt(Math.ceil((span / RATE_RANGE[1]) * 30 - 1e-6) / 30)} s (${String(RATE_RANGE[1])}x at most).`,
    )
  const hold = span / duration < RATE_RANGE[0] - 1e-9
  const slotDur = hold ? span / RATE_RANGE[0] : duration
  const rate = hold ? RATE_RANGE[0] : rateOf(inS, outS, duration)

  const { width: W, height: H } = o.analysis.source
  const files = [writeFile(o.videoDir, LOCKED_SRC, redactScript(lockedEntries(o.plan)))]
  const path = simplifyPath(cursorPath(o.analysis, o.trace, inS, outS), W, H)
  const style = !path.length ? 'none' : o.trace ? 'smooth' : 'highlight'
  if (path.length) files.push(writeFile(o.videoDir, cursorSrc(step.id), cursorScript(step.id, path)))

  const media = mediaName(o.videoDir, o.plan.mediaId)
  if (hold) {
    if (!media)
      throw new StepError(`The scene needs a held frame, but ${o.plan.mediaId} isn't in assets/media/.`)
    const rel = recHoldSrc(step.id)
    // The frame at out, a frame early so it's inside the file.
    writeStill(join(o.videoDir, 'assets', 'media', media), outS - 1 / 30, join(o.videoDir, rel))
    files.push({ path: rel, bytes: statSync(join(o.videoDir, rel)).size })
  }

  const inside = (t: number) => t >= inS - 1e-9 && t <= outS + 1e-9
  const camera = step.camera.filter((k) => inside(k[0]))
  const clicks = step.clicks.filter((c) => inside(c[0]))
  const redact = step.redact.map((e) => ({ ...e, origin: 'agent' as const }))
  const id = step.id
  const markup = [
    `<section id="${beat}" class="clip va-rec-scene" data-va-beat="${beat}" data-va-label="${textAttr(o.label ?? id)}" data-composition-id="${beat}" data-start="${fmt(o.start ?? 0)}" data-duration="${fmt(duration)}" data-va-authored-duration="${fmt(duration)}" data-track-index="0">`,
    `  <script src="${LOCKED_SRC}"></script>`,
    ...(path.length ? [`  <script src="${cursorSrc(id)}"></script>`] : []),
    `  <div class="va-recording" data-va-recording="${id}" data-va-frame="${o.plan.frameStyle}">`,
    `    <div class="va-stage" data-va-camera='${jsonAttr(camera.length ? camera : [[inS, 0.5, 0.5, 1]])}'>`,
    `      <video id="rec-${id}" data-va-media="${id}-screen" data-va-kind="video" data-va-label="Screen" src="assets/media/${media ?? `${o.plan.mediaId}.mp4`}" data-va-in="${fmt(inS)}" data-va-out="${fmt(outS)}" data-media-start="${fmt(inS)}" data-playback-rate="${String(rate)}" muted data-start="0" data-duration="${fmt(slotDur)}"${hold ? ' data-va-rec-hold="end"' : ''}></video>`,
    ...(hold ? [`      <img class="va-rec-hold" src="${recHoldSrc(id)}" alt="">`] : []),
    `      <div class="va-cursor" data-va-cursor="${style}"${path.length ? ` data-va-path="${id}" data-va-cursor-from="${o.trace ? 'trace' : 'inferred'}"` : ''}></div>`,
    `      <div class="va-clicks" data-va-clicks='${jsonAttr(clicks)}'></div>`,
    `      <div class="va-redact" data-va-redact='${jsonAttr(redact)}' data-va-locked="${LOCKED_SRC}"></div>`,
    `    </div>`,
    `  </div>`,
    `  <p class="va-callout" data-va-text="${beat}-callout" data-va-label="Callout">Describe this step</p>`,
    `  <script>`,
    `    vaBeat('${beat}', (tl, el) => {`,
    `      vaRecording(tl, el)`,
    `      tl.from(el.querySelector('[data-va-text="${beat}-callout"]'), { opacity: 0, y: 12, duration: 0.4 }, 0.6)`,
    `    })`,
    `  </script>`,
    `</section>`,
  ].join('\n')
  log('recording.emit', {
    planStep: id,
    beat,
    files,
    hold: hold ? { seconds: duration - slotDur } : null,
    cursor: { style, points: path.length },
    ms: Date.now() - started,
  })
  return { markup, files, hold, rate, duration, slotDuration: slotDur, cursor: style }
}

/**
 * Writes the still a held scene names (`rel`, assets/recording/<step>.hold.jpg) to `out`, exactly as emit and
 * --holds-only make it: the same ffmpeg command on the same input, so render-job can compare bytes.
 */
export function holdStillTo(videoDir: string, html: string, rel: string, out: string): number {
  const b = read(load(html)).beats.find((x) => x.recording?.hold && recHoldSrc(x.recording.step) === rel)
  const r = b?.recording
  if (!r) throw new StepError(`No held scene names ${rel}.`)
  const file = join(videoDir, r.src)
  if (!existsSync(file)) throw new StepError(`The held scene "${b.id}" needs ${r.src}, which isn't there.`)
  return writeStill(file, r.out - 1 / 30, out)
}

/** Writes the hold stills index.html's held slots name and lack; returns what it wrote. Never changes index.html. */
export function holdsOnly(videoDir: string) {
  const started = Date.now()
  const html = readFileSync(join(videoDir, 'index.html'), 'utf8')
  const written: { path: string; bytes: number }[] = []
  for (const b of read(load(html)).beats) {
    const r = b.recording
    if (!r?.hold) continue
    const rel = recHoldSrc(r.step)
    if (existsSync(join(videoDir, rel))) continue
    written.push({ path: rel, bytes: holdStillTo(videoDir, html, rel, join(videoDir, rel)) })
  }
  log('recording.emit_holds', { files: written, ms: Date.now() - started })
  return written
}
