// recording.ts analyze (screen-recording plan §5.2): what happens in a screen recording, as times and positions only.
// One ffmpeg decode feeds two branches (spike D3): scdet at 640 wide for scene changes, and grey 320-wide frames at
// 10 fps that Node differences frame to frame. From the differences: idle stretches (no change for over 1.2 s;
// freezedetect misses cursor-only motion, D3), the largest changed box per frame (activity), an inferred cursor (a
// small blob that moves and keeps its size for at least 0.5 s) and inferred clicks (the cursor stops and a region near
// it changes within 400 ms). With a pointer trace, the cursor and clicks come from the trace instead.
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, MediaError } from '../../src/lib/media/classify.js'
import { sha256Hex } from '../../src/lib/crypto.js'
import type { Trace } from '../../src/lib/recording-trace.js'
import { log, StepError } from './run-tools.js'

/** Goes up whenever a rule here changes, so cached analyses are made again. */
export const ANALYZER_VERSION = 'analyze-1'
export const SCDET_THRESHOLD = 10
const DIFF_FPS = 10
const DIFF_WIDTH = 320
/** A grey level difference this big counts as a change. */
const DIFF_LEVEL = 18
const IDLE_MIN_S = 1.2
/** A cursor blob: 8-64 source px across (a 24 px cursor plus a frame's movement). */
const CURSOR_PX: [number, number] = [8, 64]
const CURSOR_MIN_S = 0.5
const CLICK_WINDOW_S = 0.4
/** How near the cursor's stop a change must be to count as its click, as a fraction of the frame width. */
const CLICK_NEAR = 0.15

export interface Analysis {
  v: 1
  sha256: string
  analyzer: string
  source: { width: number; height: number; fps: number; duration: number }
  cursorSource: 'trace' | 'inferred' | 'none'
  idle: { start: number; end: number }[]
  scenes: number[]
  /** Per changed frame, the largest changed box: [t, x, y, w, h] in source px. */
  activity: [number, number, number, number, number][]
  /** Cursor centre over time: [t, x, y] in source px (10 Hz at most). */
  cursor: [number, number, number][]
  clicks: { t: number; x: number; y: number; source: 'trace' | 'inferred' }[]
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  n: number
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Refuses a file that isn't a normalized recording (§4.2), with classify's reason. */
export function checkNormalized(bytes: Uint8Array) {
  try {
    return classify(bytes, { role: 'screen-recording' })
  } catch (e) {
    if (e instanceof MediaError) throw new StepError(`This recording isn't normalized: ${e.message}`)
    throw e
  }
}

/** Connected components (4-neighbour) of a changed-pixel mask, as boxes. */
function components(mask: Uint8Array, w: number, h: number): Box[] {
  const labels = new Int32Array(w * h)
  const parent: number[] = [0]
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a] ?? a] ?? a
    return a
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      const up = y ? (labels[i - w] ?? 0) : 0
      const left = x ? (labels[i - 1] ?? 0) : 0
      if (!up && !left) {
        parent.push(parent.length)
        labels[i] = parent.length - 1
      } else if (up && left) {
        const a = find(up)
        const b = find(left)
        labels[i] = Math.min(a, b)
        parent[Math.max(a, b)] = Math.min(a, b)
      } else labels[i] = up || left
    }
  const boxes = new Map<number, Box>()
  for (let i = 0; i < w * h; i++) {
    const l = labels[i] ?? 0
    if (!l) continue
    const root = find(l)
    const x = i % w
    const y = (i / w) | 0
    const b = boxes.get(root)
    if (!b) boxes.set(root, { x0: x, y0: y, x1: x, y1: y, n: 1 })
    else {
      b.x0 = Math.min(b.x0, x)
      b.y0 = Math.min(b.y0, y)
      b.x1 = Math.max(b.x1, x)
      b.y1 = Math.max(b.y1, y)
      b.n++
    }
  }
  return [...boxes.values()].sort((a, b) => b.n - a.n || a.y0 - b.y0 || a.x0 - b.x0)
}

interface FrameChange {
  t: number
  boxes: Box[]
}

