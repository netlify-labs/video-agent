// Phase 2 gate of the screen-recording plan (va-rsk5.3.18), local and free: three demos made with no agent and no
// credits, each through the whole run-side pipeline (recording.ts analyze, plan, compose; check-contract with the
// recording check; npx hyperframes check; a local render) and inspected at its clicks:
//   - the synthetic fixture (test/fixtures/recording/make-fixture.ts), no trace;
//   - tour A: a real recording of the app (its mock build) with a pointer trace and a setup box;
//   - tour B: another real recording of the app, without a trace.
// Real recordings: Playwright's video capture of a scripted tour, normalized like an upload (H.264, 30 fps, 1 s GOPs,
// fast start); tour A's trace is written by the tour itself (moves, clicks with role and name, typing, navigation).
//   npx tsx scripts/e2e/demo-local.ts [--out <dir>] [--port 4398] [--keep]
// One JSON line per step on stderr; the summary (with the paths of the renders and stills) on stdout.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { load, read } from '../../src/lib/contract.js'
import { parseTrace, type Trace } from '../../src/lib/recording-trace.js'
import { makeFixture } from '../../test/fixtures/recording/make-fixture.js'
import { checkContract } from '../lib/check-contract.js'
import { log, parseArgs, repoRoot, StepError } from '../lib/run-tools.js'

const args = parseArgs(process.argv.slice(2))
const out = args.out ?? mkdtempSync(join(tmpdir(), 'va-demo-local-'))
const port = Number(args.port ?? 4398)
const W = 1280
const H = 720

function sh(cmd: string, argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 600_000,
  })
  if (r.status !== 0)
    throw new StepError(`${cmd} ${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).slice(-800)}`)
  return r.stdout
}

const step = async <T>(
  name: string,
  fields: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> => {
  const started = Date.now()
  try {
    const r = await fn()
    log(`demo_local.${name}`, { ...fields, ok: true, ms: Date.now() - started })
    return r
  } catch (e) {
    log(`demo_local.${name}`, {
      ...fields,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

// ───── the app, and the tours ─────

async function serveMock(): Promise<ChildProcess> {
  // The mock build: no backend, the sample library.
  process.env.VITE_MOCK = '1'
  const dist = join(out, 'dist-mock')
  if (!existsSync(join(dist, 'index.html')))
    sh('npx', ['vite', 'build', 'ui', '--outDir', dist, '--emptyOutDir'], { timeoutMs: 600_000 })
  const server = spawn(
    'npx',
    ['vite', 'preview', 'ui', '--outDir', dist, '--port', String(port), '--strictPort'],
    {
      cwd: repoRoot,
      env: { ...process.env, VITE_MOCK: '1' },
      stdio: 'ignore',
    },
  )
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://localhost:${String(port)}/`)).ok) return server
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  server.kill()
  throw new StepError(`The mock app didn't come up on port ${String(port)}.`)
}

/** A tour's pointer trace, written as it goes: positions in frame fractions, times from the recording's start. */
class Tracer {
  moves: [number, number, number][] = []
  events: Trace['events'] = []
  private x = W / 2
  private y = H / 2
  constructor(
    private page: Page,
    private t0: number,
  ) {}
  now = () => Math.round(((performance.now() - this.t0) / 1000) * 1000) / 1000
  private at(x: number, y: number) {
    this.x = x
    this.y = y
    this.moves.push([this.now(), Math.round((x / W) * 1e4) / 1e4, Math.round((y / H) * 1e4) / 1e4])
  }
  async move(x: number, y: number, ms = 700) {
    const n = Math.max(2, Math.round(ms / 33))
    const [sx, sy] = [this.x, this.y]
    for (let i = 1; i <= n; i++) {
      const k = i / n
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      await this.page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e)
      this.at(sx + (x - sx) * e, sy + (y - sy) * e)
      await this.page.waitForTimeout(ms / n)
    }
  }
  async click(role: Parameters<Page['getByRole']>[0], name: string) {
    const target = this.page.getByRole(role, { name }).first()
    const box = await target.boundingBox()
    if (!box) throw new StepError(`No ${role} "${name}" on the page.`)
    const [cx, cy] = [box.x + box.width / 2, box.y + Math.min(box.height / 2, 20)]
    await this.move(cx, cy)
    await this.page.waitForTimeout(250)
    const f = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1e4) / 1e4))
    this.events.push({
      kind: 'click',
      t: this.now(),
      x: f(cx / W),
      y: f(cy / H),
      button: 0,
      target: {
        role,
        name,
        box: [
          f(box.x / W),
          f(box.y / H),
          f(Math.min(box.width, W - box.x) / W),
          f(Math.min(box.height, H - box.y) / H),
        ],
      },
    })
    await this.page.mouse.click(cx, cy)
  }
  async type(role: Parameters<Page['getByRole']>[0], name: string, text: string) {
    await this.click(role, name)
    const box = await this.page.getByRole(role, { name }).first().boundingBox()
    const t = this.now()
    await this.page.keyboard.type(text, { delay: 90 })
    const f = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1e4) / 1e4))
    if (box)
      this.events.push({
        kind: 'type',
        t,
        end: this.now(),
        box: [
          f(box.x / W),
          f(box.y / H),
          f(Math.min(box.width, W - box.x) / W),
          f(Math.min(box.height, H - box.y) / H),
        ],
        keys: text.length,
      })
  }
  navigated(path: string) {
    this.events.push({ kind: 'navigate', t: this.now(), path })
  }
}

