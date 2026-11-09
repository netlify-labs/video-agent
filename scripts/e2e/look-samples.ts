// Sample renders for looks (app/looks/README.md "Adding a look", step 6; beads va-nifa.5.4–5.8). Spends credits: the three
// prompts in app/looks/PROMPTS.md, once per look in LOOKS, each about LOOK_RUN_CREDITS (default 100). Each look has its
// own CREDIT_CEILING (default 300): no run of that look starts once its credits so far have reached it.
//
//   npx tsx scripts/e2e/look-samples.ts --dry   # checks the env and local tools, prints the steps and credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… LOOKS=editorial,data-story [CREDIT_CEILING=300] \
//     npx tsx scripts/e2e/look-samples.ts
//
// Steps, each logged as one JSON line ({"step":"sample","look":…,"prompt":1,"videoId":…,"credits":…}):
//   1. For each look and each prompt: create the video with that look, shape and length; wait for ready; check
//      version.look; download it and save a GIF (ffmpeg) to out/looks/samples/<look>-<n>.gif for the pull request.
//   2. A look that ships a font: its first sample's composition loads it from assets/look/ (logged; a brand with its
//      own font for that role would rightly skip it).
// The videos are kept (they're the samples); the summary lists them with their pages.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksCatalog } from '../../app/server/generated/looks.js'
import { key, log } from './lib.js'
import { CreditMeter } from './looks-lib.js'
import { call, check, download, dry, dryRun, GateError, sleep } from './narration-lib.js'

