// Live test LT-1 of the screen-recording plan (§10 live gate 2; bead va-rsk5.3.19). Spends credits: two demo runs
// (about DEMO_CREDITS = 210 each). CREDIT_CEILING (default 500) refuses to start when the projection is over it.
//
//   npx tsx scripts/e2e/demo.ts --dry   # makes the two recordings and runs the whole pipeline LOCALLY (analyze, plan,
//                                       # compose, check-contract, npx hyperframes check, a local render): no network
//                                       # to the deployment, no credits; then prints the env, steps and credits
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [CREDIT_CEILING=500] npx tsx scripts/e2e/demo.ts [--keep]
//
// The recordings: two tours of the app's mock build, recorded with video-agent record's capture (headless). Tour A
// keeps its pointer trace; tour B is pixels only, like an upload. Or bring your own: RECORDING_A=<dir with recording.mp4
// and trace.json>, RECORDING_B=<file.mp4>. VIDEO_AGENT_KEY is a Creator's key. Live steps, each logged as JSON lines:
//   1. The local pipeline must pass first (as in --dry): a local failure never spends credits.
//   2. Upload both recordings with the screen-recording role (A with its trace).
//   3. Create two demos: A with a setup box over the top-right corner, B with nothing hidden.
//   4. Wait for both (40 min at most each), then check each: ready; engine HyperFrames; the version's recording (trace
//      or not); A private, B not; a summary with steps; the Hidden list (A: the setup box and every trace entry, each
//      with its source); captions; the bundle (through the preview link): index.html has recording scenes,
//      assets/recording/redact.js holds exactly the trace and setup entries, plan.json and analysis.json hold no
//      clicked-element names; a frame of A's first recording scene has a flat grey patch where the box is (weak).
//   5. Credits: each run's usage.totalCreditsCost and the total.
//   6. Cleanup: both demos and both uploads are deleted, even on failure, unless --keep.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRecord } from '../../packages/cli/src/record/capture.js'
import { parseRedactScript } from '../../src/lib/recording.js'
import { parseTrace, type Trace } from '../../src/lib/recording-trace.js'
import { base, key, log, sdk, started } from './lib.js'
import { call, check, dry, dryRun, GateError, sleep } from './narration-lib.js'

const env = process.env
const keep = process.argv.includes('--keep')
const ceiling = Number(env.CREDIT_CEILING ?? 500)
const perDemo = Number(env.DEMO_CREDITS ?? 210)
const work = mkdtempSync(join(tmpdir(), 'va-lt1-'))
const BOX: [number, number, number, number] = [0.82, 0, 0.18, 0.08]

const TOURS = {
  a: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1200)
    const box = await page.getByRole('textbox', { name: 'Search prompts and titles' }).boundingBox()
    await page.mouse.move(box.x + 40, box.y + 15, { steps: 25 })
    await page.mouse.click(box.x + 40, box.y + 15)
    await page.keyboard.type('webhooks', { delay: 110 })
    await w(1500)
    await page.getByRole('link', { name: 'Org webhooks launch' }).first().click()
    await w(4000)
  }`,
  b: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1000)
    for (const name of ['Media', 'Library']) {
      const b = await page.getByRole('link', { name, exact: true }).first().boundingBox()
      await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 20 })
      await page.mouse.click(b.x + 30, b.y + b.height / 2)
      await w(2200)
    }
  }`,
}

/** The two recordings: given, or recorded from the mock app. */
async function recordings(): Promise<{ a: { file: string; trace: Trace }; b: { file: string } }> {
  if (env.RECORDING_A && env.RECORDING_B)
    return {
      a: {
        file: join(env.RECORDING_A, 'recording.mp4'),
        trace: parseTrace(readFileSync(join(env.RECORDING_A, 'trace.json'), 'utf8')),
      },
      b: { file: env.RECORDING_B },
    }
  const { serveMock } = await import('./demo-local.js')
  const server = await serveMock()
  try {
    const made: Record<string, { file: string; trace: string }> = {}
    for (const name of ['a', 'b'] as const) {
      const script = join(work, `${name}.mjs`)
      ;(await import('node:fs')).writeFileSync(script, TOURS[name])
      const r = await runRecord({
        url: `http://localhost:${env.PORT ?? '4398'}/`,
        viewport: { width: 1280, height: 720 },
        dpr: 1,
        fps: 30,
        out: join(work, name),
        script,
        headless: true,
        hide: [],
        names: true,
        tool: 'scripts/e2e/demo.ts',
        log: (event, f) => log(`record.${event}`, { tour: name, ...f }),
        say: () => {},
      })
      made[name] = { file: r.file, trace: r.trace }
    }
    return {
      a: { file: made.a?.file ?? '', trace: parseTrace(readFileSync(made.a?.trace ?? '', 'utf8')) },
      b: { file: made.b?.file ?? '' },
    }
  } finally {
    server.kill()
  }
}

