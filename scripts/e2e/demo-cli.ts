// Live test LT-3 of the screen-recording plan (live gate 4; bead va-rsk5.5.7): a demo of the Video Agent app made with
// the CLI, about 210 credits. CREDIT_CEILING (default 250) refuses to start when the projection is over it.
//
//   npx tsx scripts/e2e/demo-cli.ts --dry   # builds the CLI and records the tour with it here (no network to the
//                                          # deployment, no credits); checks the file and trace; prints the plan
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… npx tsx scripts/e2e/demo-cli.ts [--no-publish]
//   LT3_VIDEO=vid_… (same env)                    # check and publish a demo it already made; no new credits
//
// The tour: the app's mock build, searched for a video and opened, recorded by `video-agent record --script` (the built
// CLI, dpr 2, a pointer trace). Live, the same command with --make uploads it with its trace and makes the demo; the
// script waits (40 min at most) and checks it like LT-1 (ready, HyperFrames, the recording with its trace, a summary
// with steps, captions, recording scenes in the bundle), then publishes it (unless --no-publish) and logs the share
// page, the MP4 and the credits. JSON lines.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTrace } from '../../app/server/lib/recording-trace.js'
import { api, base, fail, key, log, started } from './lib.js'
import { dryRun } from './narration-lib.js'

const env = process.env
const dry = process.argv.includes('--dry')
const publish = !process.argv.includes('--no-publish')
const ceiling = Number(env.CREDIT_CEILING ?? 250)
const perDemo = Number(env.DEMO_CREDITS ?? 210)
const repo = join(import.meta.dirname, '..', '..')
const work = mkdtempSync(join(tmpdir(), 'va-lt3-'))
const PROMPT =
  'A 25-second product demo of Video Agent: find a video in the library by searching for it, then open it. One callout per step, an end card that says "Every video, one search away".'

const TOUR = `export default async (page) => {
  const w = (ms) => page.waitForTimeout(ms)
  await w(1200)
  const box = await page.getByRole('textbox', { name: 'Search prompts and titles' }).boundingBox()
  await page.mouse.move(300, 500)
  await page.mouse.move(box.x + 40, box.y + 15, { steps: 25 })
  await page.mouse.click(box.x + 40, box.y + 15)
  await page.keyboard.type('webhooks', { delay: 110 })
  await w(1500)
  const link = page.getByRole('link', { name: 'Org webhooks launch' }).first()
  const b = await link.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 })
  await w(300)
  await link.click()
  await w(4000)
}`

async function main() {
  const { serveMock } = await import('./demo-local.js')
  const server = await serveMock()
  try {
    // The CLI as people install it, built from this checkout.
    const built = spawnSync('npx', ['tsx', 'scripts/build-packages.ts', 'cli'], {
      cwd: repo,
      encoding: 'utf8',
    })
    if (built.status !== 0) fail('build the CLI', { stderr: built.stderr.slice(-1500) })
    const tour = join(work, 'tour.mjs')
    writeFileSync(tour, TOUR)
    const out = join(work, 'take')
    const args = [
      join(repo, 'packages', 'cli', 'dist', 'bin.js'),
      ...['record', 'http://localhost:4398/', '--script', tour, '--headless', '--out', out, '--json'],
      ...(dry ? [] : ['--make', PROMPT]),
    ]
    const t = Date.now()
    const r = spawnSync(process.execPath, args, {
      cwd: work,
      encoding: 'utf8',
      timeout: 10 * 60_000,
      env: dry ? { ...process.env, VIDEO_AGENT_URL: '', VIDEO_AGENT_KEY: '' } : process.env,
    })
    if (r.status !== 0) fail('video-agent record', { code: r.status, stderr: r.stderr.slice(-2000) })
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as {
      file: string
      trace: string
      seconds: number
      width: number
      clicks: number
      video?: { id: string; latestVersion: number }
    }
    log('recorded', {
      seconds: result.seconds,
      width: result.width,
      clicks: result.clicks,
      ms: Date.now() - t,
    })
    if (!existsSync(result.file) || result.width !== 2560) fail('the recording is missing or not 2x', result)
    const trace = parseTrace(readFileSync(result.trace, 'utf8'))
    if (trace.events.filter((e) => e.kind === 'click').length < 2) fail('the trace has fewer than 2 clicks')
    if (dry)
      dryRun({
        script: 'scripts/e2e/demo-cli.ts',
        required: { VIDEO_AGENT_URL: base || undefined, VIDEO_AGENT_KEY: key || undefined },
        optional: { CREDIT_CEILING: env.CREDIT_CEILING },
        steps: [
          'record the tour with the built CLI (done above: 2x, pointer trace)',
          'the same with --make: upload with the trace, make the demo',
          'wait (40 min at most), check ready, HyperFrames, the recording and its trace, summary, captions, bundle',
          publish ? 'publish it; log the share page and the MP4' : 'leave it unpublished (--no-publish)',
          'report credits',
        ],
        credits: { projected: perDemo, ceiling, under: perDemo <= ceiling },
        problems:
          perDemo > ceiling ? [`projected ${String(perDemo)} is over CREDIT_CEILING ${String(ceiling)}`] : [],
      })
    return result.video ?? fail('record --make made no video', result)
  } finally {
    server.kill()
  }
}