type Tour = (t: Tracer, page: Page) => Promise<void>

const TOURS: Record<'a' | 'b', Tour> = {
  // Search the library, open a video, look at it, come back.
  a: async (t, page) => {
    await page.waitForTimeout(1500)
    await t.type('textbox', 'Search prompts and titles', 'webhooks')
    await page.waitForTimeout(1500)
    await t.move(640, 420)
    await t.click('link', 'Org webhooks launch')
    await page.waitForTimeout(6000)
    await t.move(300, 200, 900)
    await page.waitForTimeout(2500)
  },
  // Browse the library: scroll down and up, then open another video.
  b: async (t, page) => {
    await page.waitForTimeout(1500)
    await t.move(900, 500, 900)
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(2000)
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(1500)
    await t.click('link', 'Ship faster with preview deploys')
    await page.waitForTimeout(5500)
  },
}

async function record(name: 'a' | 'b'): Promise<{ file: string; trace: Trace }> {
  const dir = join(out, `tour-${name}`)
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir, size: { width: W, height: H } },
  })
  const page = await context.newPage()
  const t0 = performance.now()
  const tracer = new Tracer(page, t0)
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && tracer.moves.length) tracer.navigated(new URL(f.url()).pathname || '/')
  })
  await page.goto(`http://localhost:${String(port)}/`)
  await TOURS[name](tracer, page)
  const video = page.video()
  await context.close()
  await browser.close()
  const webm = await video?.path()
  if (!webm) throw new StepError('Playwright recorded no video.')
  const file = join(dir, `med_tour${name}00001.mp4`)
  // Normalized like an upload (screen-recording plan §4.2): H.264, 30 fps, a keyframe every second, fast start.
  sh('ffmpeg', [
    ...[
      '-loglevel',
      'error',
      '-y',
      '-i',
      webm,
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
    ],
    ...[
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      file,
    ],
  ])
  const duration = Number(
    sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim(),
  )
  const clip = (n: number) => Math.min(n, duration)
  const trace = parseTrace({
    v: 1,
    source: { kind: 'script', tool: 'scripts/e2e/demo-local.ts', startedAt: new Date().toISOString() },
    frame: { width: W, height: H, fps: 30, duration },
    viewport: { width: W, height: H, dpr: 1 },
    moves: tracer.moves.filter((m) => m[0] <= duration),
    events: tracer.events
      .filter((e) => e.t <= duration)
      .map((e) => ('end' in e ? { ...e, end: clip(e.end) } : e)),
    redact: [],
  })
  return { file, trace }
}

// ───── one demo, run-shaped ─────

interface Demo {
  name: string
  mediaId: string
  file: string
  trace: Trace | null
  boxes: { start: number; end: number; reason: string; boxes: [number, number, number, number, number][] }[]
}