/** Step 1: the whole pipeline locally on both recordings (demo-local's demo()); throws on any failed check. */
async function localPipeline(rec: Awaited<ReturnType<typeof recordings>>) {
  process.argv.push('--out', join(work, 'local'))
  const { demo } = await import('./demo-local.js')
  await demo({ name: 'lt1-a', mediaId: 'med_lt1recaaaa', file: rec.a.file, trace: rec.a.trace, boxes: [] })
  await demo({ name: 'lt1-b', mediaId: 'med_lt1recbbbb', file: rec.b.file, trace: null, boxes: [] })
  log('local_pipeline', { ok: true })
}

const created: string[] = []
const uploaded: string[] = []

interface Version {
  n: number
  status: string
  usage?: { totalCreditsCost?: number } | null
  editing?: { engine?: string }
  recording?: {
    trace: boolean
    summary: { steps: number } | null
    hidden: { id: string; source: string; beat: string }[]
  } | null
}
interface Video {
  id: string
  private: boolean
  versions: Version[]
}

async function waitReady(id: string) {
  const until = Date.now() + 40 * 60_000
  for (;;) {
    const v = (await call<Video>(key, 'GET', `/api/v1/videos/${id}`)).json
    const status = v.versions[0]?.status ?? '?'
    if (status === 'ready' || status === 'failed' || status === 'cancelled' || status === 'timed_out')
      return v
    if (Date.now() > until) throw new GateError(`video ${id} is still ${status} after 40 minutes`)
    await sleep(15_000)
  }
}

async function checkDemo(name: string, v: Video, trace: Trace | null) {
  const ver = v.versions[0]
  check(ver?.status === 'ready', `${name}: ready`, { status: ver?.status })
  check(ver.editing?.engine === 'hyperframes', `${name}: HyperFrames`, { engine: ver.editing?.engine })
  const rec = ver.recording
  check(!!rec && rec.trace === !!trace, `${name}: the version's recording`, { recording: rec })
  check((rec.summary?.steps ?? 0) > 0, `${name}: a summary with steps`, { summary: rec.summary })
  const sources = new Set(rec.hidden.map((h) => h.source))
  if (name === 'A') {
    check(v.private, 'A: private (a setup box)', { private: v.private })
    check(sources.has('setup'), 'A: the setup box in the Hidden list', { hidden: rec.hidden })
    if (trace?.redact.length)
      check(sources.has('trace'), 'A: trace entries in the Hidden list', { hidden: rec.hidden })
  } else
    check(!v.private || (trace?.redact.length ?? 0) > 0, 'B: not private (nothing hidden)', {
      private: v.private,
    })
  check(
    rec.hidden.every((h) => ['trace', 'setup', 'agent', 'editor'].includes(h.source)),
    `${name}: every hidden entry has a source`,
  )
  const caps = await call<{ cues?: unknown[] }>(
    key,
    'GET',
    `/api/v1/videos/${v.id}/versions/${ver.n}/captions`,
  )
  check(caps.status === 200, `${name}: captions`, { status: caps.status })
  // The bundle, through the preview link.
  const prev = await call<{ url: string }>(key, 'GET', `/api/v1/videos/${v.id}/versions/${ver.n}/preview`)
  check(prev.status === 200 && !!prev.json.url, `${name}: preview link`, { status: prev.status })
  const at = (p: string) => new URL(p, prev.json.url).toString()
  const text = async (p: string) => {
    const r = await fetch(at(p))
    return r.ok ? r.text() : null
  }
  const html = (await text('index.html')) ?? ''
  check(/data-va-recording=/.test(html), `${name}: index.html has recording scenes`)
  const locked = parseRedactScript((await text('assets/recording/redact.js')) ?? '')
  const want = (trace?.redact.length ?? 0) + (name === 'A' ? 1 : 0)
  check(locked.ok && locked.entries.length === want, `${name}: redact.js holds the trace and setup entries`, {
    entries: locked.ok ? locked.entries.map((e) => e.id) : null,
    want,
  })
  const names = (trace?.events ?? []).flatMap((e) =>
    e.kind === 'click' && e.target?.name ? [e.target.name] : [],
  )
  for (const p of ['assets/recording/plan.json', 'assets/recording/analysis.json']) {
    const body = (await text(p)) ?? ''
    check(
      !names.some((n) => n.length > 3 && body.includes(n)),
      `${name}: ${p} holds no clicked-element names`,
    )
  }
  log('demo_checked', {
    demo: name,
    id: v.id,
    credits: ver.usage?.totalCreditsCost ?? null,
    hidden: rec.hidden.length,
  })
  return ver.usage?.totalCreditsCost ?? perDemo
}