type Version = {
  n: number
  status: string
  editing?: { engine?: string }
  usage?: { totalCreditsCost?: number } | null
  recording?: { trace: boolean; summary: { steps: number } | null } | null
}
if (!dry && (!base || !key)) fail('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (or run --dry).')
if (!dry && !env.LT3_VIDEO && perDemo > ceiling) fail('projected credits over CREDIT_CEILING', { perDemo, ceiling })
// LT3_VIDEO=vid_… checks (and publishes) a demo this script already made, without recording or spending again.
const made = env.LT3_VIDEO ? { id: env.LT3_VIDEO } : await main()
log('created', { id: made.id })
let v: Version | undefined
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  v = ((await api('GET', `/api/v1/videos/${made.id}`)).json as { versions: Version[] }).versions.at(0)
  if (v && ['ready', 'failed', 'timed_out', 'cancelled'].includes(v.status)) break
}
const done = v ?? fail('the version vanished')
const checks: Record<string, boolean> = {
  ready: done.status === 'ready',
  hyperframes: done.editing?.engine === 'hyperframes',
  trace: done.recording?.trace === true,
  steps: (done.recording?.summary?.steps ?? 0) > 0,
}
if (done.status === 'ready') {
  // WebVTT, not JSON: fetched directly.
  const vtt = await fetch(`${base}/api/v1/videos/${made.id}/versions/${String(done.n)}/captions`, {
    headers: { authorization: `Bearer ${key}` },
  })
  checks.captions = vtt.ok && (await vtt.text()).startsWith('WEBVTT')
  const link = (await api('GET', `/api/v1/videos/${made.id}/versions/${String(done.n)}/preview`)).json as {
    url: string
  }
  const html = await (await fetch(new URL('index.html', link.url))).text()
  checks.recording_scenes = /data-va-recording=/.test(html)
}
const credits = done.usage?.totalCreditsCost ?? null
log('checks', { id: made.id, n: done.n, ...checks, credits })
if (Object.values(checks).some((ok) => !ok)) fail('LT-3 checks failed', checks)
let share: Record<string, unknown> | null = null
if (publish) {
  const p = await api('POST', `/api/v1/videos/${made.id}/versions/${String(done.n)}/publish`, {})
  if (p.status !== 200) fail('publish', { status: p.status, body: p.json })
  share = p.json as Record<string, unknown>
}
log('PASS', {
  id: made.id,
  page: `${base}/videos/${made.id}`,
  share: (share?.urls) ?? null,
  credits,
  seconds: Math.round((Date.now() - started) / 1000),
})
