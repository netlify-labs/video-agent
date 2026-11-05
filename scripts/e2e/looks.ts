// Live check for looks (docs/plans/2026-11-04-looks.md §11, bead va-nifa.3.15). Spends credits: one 15 s video per look
// in LOOKS, one restyle (RESTYLE=1), and with RETRY_CHECK=1 one cancelled-then-retried run, each about
// LOOK_RUN_CREDITS (default 140, from spike K2). CREDIT_CEILING (default 700) refuses to start a run once the credits so
// far (runs without a reported cost counted at LOOK_RUN_CREDITS) have reached it.
//
//   npx tsx scripts/e2e/looks.ts --dry       # checks the env and local tools, prints the steps and credits; no network
//   npx tsx scripts/e2e/looks.ts --selftest  # the offline checks on fixtures; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [LOOKS=clean,kinetic,terminal] [CREDIT_CEILING=700] \
//     [RESTYLE=1] [RETRY_CHECK=0] [FONT_LOOKS=…] npx tsx scripts/e2e/looks.ts [--keep]
//
// Steps, each logged as one JSON line ({"step":"create","look":"kinetic","videoId":…,"ms":…,"credits":…}):
//   1. For each look: create a 15 s 16:9 video from a fixed prompt with that look; wait for ready; check version.look,
//      that it's editable, and the download; save a contact sheet (6 frames, ffmpeg) to out/looks/<id>.png.
//   2. RESTYLE=1: revise the first video into the second look; wait; check the look changed, every scene and text id
//      was kept (from each version's draft composition), and every colour role is a literal colour.
//   3. RETRY_CHECK=1: create a video with the first look and cancel it at once; record its look hash; wait (up to 20
//      min) for that look's catalog hash to change (someone pushes a trivial LOOK.md change to main meanwhile); retry
//      it, wait for ready, and check it kept the recorded hash.
//   4. FONT_LOOKS: each such look's preview has an @font-face under assets/look/ (phase 4.3's shipped fonts).
// Deletes what it made unless --keep. Exits non-zero on failure. Never prints env vars.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { key, log } from './lib.js'
import {
  colorProblems,
  contactSheet,
  CreditMeter,
  idProblems,
  waitForHashChange,
  type DraftComposition,
} from './looks-lib.js'
import { call, check, download, dry, dryRun, GateError, sleep } from './narration-lib.js'