/** Weak: a frame early in A's first recording scene has a flat grey patch where the setup box is. */
async function boxFrame(v: Video) {
  const res = await fetch(`${base}/api/v1/videos/${v.id}/versions/${String(v.versions[0]?.n)}/video`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!res.ok) return log('box_frame', { weak: true, skipped: `video ${String(res.status)}` })
  const mp4 = join(work, 'a.mp4')
  ;(await import('node:fs')).writeFileSync(mp4, new Uint8Array(await res.arrayBuffer()))
  // The intro is about 3 s; the window is inset 6% (wallpaper).
  const x = Math.round(1920 * (0.06 + 0.88 * (BOX[0] + BOX[2] / 2)))
  const y = Math.round(1080 * (0.06 + 0.88 * (BOX[1] + BOX[3] / 2)))
  const r = spawnSync('ffmpeg', [
    '-loglevel',
    'error',
    '-ss',
    '3.5',
    '-i',
    mp4,
    '-frames:v',
    '1',
    '-vf',
    `crop=8:8:${String(x - 4)}:${String(y - 4)},scale=1:1`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ])
  const [red, green, blue] = [...(r.stdout as Buffer)]
  const grey =
    red !== undefined && Math.max(red, green ?? 0, blue ?? 0) - Math.min(red, green ?? 0, blue ?? 0) < 30
  log('box_frame', { weak: true, at: [x, y], rgb: [red, green, blue], grey })
}

async function main() {
  const rec = await recordings()
  log('recordings', {
    a: rec.a.file,
    b: rec.b.file,
    traceClicks: rec.a.trace.events.filter((e) => e.kind === 'click').length,
  })
  await localPipeline(rec)
  if (dry)
    dryRun({
      script: 'scripts/e2e/demo.ts',
      required: { VIDEO_AGENT_URL: base || undefined, VIDEO_AGENT_KEY: key || undefined },
      optional: {
        CREDIT_CEILING: env.CREDIT_CEILING,
        RECORDING_A: env.RECORDING_A,
        RECORDING_B: env.RECORDING_B,
      },
      steps: [
        'local pipeline on both recordings (done above: analyze, plan, compose, checks, local render)',
        'upload A (with its pointer trace) and B (pixels only) with the screen-recording role',
        'create demo A (a setup box at the top right) and demo B (nothing hidden)',
        'wait for both, then check: ready, HyperFrames, recording field, privacy, summary, Hidden list, captions, bundle files, no names',
        'report credits; delete both demos and both uploads (unless --keep)',
      ],
      credits: { projected: 2 * perDemo, perDemo, ceiling, under: 2 * perDemo <= ceiling },
      problems:
        2 * perDemo > ceiling
          ? [`projected ${String(2 * perDemo)} credits is over CREDIT_CEILING ${String(ceiling)}`]
          : [],
    })
  check(!!base && !!key, 'VIDEO_AGENT_URL and VIDEO_AGENT_KEY are set')
  check(2 * perDemo <= ceiling, 'projected credits under CREDIT_CEILING', { projected: 2 * perDemo, ceiling })
  const va = sdk()
  const a = await va.media.uploadRecording(new Uint8Array(readFileSync(rec.a.file)), {
    trace: rec.a.trace,
  })
  uploaded.push(a.id)
  const b = await va.media.uploadRecording(new Uint8Array(readFileSync(rec.b.file)))
  uploaded.push(b.id)
  log('uploaded', { a: a.id, b: b.id })
  const make = async (prompt: string, recording: Record<string, unknown>) => {
    const r = await call<{ id: string }>(key, 'POST', '/api/v1/videos', { prompt, recording })
    check(r.status === 202, 'create demo', { status: r.status, body: r.json })
    created.push(r.json.id)
    return r.json.id
  }
  const duration = rec.a.trace.frame.duration
  const idA = await make('A short demo of searching the video library and opening a video.', {
    mediaId: a.id,
    redact: [{ start: 0, end: duration, box: BOX }],
  })
  const idB = await make('A short demo of moving between the media library and the video library.', {
    mediaId: b.id,
  })
  log('created', { a: idA, b: idB })
  const [va1, vb1] = await Promise.all([waitReady(idA), waitReady(idB)])
  const credits = (await checkDemo('A', va1, rec.a.trace)) + (await checkDemo('B', vb1, null))
  await boxFrame(va1)
  log('PASS', { credits, seconds: Math.round((Date.now() - started) / 1000) })
}

async function cleanup() {
  if (keep || dry) return
  for (const id of created)
    log('cleanup', { video: id, status: (await call(key, 'DELETE', `/api/v1/videos/${id}`)).status })
  for (const id of uploaded)
    log('cleanup', { media: id, status: (await call(key, 'DELETE', `/api/v1/media/${id}`)).status })
}

main()
  .catch((e: unknown) => {
    log('FAIL', { error: e instanceof Error ? e.message : String(e) })
    process.exitCode = 1
  })
  .finally(() => cleanup().catch((e: unknown) => log('cleanup_failed', { error: String(e) })))
  .finally(() => {
    if (!existsSync(work)) return
  })
