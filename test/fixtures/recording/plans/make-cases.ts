// The planner's golden cases (screen-recording plan §5.2; va-rsk5.3.3): synthetic event logs, each a directory with
// analysis.json, trace.json, input.json (when the case has one) and args.json ({ target?, aspect? }). Their
// expected-plan.json is the planner's output, checked by hand and regenerated with
//   npx tsx test/fixtures/recording/plans/make-cases.ts && UPDATE_GOLDEN=1 npx vitest run test/recording-plan.test.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A 1280x720 window at 2x (the CLI's default), so the camera can zoom sharply (sharpZoomMax 2.27 in 16:9).
const W = 2560
const H = 1440

type Ev = Record<string, unknown> & { kind: string; t: number }

interface Case {
  duration: number
  idle?: [number, number][]
  scenes?: number[]
  events: Ev[]
  /** Cursor waypoints [t, x, y] (fractions); moves are interpolated at 20 Hz between them. */
  path: [number, number, number][]
  redact?: unknown[]
  input?: unknown
  args?: { target?: number; aspect?: string }
}

const click = (t: number, x: number, y: number, name?: string): Ev => ({
  kind: 'click',
  t,
  x,
  y,
  button: 0,
  ...(name ? { target: { role: 'button', name, box: [x - 0.04, y - 0.015, 0.08, 0.03] } } : {}),
})

const CASES: Record<string, Case> = {
  'one-click': {
    duration: 20,
    idle: [
      [0, 3.5],
      [9, 20],
    ],
    events: [click(6, 0.62, 0.3, 'Add new site')],
    path: [
      [0, 0.5, 0.5],
      [3.5, 0.5, 0.5],
      [5.8, 0.62, 0.3],
      [20, 0.62, 0.3],
    ],
  },
  'click-burst': {
    duration: 16,
    idle: [[14, 16]],
    events: [
      click(4, 0.3, 0.4, 'Bold'),
      click(4.4, 0.33, 0.4, 'Italic'),
      click(4.9, 0.36, 0.4, 'Underline'),
      click(5.5, 0.39, 0.41, 'Link'),
      click(11, 0.8, 0.8, 'Save'),
    ],
    path: [
      [0, 0.5, 0.5],
      [3.8, 0.3, 0.4],
      [5.5, 0.39, 0.41],
      [10.8, 0.8, 0.8],
      [16, 0.8, 0.8],
    ],
  },
  typing: {
    duration: 14,
    events: [
      click(3, 0.5, 0.42, 'Site name'),
      { kind: 'type', t: 3.5, end: 8, box: [0.3, 0.4, 0.4, 0.04], keys: 22 },
      click(10, 0.5, 0.6, 'Create'),
    ],
    path: [
      [0, 0.2, 0.2],
      [2.8, 0.5, 0.42],
      [9.8, 0.5, 0.6],
      [14, 0.5, 0.6],
    ],
  },
  'long-drag': {
    duration: 14,
    events: [
      click(4.9, 0.2, 0.3),
      { kind: 'drag', t: 5, end: 9, from: [0.2, 0.3], to: [0.7, 0.6] },
    ],
    path: [
      [0, 0.5, 0.5],
      [4.9, 0.2, 0.3],
      [9, 0.7, 0.6],
      [14, 0.7, 0.6],
    ],
  },
  scroll: {
    duration: 14,
    events: [
      click(3, 0.5, 0.2, 'Docs'),
      { kind: 'scroll', t: 6, end: 8, dy: 800 },
      click(10, 0.45, 0.7, 'Read more'),
    ],
    path: [
      [0, 0.5, 0.5],
      [3, 0.5, 0.2],
      [9.8, 0.45, 0.7],
      [14, 0.45, 0.7],
    ],
  },
  'scene-change': {
    duration: 20,
    scenes: [10],
    events: [
      click(4, 0.3, 0.3, 'Import a repo'),
      { kind: 'navigate', t: 10, path: '/sites/new/import' },
      click(14, 0.7, 0.5, 'Deploy'),
    ],
    path: [
      [0, 0.5, 0.5],
      [3.8, 0.3, 0.3],
      [13.8, 0.7, 0.5],
      [20, 0.7, 0.5],
    ],
    redact: [
      {
        start: 0,
        end: 20,
        reason: 'api key',
        boxes: [
          [0, 0.1, 0.8, 0.3, 0.05],
          [10, 0.1, 0.6, 0.3, 0.05],
        ],
      },
    ],
    input: { boxes: [{ start: 0, end: 20, reason: 'email', boxes: [[0, 0.8, 0.02, 0.15, 0.04]] }] },
  },
  'idle-middle': {
    duration: 30,
    idle: [
      [5, 18],
      [21, 23.5],
    ],
    events: [click(3, 0.4, 0.4, 'Deploy'), click(20, 0.6, 0.3, 'Open site'), click(26, 0.6, 0.6, 'Share')],
    path: [
      [0, 0.5, 0.5],
      [3, 0.4, 0.4],
      [19.8, 0.6, 0.3],
      [25.8, 0.6, 0.6],
      [30, 0.6, 0.6],
    ],
  },
  vertical: {
    duration: 20,
    idle: [
      [0, 3.5],
      [9, 20],
    ],
    events: [click(6, 0.62, 0.3, 'Add new site')],
    path: [
      [0, 0.5, 0.5],
      [3.5, 0.5, 0.5],
      [5.8, 0.62, 0.3],
      [20, 0.62, 0.3],
    ],
    args: { aspect: '9:16' },
  },
}