/** One decode: scdet events to a metadata file, grey frames differenced in Node. */
async function decode(file: string, width: number, height: number) {
  const w = DIFF_WIDTH
  const h = Math.round((w * height) / width / 2) * 2
  const meta = join(tmpdir(), `va-scdet-${process.pid}-${Date.now()}.txt`)
  const graph = `[0:v]split=2[a][b];[a]scale=640:-2,scdet=threshold=${SCDET_THRESHOLD},metadata=mode=print:file=${meta.replace(/:/g, '\\:')},nullsink;[b]fps=${DIFF_FPS},scale=${w}:${h}:flags=area,format=gray[g]`
  const ff = spawn(
    'ffmpeg',
    ['-loglevel', 'error', '-i', file, '-filter_complex', graph, '-map', '[g]', '-f', 'rawvideo', '-'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  ff.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  const size = w * h
  const changes: FrameChange[] = []
  let prev: Buffer | null = null
  let pending: Buffer = Buffer.alloc(0)
  let frame = 0
  const mask = new Uint8Array(size)
  const handle = (cur: Buffer) => {
    if (prev) {
      for (let i = 0; i < size; i++) mask[i] = Math.abs((cur[i] ?? 0) - (prev[i] ?? 0)) >= DIFF_LEVEL ? 1 : 0
      const boxes = components(mask, w, h)
      if (boxes.length) changes.push({ t: r3(frame / DIFF_FPS), boxes })
    }
    prev = Buffer.from(cur)
    frame++
  }
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= size) {
      handle(pending.subarray(0, size))
      pending = pending.subarray(size)
    }
  }
  const code = await new Promise<number | null>((r) => ff.on('close', r))
  if (code !== 0) throw new StepError(`ffmpeg couldn't decode the recording: ${stderr.trim()}`)
  let scdet = ''
  try {
    scdet = readFileSync(meta, 'utf8')
  } catch {
    // No scene changes were printed.
  }
  rmSync(meta, { force: true })
  const scenes = [...scdet.matchAll(/lavfi\.scd\.time[:=] ?([\d.]+)/g)].map((m) => r3(Number(m[1])))
  return { changes, scenes, frames: frame, scale: width / w }
}

/**
 * Idle: gaps between changed frames longer than IDLE_MIN_S, from the last change to halfway between the last unchanged
 * sample and the next change (motion begins somewhere between the two samples).
 */
function idleSpans(changes: FrameChange[], duration: number) {
  const out: { start: number; end: number }[] = []
  const times = [0, ...changes.map((c) => c.t), duration + 0.5 / DIFF_FPS]
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1] ?? 0
    const end = r3((times[i] ?? 0) - 0.5 / DIFF_FPS)
    if (end - start > IDLE_MIN_S) out.push({ start, end: Math.min(end, r3(duration)) })
  }
  return out
}

/**
 * The inferred cursor: runs of small moving blobs lasting at least CURSOR_MIN_S, with the stops that end them. A
 * frame difference spans where the cursor was and where it is, so its position is the blob's leading edge in the
 * direction it moves, less half the cursor (the run's smallest blob).
 */
function inferCursor(changes: FrameChange[], scale: number) {
  const px = (b: Box) => [(b.x1 - b.x0 + 1) * scale, (b.y1 - b.y0 + 1) * scale] as const
  const small = (b: Box) => {
    const [bw, bh] = px(b)
    return bw >= CURSOR_PX[0] && bw <= CURSOR_PX[1] && bh >= CURSOR_PX[0] && bh <= CURSOR_PX[1]
  }
  /** One difference blob in source px. */
  type Step = { t: number; x0: number; y0: number; x1: number; y1: number; mx: number; my: number }
  const step = (t: number, b: Box): Step => {
    const x0 = b.x0 * scale
    const y0 = b.y0 * scale
    const x1 = (b.x1 + 1) * scale
    const y1 = (b.y1 + 1) * scale
    return { t, x0, y0, x1, y1, mx: (x0 + x1) / 2, my: (y0 + y1) / 2 }
  }
  const runs: Step[][] = []
  let run: Step[] = []
  for (const c of changes) {
    let last = run.at(-1)
    if (last && c.t - last.t > 0.3 + 1e-6) {
      runs.push(run)
      run = []
      last = undefined
    }
    // A fast cursor leaves two blobs, where it was and where it is: pick the one nearest where it should be now
    // (last position plus its velocity), or, with no velocity yet, the one farthest from where it was.
    const before = run.at(-2)
    const want = last && before ? { x: 2 * last.mx - before.mx, y: 2 * last.my - before.my } : null
    const blobs = c.boxes.filter(small).map((b) => step(c.t, b))
    const dist = (s: Step, p: { x: number; y: number }) => Math.hypot(s.mx - p.x, s.my - p.y)
    const pick = want
      ? blobs.sort((a, b) => dist(a, want) - dist(b, want))[0]
      : last
        ? blobs.sort((a, b) => dist(b, { x: last.mx, y: last.my }) - dist(a, { x: last.mx, y: last.my }))[0]
        : blobs[0]
    if (pick) run.push(pick)
  }
  if (run.length) runs.push(run)
  const kept = runs.filter((r) => (r.at(-1)?.t ?? 0) - (r[0]?.t ?? 0) >= CURSOR_MIN_S - 1e-6)
  const cursor: [number, number, number][] = []
  const stops: { t: number; x: number; y: number }[] = []
  for (const r of kept) {
    const sw = Math.min(...r.map((s) => s.x1 - s.x0))
    const sh = Math.min(...r.map((s) => s.y1 - s.y0))
    r.forEach((s, i) => {
      // Direction of travel from the neighbouring blobs (the next one for the first step).
      const a = r[i - 1] ?? s
      const b = i > 0 ? s : (r[i + 1] ?? s)
      const dx = b.mx - a.mx
      const dy = b.my - a.my
      const along = (lo: number, hi: number, mid: number, d: number, size: number) =>
        Math.abs(d) < 1 ? mid : d > 0 ? hi - size / 2 : lo + size / 2
      const x = Math.round(along(s.x0, s.x1, s.mx, dx, sw))
      const y = Math.round(along(s.y0, s.y1, s.my, dy, sh))
      cursor.push([s.t, x, y])
      if (i === r.length - 1) stops.push({ t: s.t, x, y })
    })
  }
  return { cursor, stops, small }
}

