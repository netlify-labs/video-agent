// Spike S10: reads spikes/s10/out/*.json (the page's reports) and prints the error tables, so the numbers in
// docs/spikes.md are reproducible from the raw JSON.
//   npx tsx spikes/s10/analyze.ts [dir] [--markdown]
// Tables: API matrix per engine; per setup (label, engine, mode, mic): fit residuals, offset error at start /
// middle / end raw and with each calibration, 10-minute drift, monitor-vs-picture error, MediaRecorder offset,
// stop -> upload, memory; calibration repeatability; audition memory; recovery. A setup is "qualified" for the
// <= 1 frame promise when every corrected start/middle/end error of every loopback take is within one frame.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mean, stddev } from './lib/fit.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = Record<string, any>

const args = process.argv.slice(2)
const md = args.includes('--markdown')
const dir = args.find((a) => !a.startsWith('--')) ?? join(new URL('.', import.meta.url).pathname, 'out')
const FRAME_MS = 1000 / 30

const reports: R[] = []
for (const f of readdirSync(dir)
  .filter((n) => n.endsWith('.json') && !n.startsWith('automated-'))
  .sort()) {
  try {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as R
    if (typeof r.kind === 'string') reports.push({ ...r, file: f })
  } catch {
    console.error(`skipping ${f}: not JSON`)
  }
}
const of = (k: string) => reports.filter((r) => r.kind === k)

const n = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-')
function table(title: string, head: string[], rows: (string | number)[][]) {
  console.log(`\n${md ? '#### ' : '== '}${title}`)
  if (!rows.length) {
    console.log('(no data)')
    return
  }
  const cells = [head, ...rows.map((r) => r.map(String))]
  if (md) {
    console.log(`| ${head.join(' | ')} |`)
    console.log(`| ${head.map(() => '---').join(' | ')} |`)
    for (const r of cells.slice(1)) console.log(`| ${r.join(' | ')} |`)
    return
  }
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)))
  for (const r of cells) console.log(r.map((c, i) => c.padEnd(w[i] ?? 0)).join('  '))
}
const setupKey = (r: R) =>
  [r.setup?.label ?? '?', r.setup?.engine ?? '?', r.setup?.mode ?? '?', r.setup?.mic ?? 'device'].join(' · ')

// ---- API matrix (latest per engine)
const latest = new Map<string, R>()
for (const r of of('matrix')) latest.set(String(r.matrix?.engine ?? r.setup?.engine), r.matrix as R)
const keys = [
  'requestVideoFrameCallback',
  'getOutputTimestamp',
  'outputLatency',
  'baseLatency',
  'sampleRate',
  'audioWorklet',
  'moduleWorker',
  'measureUserAgentSpecificMemory',
  'performanceMemory',
  'setSinkId',
  'storageQuotaMB',
]
const engines = [...latest.keys()]
table(
  'API matrix',
  ['API', ...engines],
  [
    ...keys.map((k) => [k, ...engines.map((e) => String(latest.get(e)?.[k] ?? '-'))]),
    [
      'MediaRecorder types',
      ...engines.map((e) =>
        Object.entries((latest.get(e)?.mediaRecorderTypes ?? {}) as Record<string, boolean>)
          .filter(([, ok]) => ok)
          .map(([t]) => t)
          .join(', '),
      ),
    ],
    ['userAgent', ...engines.map((e) => String(latest.get(e)?.userAgent ?? '-'))],
  ],
)

// ---- calibrations: (a) is keyed by browser + INPUT (it measures input latency, so a speaker run applies to the same
// mic with headphones); (b) by the full label (it includes the route and the person); (c) is the take's slider.
const parts = (r: R) =>
  String(r.setup?.label ?? '')
    .split('/')
    .map((x) => x.trim())
const inputKey = (r: R) => `${String(r.setup?.engine)}|${parts(r)[1] ?? '?'}`
const labelKey = (r: R) => `${String(r.setup?.engine)}|${String(r.setup?.label)}`
const calA = new Map<string, number[]>()
const calB = new Map<string, number[]>()
for (const r of of('calib-a'))
  if (r.detected >= 4) calA.set(inputKey(r), [...(calA.get(inputKey(r)) ?? []), r.result.mean as number])
for (const r of of('calib-b-result'))
  if (r.claps >= 4) calB.set(labelKey(r), [...(calB.get(labelKey(r)) ?? []), r.result.mean as number])
const offsetsFor = (t: R): Record<string, number | null> => {
  const a = calA.get(inputKey(t))
  const b = calB.get(labelKey(t))
  return {
    raw: 0,
    a: a?.length ? mean(a) : null,
    b: b?.length ? mean(b) : null,
    c: (t.calibration?.c as number | undefined) ?? null,
  }
}

// ---- takes per setup
const takes = of('take')
const groups = new Map<string, R[]>()
for (const t of takes) groups.set(setupKey(t), [...(groups.get(setupKey(t)) ?? []), t])

const rows: (string | number)[][] = []
const qualified: string[][] = []
const corr = (t: R, k: string) => {
  const off = offsetsFor(t)[k]
  const g = t.loopback?.groups as { start: number; middle: number; end: number } | undefined
  if (off === null || off === undefined || !g || !(t.loopback?.matched >= 3)) return null
  return { start: g.start - off, middle: g.middle - off, end: g.end - off, driftMs: g.end - g.start }
}
const sme = (x: { start: number; middle: number; end: number } | null) =>
  x ? `${n(x.start)} / ${n(x.middle)} / ${n(x.end)}` : '-'