/** Moves at 20 Hz along the waypoints, to 4 places. */
function moves(path: Case['path']) {
  const out: [number, number, number][] = []
  for (let i = 1; i < path.length; i++) {
    const [t0, x0, y0] = path[i - 1] as [number, number, number]
    const [t1, x1, y1] = path[i] as [number, number, number]
    for (let t = t0; t < t1 - 1e-9; t += 0.05) {
      const k = (t - t0) / (t1 - t0)
      out.push([t, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k].map((n) => Math.round(n * 1e4) / 1e4) as [number, number, number])
    }
  }
  const last = path.at(-1) as [number, number, number]
  out.push(last)
  return out
}

export function writeCases(root: string) {
  for (const [name, c] of Object.entries(CASES)) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const trace = {
      v: 1,
      source: { kind: 'cli', tool: 'golden', startedAt: '2026-11-05T10:00:00.000Z' },
      frame: { width: W, height: H, fps: 30, duration: c.duration },
      viewport: { width: W, height: H, dpr: 1 },
      moves: moves(c.path),
      events: c.events,
      redact: c.redact ?? [],
    }
    const navs = c.events.filter((e) => e.kind === 'navigate').map((e) => e.t)
    const analysis = {
      v: 1,
      sha256: `golden-${name}`,
      analyzer: 'analyze-1',
      source: { width: W, height: H, fps: 30, duration: c.duration },
      cursorSource: 'trace',
      idle: (c.idle ?? []).map(([start, end]) => ({ start, end })),
      scenes: [...new Set([...(c.scenes ?? []), ...navs])].sort((p, q) => p - q),
      activity: [],
      cursor: [],
      clicks: c.events
        .filter((e) => e.kind === 'click')
        .map((e) => ({ t: e.t, x: Math.round((e.x as number) * W), y: Math.round((e.y as number) * H), source: 'trace' })),
    }
    writeFileSync(join(dir, 'trace.json'), `${JSON.stringify(trace)}\n`)
    writeFileSync(join(dir, 'analysis.json'), `${JSON.stringify(analysis, null, 1)}\n`)
    if (c.input) writeFileSync(join(dir, 'input.json'), `${JSON.stringify(c.input, null, 1)}\n`)
    writeFileSync(join(dir, 'args.json'), `${JSON.stringify(c.args ?? {})}\n`)
  }
  return Object.keys(CASES)
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(writeCases(dirname(fileURLToPath(import.meta.url))))