/** A click where the cursor stopped and a non-cursor region near it changed within CLICK_WINDOW_S. */
function inferClicks(
  changes: FrameChange[],
  stops: { t: number; x: number; y: number }[],
  small: (b: Box) => boolean,
  scale: number,
  width: number,
) {
  const clicks: Analysis['clicks'] = []
  for (const s of stops) {
    const hit = changes.find(
      (c) =>
        c.t > s.t &&
        c.t <= s.t + CLICK_WINDOW_S + 1e-6 &&
        c.boxes.some((b) => {
          if (small(b)) return false
          const dx = Math.max(b.x0 * scale - s.x, 0, s.x - (b.x1 + 1) * scale)
          const dy = Math.max(b.y0 * scale - s.y, 0, s.y - (b.y1 + 1) * scale)
          return Math.hypot(dx, dy) <= CLICK_NEAR * width
        }),
    )
    if (hit) clicks.push({ t: s.t, x: s.x, y: s.y, source: 'inferred' })
  }
  return clicks
}

/** The cursor and clicks from a pointer trace (positions 0-1 scaled to source px; moves thinned to 10 Hz). */
function fromTrace(trace: Trace, width: number, height: number) {
  const cursor: [number, number, number][] = []
  let next = -Infinity
  for (const [t, x, y] of trace.moves) {
    if (t < next) continue
    cursor.push([r3(t), Math.round(x * width), Math.round(y * height)])
    next = t + 1 / DIFF_FPS - 1e-9
  }
  const clicks: Analysis['clicks'] = trace.events.flatMap((e) =>
    e.kind === 'click'
      ? [{ t: r3(e.t), x: Math.round(e.x * width), y: Math.round(e.y * height), source: 'trace' as const }]
      : [],
  )
  const navigations = trace.events.flatMap((e) => (e.kind === 'navigate' ? [r3(e.t)] : []))
  return { cursor, clicks, navigations }
}

/** Analyzes a recording file. `trace`: its (already parsed) pointer trace, when there is one. */
export async function analyzeRecording(file: string, trace: Trace | null = null): Promise<Analysis> {
  const started = Date.now()
  const bytes = new Uint8Array(readFileSync(file))
  const c = checkNormalized(bytes)
  const width = c.width ?? 0
  const height = c.height ?? 0
  const duration = c.durationSec ?? 0
  const sha256 = sha256Hex(bytes)
  log('recording.analyze_probe', { file, width, height, duration, ms: Date.now() - started })
  const t0 = Date.now()
  const { changes, scenes: scdet, frames, scale } = await decode(file, width, height)
  log('recording.analyze_decode', {
    frames,
    changed: changes.length,
    scenes: scdet.length,
    ms: Date.now() - t0,
  })
  const idle = idleSpans(changes, duration)
  const activity = changes.map((ch) => {
    const b = ch.boxes[0] as Box
    return [
      ch.t,
      Math.round(b.x0 * scale),
      Math.round(b.y0 * scale),
      Math.round((b.x1 - b.x0 + 1) * scale),
      Math.round((b.y1 - b.y0 + 1) * scale),
    ] as [number, number, number, number, number]
  })
  let cursor: Analysis['cursor']
  let clicks: Analysis['clicks']
  let scenes = scdet
  let cursorSource: Analysis['cursorSource']
  if (trace) {
    const t = fromTrace(trace, width, height)
    cursor = t.cursor
    clicks = t.clicks
    cursorSource = 'trace'
    // Navigations are scene changes too; one within half a second of a detected change is the same one.
    scenes = [...scdet, ...t.navigations.filter((n) => !scdet.some((s) => Math.abs(s - n) < 0.5))].sort(
      (a, b) => a - b,
    )
  } else {
    const inferred = inferCursor(changes, scale)
    cursor = inferred.cursor
    clicks = inferClicks(changes, inferred.stops, inferred.small, scale, width)
    cursorSource = cursor.length ? 'inferred' : 'none'
  }
  const fps = c.mp4?.fps ?? 0
  const analysis: Analysis = {
    v: 1,
    sha256,
    analyzer: ANALYZER_VERSION,
    source: { width, height, fps: r3(fps), duration: r3(duration) },
    cursorSource,
    idle,
    scenes,
    activity,
    cursor,
    clicks,
  }
  log('recording.analyze_done', {
    cursorSource,
    idle: idle.length,
    scenes: scenes.length,
    clicks: clicks.length,
    ms: Date.now() - started,
  })
  return analysis
}