const env = process.env
const FFMPEG = env.FFMPEG ?? 'ffmpeg'
const looks = (env.LOOKS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ceiling = Number(env.CREDIT_CEILING ?? 300)
const perRun = Number(env.LOOK_RUN_CREDITS ?? 100)
const site = (env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
/** Whether a look ships its own font (look.json fonts). */
const shipsFont = (id: string) => {
  try {
    const j = JSON.parse(readFileSync(new URL(`../../app/looks/${id}/look.json`, import.meta.url), 'utf8')) as {
      fonts?: unknown[]
    }
    return (j.fonts?.length ?? 0) > 0
  } catch {
    return false
  }
}

export interface SamplePrompt {
  n: number
  aspect: '16:9' | '9:16' | '1:1' | '4:5'
  durationSec: number
  prompt: string
}

/** The standard prompts, read from app/looks/PROMPTS.md: "## <n>. …" headings naming a shape and "<seconds> s", over a quote. */
export function samplePrompts(md: string): SamplePrompt[] {
  const out: SamplePrompt[] = []
  for (const part of md.split(/^## /m).slice(1)) {
    const line = part.split('\n')[0] ?? ''
    const n = /^(\d+)\./.exec(line)
    const aspect = /\b(16:9|9:16|1:1|4:5)\b/.exec(line)
    const secs = /\b(\d+)\s*s\b/.exec(line)
    const quote = part
      .split('\n')
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^>\s?/, ''))
      .join(' ')
      .trim()
    if (n && aspect && secs && quote)
      out.push({
        n: Number(n[1]),
        aspect: aspect[1] as SamplePrompt['aspect'],
        durationSec: Number(secs[1]),
        prompt: quote,
      })
  }
  return out
}

const prompts = samplePrompts(readFileSync(new URL('../../app/looks/PROMPTS.md', import.meta.url), 'utf8'))
const tool = (bin: string) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0
const runs = looks.length * prompts.length

interface Version {
  n: number
  status: string
  look: { id: string; hash: string } | null
  usage: { totalCreditsCost: number | null } | null
  links: { video: string }
}

async function main() {
  if (dry)
    dryRun({
      script: 'look-samples',
      required: { VIDEO_AGENT_URL: env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY },
      optional: {
        LOOKS: env.LOOKS,
        CREDIT_CEILING: env.CREDIT_CEILING,
        LOOK_RUN_CREDITS: env.LOOK_RUN_CREDITS,
      },
      steps: [
        ...looks.flatMap((l) =>
          prompts.map(
            (p) =>
              `${l}: prompt ${p.n} (${p.aspect}, ${p.durationSec} s, ≈${perRun} credits): wait ready; version.look is ${l}; GIF to out/looks/samples/${l}-${p.n}.gif${tool(FFMPEG) ? '' : ' (no ffmpeg: no GIF)'}`,
          ),
        ),
        `credits: each look stops starting runs once its total reaches CREDIT_CEILING ${ceiling}`,
        'keep the videos (they are the samples)',
      ],
      credits: {
        projected: runs * perRun,
        runs,
        perRun,
        ceilingPerLook: ceiling,
        ceilingTotal: ceiling * looks.length,
        note: prompts.length * perRun > ceiling ? 'a look would pass its ceiling' : 'within the ceilings',
      },
      problems: [
        ...(looks.length ? [] : ['LOOKS lists no look']),
        ...(prompts.length === 3 ? [] : [`app/looks/PROMPTS.md has ${prompts.length} prompts, not 3`]),
        ...looks
          .filter((l) => !looksCatalog.some((c) => c.id === l))
          .map((l) => `${l} isn't in this build's catalog`),
      ],
    })

  const out = join('out', 'looks', 'samples')
  mkdirSync(out, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'nva-samples-'))
  const made: { look: string; n: number; videoId: string; credits: number | null; page: string }[] = []
  let total = 0
  try {
    const served = (await call<{ looks: { id: string; enabled: boolean }[] }>(key, 'GET', '/api/v1/looks'))
      .json
    for (const look of looks)
      check(
        served.looks.some((l) => l.id === look && l.enabled),
        `${look} is in the deployment's catalog and turned on`,
      )
    for (const look of looks) {
      const meter = new CreditMeter(ceiling, perRun)
      for (const p of prompts) {
        check(meter.canStart(), `${look}: credit ceiling ${ceiling} reached before prompt ${p.n}`, {
          total: meter.total,
        })
        const t = Date.now()
        const r = await call<{ id: string }>(key, 'POST', '/api/v1/videos', {
          prompt: p.prompt,
          aspect: p.aspect,
          durationSec: p.durationSec,
          look,
        })
        check(r.status === 202, 'create with the look', { look, n: p.n, status: r.status, body: r.json })
        const id = r.json.id
        let v: Version | undefined
        for (const deadline = Date.now() + 30 * 60_000; ;) {
          v = (await call<{ versions: Version[] }>(key, 'GET', `/api/v1/videos/${id}`)).json.versions.find(
            (x) => x.n === 1,
          )
          if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) break
          check(Date.now() < deadline, 'ready in 30 minutes', { id })
          await sleep(10_000)
        }
        const credits = v.usage?.totalCreditsCost ?? null
        meter.record(credits)
        total += credits ?? perRun
        made.push({ look, n: p.n, videoId: id, credits, page: `${site}/videos/${id}` })
        log('sample', { look, prompt: p.n, videoId: id, status: v.status, ms: Date.now() - t, credits })
        check(v.status === 'ready', 'the sample is ready', { id, status: v.status })
        check(v.look?.id === look, 'version.look is the look', { id, look: v.look })
        const mp4 = join(work, `${look}-${p.n}.mp4`)
        const file = await download(key, v.links.video)
        check(file.status === 200, 'download the sample', { id, status: file.status })
        writeFileSync(mp4, file.bytes)
        const gif = join(out, `${look}-${p.n}.gif`)
        const ok =
          spawnSync(
            FFMPEG,
            [
              '-y',
              '-loglevel',
              'error',
              '-i',
              mp4,
              '-vf',
              'fps=10,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
              gif,
            ],
            { encoding: 'utf8' },
          ).status === 0
        if (!ok) log('weak', { check: 'gif', look, prompt: p.n, reason: 'ffmpeg failed or missing' })
        if (p.n === 1 && shipsFont(look)) {
          const pr = await call<{ url: string }>(key, 'GET', `/api/v1/videos/${id}/versions/1/preview`)
          const html = pr.status === 200 ? await (await fetch(pr.json.url)).text().catch(() => '') : ''
          log('font', { look, videoId: id, loaded: /@font-face[^}]*assets\/look\//.test(html) })
        }
      }
      log('look', { look, credits: meter.total })
    }
    log('summary', { ok: true, credits: total, videos: made })
  } catch (e) {
    log('FAIL', {
      msg: e instanceof Error ? e.message : String(e),
      ...(e instanceof GateError ? e.fields : {}),
      credits: total,
      videos: made,
    })
    process.exitCode = 1
  }
}

if (process.argv[1]?.endsWith('look-samples.ts')) await main()