for (const [key, ts] of groups) {
  for (const t of ts) {
    rows.push([
      key,
      `${t.media?.seconds ?? '?'}s`,
      t.stop?.reason ?? '-',
      n(t.fit?.residualRmsMs, 2),
      n(t.fit?.residualMaxMs, 2),
      n(t.fit?.slopePpm, 0),
      `${t.loopback?.matched ?? 0}`,
      sme(corr(t, 'raw')),
      sme(corr(t, 'a')),
      sme(corr(t, 'b')),
      sme(corr(t, 'c')),
      n(corr(t, 'raw')?.driftMs),
      `${n(t.monitor?.errorMs?.mean)} / ${n(t.monitor?.errorMs?.maxAbs)}`,
      n(t.mediaRecorder?.firstSampleVsTakeStartMs?.median),
      n(t.upload?.stopToUploadedMs, 0),
      // during the take only (the page's own checks after stop read the whole take back)
      n(
        Math.max(
          0,
          ...((t.memory ?? []) as R[])
            .filter((m) => Number(m.t) <= Number(t.stop?.atSeconds ?? Infinity))
            .map((m) => Number(m.uaMB ?? m.heapMB ?? 0)),
        ),
        1,
      ),
    ])
  }
  for (const k of ['a', 'b', 'c']) {
    // fake / synthetic-mic takes measure the pipeline, not latency: never "qualified"
    const cs = ts
      .filter((t) => t.setup?.mode !== 'fake')
      .map((t) => corr(t, k))
      .filter((x) => x !== null)
    if (!cs.length) continue
    const worst = Math.max(...cs.flatMap((x) => [x.start, x.middle, x.end].map(Math.abs)))
    qualified.push([key, k, `${cs.length}`, n(worst), worst <= FRAME_MS ? 'yes' : 'no'])
  }
}
table(
  'Takes (errors in ms; start / middle / end; positive = take lands late)',
  [
    'setup (label · engine · mode · mic)',
    'media',
    'stop',
    'resid rms',
    'resid max',
    'slope ppm',
    'beeps',
    'raw',
    'cal a',
    'cal b',
    'cal c',
    'drift',
    'monitor mean/max',
    'MR offset',
    'stop->upload',
    'mem MB',
  ],
  rows,
)
table(
  'Qualified for <= 1 frame (33.3 ms) at 30 fps, loopback takes',
  ['setup', 'calibration', 'takes', 'worst |error|', 'qualified'],
  qualified,
)

// ---- calibration repeatability: (a) per browser + input, (b) per label; b − a = what (a) misses on that route
const calRows: (string | number)[][] = []
const sum = (v: number[] | undefined) =>
  v?.length ? [v.length, n(mean(v)), n(stddev(v)), n(Math.max(...v) - Math.min(...v))] : [0, '-', '-', '-']
for (const [k, b] of calB) {
  const [engine, label] = k.split('|')
  const a = calA.get(`${engine ?? ''}|${(label ?? '').split('/')[1]?.trim() ?? '?'}`)
  calRows.push([
    `${label ?? ''} | ${engine ?? ''}`,
    ...sum(a),
    ...sum(b),
    a?.length ? n(mean(b) - mean(a)) : '-',
  ])
}
for (const [k, a] of calA)
  if (
    ![...calB.keys()].some(
      (b) => `${b.split('|')[0] ?? ''}|${(b.split('|')[1] ?? '').split('/')[1]?.trim() ?? ''}` === k,
    )
  )
    calRows.push([`${k.replace('|', ' · ')} (input)`, ...sum(a), ...sum(undefined), '-'])
table(
  'Calibration repeatability (ms)',
  ['setup', '(a) runs', 'mean', 'sd', 'range', '(b) runs', 'mean', 'sd', 'range', 'b - a'],
  calRows,
)

// ---- residual-stop threshold evidence
const normal = takes.filter((t) => ['ended', 'user', 'max-seconds'].includes(t.stop?.reason as string))
const maxRes = normal.map((t) => Number(t.fit?.residualMaxMs ?? NaN)).filter(Number.isFinite)
const stops = takes.reduce<Record<string, number>>(
  (m, t) => ({ ...m, [t.stop?.reason as string]: (m[t.stop?.reason as string] ?? 0) + 1 }),
  {},
)
table(
  'Residual stop',
  ['takes', 'max residual over clean takes', 'stop reasons'],
  [[takes.length, maxRes.length ? n(Math.max(...maxRes), 2) : '-', JSON.stringify(stops)]],
)

// ---- audition + recovery
table(
  'Audition memory (sliding window + LRU)',
  [
    'engine',
    'takes x s',
    'active',
    'budget MB',
    'peak cache MB',
    'naive MB',
    'decodes',
    'evictions',
    'ms/window',
    'max heap MB',
  ],
  of('audition').map((r) => [
    String(r.setup?.engine),
    `${r.params.takes} x ${r.params.seconds}`,
    r.params.active,
    r.params.budgetMB,
    n(r.peakCacheMB),
    n(r.naiveDecodeAllMB, 0),
    r.misses,
    r.evictions,
    n(r.decodeMsPerWindow, 2),
    n(Math.max(0, ...(r.heap as R[]).map((h) => Number(h.heapMB ?? 0))), 0),
  ]),
)
table(
  'Recovery after reload',
  ['engine', 'samples', 'seconds', 'running hash ok', 'recover ms'],
  of('recovery').map((r) => [
    String(r.setup?.engine),
    r.samples,
    n(r.samples / 24_000),
    String(r.runningHashOk),
    n(r.recoverMs),
  ]),
)