const env = process.env
const keep = process.argv.includes('--keep')
const FFMPEG = env.FFMPEG ?? 'ffmpeg'
const looks = (env.LOOKS ?? 'clean,kinetic,terminal')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ceiling = Number(env.CREDIT_CEILING ?? 700)
const perRun = Number(env.LOOK_RUN_CREDITS ?? 140)
const restyle = (env.RESTYLE ?? '1') === '1'
const retryCheck = env.RETRY_CHECK === '1'
const fontLooks = (env.FONT_LOOKS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const waitMinutes = Number(env.WAIT_MINUTES ?? 20)
const PROMPT =
  'A 15-second launch video for Lumen, a shared notebook for small teams. The news: instant search across everything. End with "Try Lumen free".'

const tool = (bin: string) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0
const runs = looks.length + (restyle && looks.length > 1 ? 1 : 0) + (retryCheck ? 1 : 0)
const projected = runs * perRun

export const STEPS = [
  ...looks.map(
    (l) =>
      `create a 15 s 16:9 video in the ${l} look (≈${perRun} credits): wait ready; version.look is ${l}; editable; download; contact sheet${tool(FFMPEG) ? '' : ' (no ffmpeg: skipped, weak check)'}`,
  ),
  restyle && looks.length > 1
    ? `restyle the ${looks[0]} video into ${looks[1]} (≈${perRun} credits): the look changed; every scene and text id kept; colour roles literal`
    : 'restyle skipped (RESTYLE=0 or one look)',
  retryCheck
    ? `retry after a look change (≈${perRun} credits): create in ${looks[0]}, cancel, wait up to ${waitMinutes} min for its catalog hash to change (push a trivial looks/${looks[0]}/LOOK.md change to main meanwhile), retry: the version keeps its original hash`
    : 'retry-after-look-change skipped (set RETRY_CHECK=1)',
  fontLooks.length
    ? `font check for ${fontLooks.join(', ')}: @font-face under assets/look/`
    : 'font check skipped',
  `credits: each run's usage.totalCreditsCost and the total; no run starts once the total reaches CREDIT_CEILING ${ceiling}`,
  keep ? 'keep the videos (--keep)' : 'delete the videos (pass --keep to keep them)',
]

interface Version {
  n: number
  status: string
  editable?: boolean
  look: { id: string; name: string; hash?: string } | null
  usage: { totalCreditsCost?: number } | null
  output: { durationSec: number } | null
  links: { video: string }
}
interface Video {
  id: string
  versions: Version[]
}

async function selftest() {
  const before: DraftComposition = {
    beats: [
      { id: 'a', texts: [{ id: 'a-t' }] },
      { id: 'b', texts: [] },
    ],
    colors: {},
  }
  check(idProblems(before, before).length === 0, 'ids kept')
  check(idProblems(before, { ...before, beats: [...before.beats].reverse() }).length === 1, 'reorder seen')
  check(colorProblems({ glow: 'color-mix(in srgb, red, white)' }).length === 1, 'color-mix refused')
  let t = 0
  const changed = await waitForHashChange({
    from: 'h1',
    hash: async () => (t >= 2 ? 'h2' : 'h1'),
    timeoutMs: 10,
    intervalMs: 1,
    now: () => t,
    sleep: async () => {
      t++
    },
  })
  check(changed === 'h2', 'hash change seen')
  const meter = new CreditMeter(100, 60)
  meter.record(50)
  check(meter.canStart(), 'under the ceiling')
  meter.record(null)
  check(!meter.canStart(), 'refused at the ceiling')
  log('selftest', { ok: true })
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest()
  if (dry)
    dryRun({
      script: 'looks',
      required: { VIDEO_AGENT_URL: env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY },
      optional: {
        LOOKS: env.LOOKS,
        CREDIT_CEILING: env.CREDIT_CEILING,
        LOOK_RUN_CREDITS: env.LOOK_RUN_CREDITS,
        RESTYLE: env.RESTYLE,
        RETRY_CHECK: env.RETRY_CHECK,
        FONT_LOOKS: env.FONT_LOOKS,
        FFMPEG: env.FFMPEG,
      },
      steps: STEPS,
      credits: {
        projected,
        runs,
        perRun,
        ceiling,
        note:
          projected > ceiling
            ? `the projection is over the ceiling: a run is refused once the running total reaches ${ceiling}`
            : 'within the ceiling',
      },
      problems: [
        ...(looks.length ? [] : ['LOOKS lists no look']),
        ...(ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number']),
        ...fontLooks.filter((l) => !looks.includes(l)).map((l) => `FONT_LOOKS has ${l}, which LOOKS doesn't`),
      ],
    })

  const meter = new CreditMeter(ceiling, perRun)
  const made: string[] = []
  const work = mkdtempSync(join(tmpdir(), 'nva-looks-'))
  const out = join('out', 'looks')
  mkdirSync(out, { recursive: true })

  const getVideo = async (id: string) => {
    const r = await call<Video>(key, 'GET', `/api/v1/videos/${id}`)
    check(r.status === 200, 'get video', { id, status: r.status })
    return r.json
  }
  const waitFor = async (id: string, n: number) => {
    const deadline = Date.now() + 30 * 60_000
    for (;;) {
      const v = (await getVideo(id)).versions.find((x) => x.n === n)
      if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) return v
      check(Date.now() < deadline, 'version finished in 30 minutes', { id, n })
      await sleep(10_000)
    }
  }
  const run = async (step: string, look: string, start: () => Promise<{ id: string; n: number }>) => {
    check(meter.canStart(), `credit ceiling ${ceiling} reached before ${step}`, { total: meter.total })
    const t = Date.now()
    const { id, n } = await start()
    const v = await waitFor(id, n)
    meter.record(v.usage?.totalCreditsCost)
    log(step, {
      look,
      videoId: id,
      n,
      status: v.status,
      ms: Date.now() - t,
      credits: v.usage?.totalCreditsCost ?? null,
    })
    check(v.status === 'ready', `${step} is ready`, { id, n, status: v.status })
    return { id, v }
  }
  const draft = async (id: string, n: number) => {
    const r = await call<{ composition: DraftComposition }>(
      key,
      'POST',
      `/api/v1/videos/${id}/versions/${n}/edits`,
    )
    check(r.status === 200 || r.status === 201, 'open draft', { id, n, status: r.status })
    return r.json.composition
  }

  try {
    const first: Record<string, string> = {}
    for (const look of looks) {
      const { id, v } = await run('create', look, async () => {
        const r = await call<{ id: string }>(key, 'POST', '/api/v1/videos', {
          prompt: PROMPT,
          aspect: '16:9',
          durationSec: 15,
          look,
        })
        check(r.status === 202, 'create with a look', { look, status: r.status, body: r.json })
        made.push(r.json.id)
        return { id: r.json.id, n: 1 }
      })
      first[look] = id
      check(v.look?.id === look, 'version.look is the look', { id, look: v.look })
      check(v.editable !== false, 'the result is editable', { id })
      const mp4 = join(work, `${look}.mp4`)
      const file = await download(key, v.links.video)
      check(file.status === 200, 'download the video', { look, status: file.status })
      writeFileSync(mp4, file.bytes)
      if (!contactSheet(FFMPEG, mp4, join(out, `${look}.png`), v.output?.durationSec ?? 15))
        log('weak', { check: 'contact sheet', look, reason: 'no ffmpeg' })
    }
    if (restyle && looks.length > 1) {
      const [from = '', to = ''] = looks
      const id = first[from] ?? ''
      const { v } = await run('restyle', to, async () => {
        const r = await call(key, 'POST', `/api/v1/videos/${id}/revise`, {
          prompt: `Restyle this video in the ${to} look.`,
          look: to,
        })
        check(r.status === 202, 'restyle', { status: r.status, body: r.json })
        return { id, n: 2 }
      })
      check(v.look?.id === to, 'the restyle changed the look', { look: v.look })
      const problems = [
        ...idProblems(await draft(id, 1), await draft(id, 2)),
        ...colorProblems((await draft(id, 2)).colors),
      ]
      check(problems.length === 0, 'the restyle kept the story and wrote literal colours', { problems })
    }
    if (retryCheck) {
      const look = looks[0] ?? ''
      const r = await call<{ id: string; versions: Version[] }>(key, 'POST', '/api/v1/videos', {
        prompt: PROMPT,
        durationSec: 15,
        look,
      })
      check(r.status === 202, 'create for the retry check', { status: r.status })
      made.push(r.json.id)
      await call(key, 'POST', `/api/v1/videos/${r.json.id}/versions/1/cancel`)
      const recorded = (await waitFor(r.json.id, 1)).look?.hash ?? ''
      check(recorded !== '', 'the cancelled version has a look hash', {})
      log('waiting', {
        msg: `push a trivial change to looks/${look}/LOOK.md to main now; waiting up to ${waitMinutes} min`,
      })
      const changed = await waitForHashChange({
        from: recorded,
        hash: async () =>
          (
            await call<{ looks: { id: string; hash: string }[] }>(key, 'GET', '/api/v1/looks')
          ).json.looks.find((l) => l.id === look)?.hash ?? null,
        timeoutMs: waitMinutes * 60_000,
        intervalMs: 30_000,
        onPoll: (current, waited) => log('poll', { look, current, waitedMs: waited }),
      })
      check(changed !== null, `the ${look} look's catalog hash changed within ${waitMinutes} min`)
      const { v } = await run('retry', look, async () => {
        const rr = await call(key, 'POST', `/api/v1/videos/${r.json.id}/versions/1/retry`)
        check(rr.status === 202, 'retry', { status: rr.status })
        return { id: r.json.id, n: 1 }
      })
      check(v.look?.hash === recorded, 'the retry kept the original snapshot', {
        recorded,
        now: v.look?.hash,
      })
    }
    for (const look of fontLooks) {
      const r = await call<{ url: string }>(key, 'GET', `/api/v1/videos/${first[look]}/versions/1/preview`)
      const html = r.status === 200 ? await (await fetch(r.json.url)).text().catch(() => '') : ''
      if (!html.includes('<'))
        log('weak', { check: 'font', look, reason: "the preview couldn't be read as HTML" })
      else check(/@font-face[^}]*assets\/look\//.test(html), 'the look font is used', { look })
    }
    log('summary', { ok: true, runs: meter.used, credits: meter.total })
  } catch (e) {
    log('FAIL', {
      msg: e instanceof Error ? e.message : String(e),
      ...(e instanceof GateError ? e.fields : {}),
    })
    process.exitCode = 1
  } finally {
    if (!keep) for (const id of made) await call(key, 'DELETE', `/api/v1/videos/${id}`)
  }
}

if (process.argv[1]?.endsWith('looks.ts')) await main()
