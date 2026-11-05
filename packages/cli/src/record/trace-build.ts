// The recorder side of the pointer trace (screen-recording plan §4.6; va-rsk5.5.2): page events (trace-page.ts) become
// a schema-valid trace.json on the recording's clock. Times: seconds from the first screencast frame, plus the paint
// latency spike D2 measured (an event shows on screen about 46 ms later), so a click lines up with the frame it shows
// in. Positions: 0-1 of the viewport (the recorded frame is the viewport at its dpr). Moves are simplified with
// Ramer-Douglas-Peucker at 0.5 px; hidden elements get a key when they move over 2 px, a zero-size key off screen, and
// at most 600 keys each. Names are scrubbed by the shared schema (src/lib/recording-trace.ts) when it's parsed.
import { parseTrace, TRACE_LIMITS, type Trace } from '../../../../src/lib/recording-trace.js'
import type { PageEvent } from './trace-page.js'

/** Event to frame, headed Chromium (docs/spikes.md D2: 46 ms median). */
export const PAINT_LATENCY_S = 0.046
const KEY_RUN_GAP_S = 1
const WHEEL_RUN_GAP_S = 0.3
const HIDE_MOVE_PX = 2

export interface TraceInput {
  events: PageEvent[]
  /** Navigations: epoch ms and the path. */
  navigations: { t: number; path: string }[]
  /** Epoch seconds of the first frame, and the recording's length in seconds. */
  start: number
  duration: number
  frame: { width: number; height: number; fps: number }
  viewport: { width: number; height: number; dpr: number }
  tool: string
  kind?: 'cli' | 'script'
  startedAt: string
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Time-aware RDP on [t, x, y] (fractions), tolerance in px of the frame. */
function simplify(points: [number, number, number][], w: number, h: number, tol = 0.5) {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    const [ta, xa, ya] = points[a] as [number, number, number]
    const [tb, xb, yb] = points[b] as [number, number, number]
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const [t, x, y] = points[i] as [number, number, number]
      const k = tb > ta ? (t - ta) / (tb - ta) : 0
      const d = Math.hypot((x - (xa + (xb - xa) * k)) * w, (y - (ya + (yb - ya) * k)) * h)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst > tol) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function buildTrace(input: TraceInput): Trace {
  const duration = r4(input.duration)
  const toT = (ms: number) => r4(ms / 1000 - input.start + PAINT_LATENCY_S)
  const inside = (t: number) => t >= 0 && t <= duration
  const fbox = (e: PageEvent): [number, number, number, number] | null => {
    if (!e.box) return null
    const [x, y, w, h] = e.box
    const x0 = clamp01(x / e.vw)
    const y0 = clamp01(y / e.vh)
    return [
      r4(x0),
      r4(y0),
      r4(Math.min(1 - x0, Math.max(0, w / e.vw))),
      r4(Math.min(1 - y0, Math.max(0, h / e.vh))),
    ]
  }
  const sorted = [...input.events].sort((a, b) => a.t - b.t)

  const moves = simplify(
    sorted
      .filter((e) => e.k === 'move' && inside(toT(e.t)))
      .map(
        (e) =>
          [toT(e.t), r4(clamp01((e.x ?? 0) / e.vw)), r4(clamp01((e.y ?? 0) / e.vh))] as [
            number,
            number,
            number,
          ],
      ),
    input.frame.width,
    input.frame.height,
  ).slice(0, TRACE_LIMITS.moves)

  const events: Trace['events'] = []
  for (const e of sorted) {
    const t = toT(e.t)
    if (!inside(t)) continue
    if (e.k === 'click') {
      const b = fbox(e)
      events.push({
        kind: 'click',
        t,
        x: r4(clamp01((e.x ?? 0) / e.vw)),
        y: r4(clamp01((e.y ?? 0) / e.vh)),
        button: 0,
        ...(b ? { target: { role: e.role ?? 'generic', name: e.name ?? '', box: b } } : {}),
      })
    } else if (e.k === 'focus') {
      const b = fbox(e)
      if (b) events.push({ kind: 'focus', t, box: b, ...(e.role ? { role: e.role } : {}) })
    }
  }
  // Typing: runs of keys on the same field, 1 s apart at most. Only how many and when.
  let run: { t: number; end: number; box: [number, number, number, number]; keys: number } | null = null
  const flushRun = () => {
    if (run) events.push({ kind: 'type', ...run })
    run = null
  }
  for (const e of sorted.filter((x) => x.k === 'key')) {
    const t = toT(e.t)
    const b = fbox(e)
    if (!inside(t) || !b) continue
    if (run && t - run.end <= KEY_RUN_GAP_S && run.box.join() === b.join()) {
      run.end = t
      run.keys++
    } else {
      flushRun()
      run = { t, end: t, box: b, keys: 1 }
    }
  }
  flushRun()
  // Scrolling: runs of wheel events.
  let wheel: { t: number; end: number; dy: number } | null = null
  const flushWheel = () => {
    if (wheel) events.push({ kind: 'scroll', ...wheel, dy: Math.round(wheel.dy) })
    wheel = null
  }
  for (const e of sorted.filter((x) => x.k === 'wheel')) {
    const t = toT(e.t)
    if (!inside(t)) continue
    if (wheel && t - wheel.end <= WHEEL_RUN_GAP_S) {
      wheel.end = t
      wheel.dy += e.dy ?? 0
    } else {
      flushWheel()
      wheel = { t, end: t, dy: e.dy ?? 0 }
    }
  }
  flushWheel()
  // Navigations to another path (a #hash link is the same page).
  let lastPath: string | null = null
  for (const n of input.navigations) {
    const path = n.path.split(/[?#]/)[0] || '/'
    const t = toT(n.t)
    if (inside(t) && lastPath !== null && path !== lastPath) events.push({ kind: 'navigate', t, path })
    lastPath = path
  }
  events.sort((a, b) => a.t - b.t)

  // Hidden elements: one entry per element per page, a key when it moves over 2 px or leaves or enters the screen.
  const byEl = new Map<string, PageEvent[]>()
  for (const e of sorted)
    if (e.k === 'hide') {
      const k = `${e.doc}:${String(e.id)}`
      byEl.set(k, [...(byEl.get(k) ?? []), e])
    }
  const redact: Trace['redact'] = []
  for (const samples of byEl.values()) {
    const keys: [number, number, number, number, number][] = []
    let last: PageEvent | null = null
    for (const s of samples) {
      const t = toT(s.t)
      if (!inside(t)) continue
      const b = fbox(s)
      if (!b) continue
      const moved =
        !last ||
        Boolean(last.on) !== Boolean(s.on) ||
        (last.box ?? []).some((v, i) => Math.abs(v - (s.box?.[i] ?? 0)) > HIDE_MOVE_PX)
      if (moved) keys.push(s.on ? [Math.max(0, t), ...b] : [Math.max(0, t), 0, 0, 0, 0])
      last = s
    }
    if (!keys.length) continue
    const first = samples[0]
    redact.push({
      start: Math.max(0, keys[0]?.[0] ?? 0),
      end: duration,
      reason: first?.role === 'textbox' ? 'password field' : 'hidden field',
      boxes: keys.slice(0, TRACE_LIMITS.keysPerEntry),
    })
  }
  return parseTrace({
    v: 1,
    source: { kind: input.kind ?? 'cli', tool: input.tool, startedAt: input.startedAt },
    frame: {
      width: input.frame.width,
      height: input.frame.height,
      fps: input.frame.fps,
      duration,
    },
    viewport: input.viewport,
    moves,
    events: events.slice(0, TRACE_LIMITS.events),
    redact: redact.slice(0, TRACE_LIMITS.redactEntries),
  })
}
