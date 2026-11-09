// Spike D6 of the screen-recording plan (va-rsk5.1.6), local and free: does the auto zoom look good? Five tours of
// the app (its mock build) are recorded with `video-agent record`'s capture and pointer trace, and each is made into a
// demo twice, with its trace and from its pixels only (like an upload), through recording.ts analyze/plan/compose and
// a local render. For each demo, a side-by-side MP4 (the raw recording left, the demo right) for the owner to judge.
//   npx tsx scripts/e2e/d6-local.ts --out <dir> [--port 4398]
// Planner output per demo (steps, camera keys, speeds) and render times are logged as JSON lines and saved in
// <dir>/d6.json; the side-by-sides are <dir>/review/<n>-<tour>-<trace|pixels>.mp4.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runRecord } from '../../packages/cli/src/record/capture.js'
import { parseTrace } from '../../app/server/lib/recording-trace.js'
import { log, parseArgs, StepError } from '../lib/run-tools.js'
import { demo, serveMock } from './demo-local.js'

const args = parseArgs(process.argv.slice(2))
if (!args.out) throw new StepError('Usage: d6-local.ts --out <dir> [--port 4398]')
const out = args.out
const port = Number(args.port ?? 4398)

/** Tours of the mock app, as --script modules: each drives the page while it's recorded. */
const TOURS: Record<string, string> = {
  search: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1200)
    const box = await page.getByRole('textbox', { name: 'Search prompts and titles' }).boundingBox()
    for (let i = 1; i <= 20; i++) { await page.mouse.move(300 + (box.x + 40 - 300) * i / 20, 500 + (box.y + 15 - 500) * i / 20); await w(25) }
    await page.mouse.click(box.x + 40, box.y + 15)
    await page.keyboard.type('webhooks', { delay: 110 })
    await w(1500)
    await page.getByRole('link', { name: 'Org webhooks launch' }).first().click()
    await w(4000)
  }`,
  nav: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1000)
    for (const name of ['Media', 'API keys', 'Library']) {
      const b = await page.getByRole('link', { name, exact: true }).first().boundingBox()
      await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 20 })
      await w(300)
      await page.mouse.click(b.x + 30, b.y + b.height / 2)
      await w(2200)
    }
  }`,
  newvideo: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1000)
    const b = await page.getByRole('link', { name: 'New video' }).first().boundingBox()
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 25 })
    await page.mouse.click(b.x + 30, b.y + b.height / 2)
    await w(1800)
    const t = page.getByRole('textbox').first()
    const tb = await t.boundingBox()
    await page.mouse.move(tb.x + 60, tb.y + 20, { steps: 20 })
    await page.mouse.click(tb.x + 60, tb.y + 20)
    await page.keyboard.type('A 30 second launch video for deploy previews', { delay: 70 })
    await w(2500)
  }`,
  scroll: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1000)
    await page.mouse.move(700, 450, { steps: 20 })
    await page.mouse.wheel(0, 600)
    await w(1800)
    await page.mouse.wheel(0, -600)
    await w(1200)
    await page.getByRole('link', { name: 'Ship faster with preview deploys' }).first().click()
    await w(3500)
  }`,
  idle: `export default async (page) => {
    const w = (ms) => page.waitForTimeout(ms)
    await w(1000)
    const b = await page.getByRole('link', { name: 'Org webhooks launch' }).first().boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 })
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    // Waiting, like a deploy: the planner should cut or speed this up.
    await w(7000)
    await page.mouse.move(640, 300, { steps: 25 })
    await w(1500)
  }`,
}

const sh = (cmd: string, argv: string[]) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' })
  if (r.status !== 0) throw new StepError(`${cmd} failed: ${r.stderr.slice(-600)}`)
  return r.stdout
}

async function main() {
  mkdirSync(join(out, 'tours'), { recursive: true })
  mkdirSync(join(out, 'review'), { recursive: true })
  const server = await serveMock()
  const recordings: { tour: string; file: string; trace: string }[] = []
  try {
    for (const [name, code] of Object.entries(TOURS)) {
      const script = join(out, 'tours', `${name}.mjs`)
      writeFileSync(script, code)
      const started = Date.now()
      const r = await runRecord({
        url: `http://localhost:${String(port)}/`,
        viewport: { width: 1280, height: 720 },
        dpr: 1,
        fps: 30,
        out: join(out, 'tours', name),
        script,
        headless: true,
        hide: [],
        names: true,
        tool: 'scripts/e2e/d6-local.ts',
        log: (event, fields) => log(`d6.${event}`, { tour: name, ...fields }),
        say: () => {},
      })
      log('d6.recorded', { tour: name, seconds: r.seconds, clicks: r.clicks, ms: Date.now() - started })
      recordings.push({ tour: name, file: r.file, trace: r.trace })
    }
  } finally {
    server.kill()
  }
  const results = []
  let n = 0
  for (const rec of recordings)
    for (const mode of ['trace', 'pixels'] as const) {
      n++
      const name = `${String(n).padStart(2, '0')}-${rec.tour}-${mode}`
      const mediaId =
        `med_d6${String(n).padStart(2, '0')}${rec.tour.slice(0, 4)}${mode === 'trace' ? 't' : 'p'}000`.slice(
          0,
          20,
        )
      const started = Date.now()
      const r = await demo({
        name,
        mediaId,
        file: rec.file,
        trace: mode === 'trace' ? parseTrace(readFileSync(rec.trace, 'utf8')) : null,
        boxes: [],
      })
      const full = JSON.parse(
        readFileSync(join(out, `demo-${name}`, '.va-run', 'recording', mediaId, 'plan.json'), 'utf8'),
      ) as { steps: { id: string; in: number; out: number; camera: unknown[] }[] }
      // Side by side: the raw recording (left), the demo (right), each 960 wide, the shorter padded with its last frame.
      const review = join(out, 'review', `${name}.mp4`)
      const length = (f: string) =>
        Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim())
      sh('ffmpeg', [
        ...['-loglevel', 'error', '-y', '-i', rec.file, '-i', r.render],
        ...[
          '-filter_complex',
          '[0:v]scale=960:-2,tpad=stop=-1:stop_mode=clone[a];[1:v]scale=960:-2,tpad=stop=-1:stop_mode=clone[b];[a][b]hstack=shortest=0[v]',
        ],
        ...[
          '-map',
          '[v]',
          '-t',
          String(Math.max(length(rec.file), length(r.render))),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          review,
        ],
      ])
      const entry = {
        demo: name,
        tour: rec.tour,
        mode,
        steps: full.steps.map((s) => ({ id: s.id, in: s.in, out: s.out, keys: s.camera.length })),
        planSummary: r.plan,
        render: r.render,
        review,
        ms: Date.now() - started,
      }
      log('d6.demo', entry)
      results.push(entry)
    }
  writeFileSync(join(out, 'd6.json'), JSON.stringify({ results }, null, 2))
  console.log(JSON.stringify({ ok: true, out, review: join(out, 'review'), demos: results.length }))
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  log('d6.failed', { message })
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
})