async function demo(d: Demo) {
  // Not the tour's own folder (out/tour-<x>), which holds the recording.
  const root = join(out, `demo-${d.name}`)
  rmSync(root, { recursive: true, force: true })
  const video = join(root, 'video')
  cpSync(join(repoRoot, 'video'), video, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.endsWith('AGENTS.md'),
  })
  const media = join(video, 'assets', 'media')
  mkdirSync(media, { recursive: true })
  cpSync(d.file, join(media, `${d.mediaId}.mp4`))
  const run = join(root, '.va-run', 'recording', d.mediaId)
  mkdirSync(run, { recursive: true })
  if (d.trace) writeFileSync(join(run, 'trace.json'), JSON.stringify(d.trace))
  writeFileSync(join(run, 'input.json'), JSON.stringify({ boxes: d.boxes }))
  mkdirSync(join(root, '.render'), { recursive: true })
  writeFileSync(
    join(root, '.render', 'run-manifest.json'),
    JSON.stringify({ v: 1, kind: 'author', recording: { mediaId: d.mediaId, filename: `${d.mediaId}.mp4` } }),
  )
  const file = join(media, `${d.mediaId}.mp4`)
  const analysis = join(video, 'assets', 'recording', 'analysis.json')
  const trace = d.trace ? ['--trace', join(run, 'trace.json')] : ['--trace', join(run, 'none.json')]
  const context = join(root, 'context', 'recording', d.mediaId)
  const cli = (argv: string[]) => {
    const r = sh('npx', ['tsx', 'scripts/recording.ts', ...argv])
    return JSON.parse(r.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
  }
  const a = await step('analyze', { demo: d.name }, () =>
    cli(['analyze', '--file', file, ...trace, '--out', analysis, '--context', context, '--no-transcript']),
  )
  const p = await step('plan', { demo: d.name }, () =>
    cli([
      ...['plan', '--media', d.mediaId, '--file', file, '--analysis', analysis, ...trace],
      ...['--input', join(run, 'input.json'), '--look', join(repoRoot, 'looks', 'clean', 'look.json')],
      ...[
        '--out',
        join(video, 'assets', 'recording', 'plan.json'),
        '--full',
        join(run, 'plan.json'),
        '--context',
        context,
      ],
    ]),
  )
  await step('compose', { demo: d.name }, () =>
    cli([
      'compose',
      '--plan',
      join(run, 'plan.json'),
      '--video',
      video,
      '--analysis',
      analysis,
      ...trace,
      '--look',
      'clean',
      '--title',
      `Demo ${d.name}`,
    ]),
  )
  await step('check_contract', { demo: d.name }, () => {
    const r = checkContract(root, { fix: false })
    if (r.code !== 0) throw new StepError(r.lines.join('\n'))
    return r.lines
  })
  await step('hyperframes_check', { demo: d.name }, () => {
    const r = sh('npx', ['hyperframes', 'check'], { cwd: video, timeoutMs: 600_000 })
    if (!/Check passed/.test(r)) throw new StepError(r.slice(-1500))
    return r.match(/\d+ error\(s\), \d+ warning\(s\)/g)
  })
  const mp4 = join(out, `render-${d.name}.mp4`)
  await step('render', { demo: d.name }, () =>
    sh('npx', ['hyperframes', 'render', '-q', 'draft', '-o', mp4], { cwd: video, timeoutMs: 900_000 }),
  )
  // Stills at each click, in output time: a recording scene shows in..out over its slot.
  const html = readFileSync(join(video, 'index.html'), 'utf8')
  const beats = read(load(html)).beats.filter((b) => b.recording)
  const stills: string[] = []
  for (const b of beats) {
    const r = b.recording
    if (!r) continue
    const slot = r.hold ? b.duration - r.hold.seconds : b.duration
    for (const c of r.clicks as [number, number, number][]) {
      const at = b.start + ((c[0] - r.in) / (r.out - r.in)) * slot + 0.15
      const still = join(out, `${d.name}-click-${at.toFixed(2)}.png`)
      sh('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(at),
        '-i',
        mp4,
        '-frames:v',
        '1',
        '-vf',
        'scale=960:-2',
        still,
      ])
      stills.push(still)
    }
  }
  return { demo: d.name, analysis: a, plan: p, render: mp4, stills, scenes: beats.length }
}

async function main() {
  mkdirSync(out, { recursive: true })
  log('demo_local.start', { out })
  const fixture = makeFixture(join(out, 'fixture.mp4'))
  const server = await step('serve', { port }, serveMock)
  let tours: { a: { file: string; trace: Trace }; b: { file: string; trace: Trace } }
  try {
    tours = {
      a: await step('record', { tour: 'a' }, () => record('a')),
      b: await step('record', { tour: 'b' }, () => record('b')),
    }
  } finally {
    server.kill()
  }
  const results = []
  results.push(
    await demo({ name: 'fixture', mediaId: 'med_fixture0001', file: fixture, trace: null, boxes: [] }),
  )
  results.push(
    await demo({
      name: 'tour-a',
      mediaId: 'med_toura00001',
      file: tours.a.file,
      trace: tours.a.trace,
      // A setup box over the top-right corner (the account menu), held for the whole recording.
      boxes: [
        { start: 0, end: tours.a.trace.frame.duration, reason: 'account', boxes: [[0, 0.82, 0, 0.18, 0.08]] },
      ],
    }),
  )
  results.push(
    await demo({ name: 'tour-b', mediaId: 'med_tourb00001', file: tours.b.file, trace: null, boxes: [] }),
  )
  const summary = { ok: true, out, demos: results }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  if (!args.keep)
    for (const f of readdirSync(out))
      if (f === 'dist-mock') rmSync(join(out, f), { recursive: true, force: true })
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  log('demo_local.failed', { message })
  console.log(JSON.stringify({ ok: false, error: message, out }))
  process.exit(1)
})
