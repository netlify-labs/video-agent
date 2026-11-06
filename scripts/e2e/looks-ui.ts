// Live check for looks phase 3 (docs/plans/2026-11-04-looks.md §11 LT-2, bead va-nifa.4.10): the server paths the
// app's pickers use, on production. Spends credits: three runs of about LOOK_RUN_CREDITS (default 150) each, plus a
// few for the planner; CREDIT_CEILING (default 500) refuses a run once the total reaches it. What only a person can
// judge (the picker, previews, wording) is left for them; the summary lists the videos to look at.
//
//   npx tsx scripts/e2e/looks-ui.ts --dry   # checks the env, prints the steps and credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [CREDIT_CEILING=500] npx tsx scripts/e2e/looks-ui.ts
//
// Steps, each logged as one JSON line:
//   1. Plan a 15 s video with no look chosen: the plan picks one from its template (plan.look, chosen false); the
//      brief's planner calls get chosen_look. Create from the plan: version.look is the plan's, version.plan is set.
//   2. Remix that video into another look (the Remix dialog's Look control): the remix's version has that look.
//   3. Restyle the first video into a third look (the Restyle dialog): v2 has it.
// The videos are kept for the person to review. Never prints env vars.
import { key, log } from './lib.js'
import { CreditMeter } from './looks-lib.js'
import { call, check, dry, dryRun, GateError, sleep } from './narration-lib.js'

const env = process.env
const ceiling = Number(env.CREDIT_CEILING ?? 500)
const perRun = Number(env.LOOK_RUN_CREDITS ?? 150)
const site = (env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
const PROMPT =
  'A 15-second launch video for Lumen, a shared notebook for small teams. The news: instant search across everything. End with "Try Lumen free".'

const STEPS = [
  `plan a 15 s video with no look (≈5 planner credits): plan.look is picked from the template; brief; create from the plan (≈${perRun} credits): version.look is the plan's`,
  `remix it into another enabled look (≈${perRun} credits): the remix has that look`,
  `restyle the first video into a third look (≈${perRun} credits): v2 has it`,
  `credits: no run starts once the total reaches CREDIT_CEILING ${ceiling}`,
  'keep the videos for review',
]

interface Version {
  n: number
  status: string
  look: { id: string } | null
  plan: { planId: string } | null
  usage: { totalCreditsCost: number | null } | null
}
interface Video {
  id: string
  versions: Version[]
}

async function main() {
  if (dry)
    dryRun({
      script: 'looks-ui',
      required: { VIDEO_AGENT_URL: env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY },
      optional: { CREDIT_CEILING: env.CREDIT_CEILING, LOOK_RUN_CREDITS: env.LOOK_RUN_CREDITS },
      steps: STEPS,
      credits: {
        projected: 3 * perRun + 5,
        runs: 3,
        perRun,
        ceiling,
        note: 3 * perRun + 5 > ceiling ? 'over the ceiling' : 'within the ceiling',
      },
      problems: ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number'],
    })

  const meter = new CreditMeter(ceiling, perRun)
  const made: { step: string; videoId: string; n: number; look: string | null; credits: number | null }[] = []
  const wait = async (id: string, n: number) => {
    for (const deadline = Date.now() + 30 * 60_000; ;) {
      const v = (await call<Video>(key, 'GET', `/api/v1/videos/${id}`)).json.versions.find((x) => x.n === n)
      if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) return v
      check(Date.now() < deadline, 'ready in 30 minutes', { id, n })
      await sleep(10_000)
    }
  }
  const finish = async (step: string, id: string, n: number, t: number) => {
    const v = await wait(id, n)
    const credits = v.usage?.totalCreditsCost ?? null
    meter.record(credits)
    made.push({ step, videoId: id, n, look: v.look?.id ?? null, credits })
    log(step, { videoId: id, n, status: v.status, look: v.look?.id ?? null, ms: Date.now() - t, credits })
    check(v.status === 'ready', `${step} is ready`, { id, n, status: v.status })
    return v
  }
  try {
    const looks = (
      await call<{ looks: { id: string; name: string; enabled: boolean }[] }>(key, 'GET', '/api/v1/looks')
    ).json.looks.filter((l) => l.enabled)
    check(looks.length >= 3, 'at least three enabled looks', { looks: looks.map((l) => l.id) })

    // 1. A plan picks a look; the video made from it uses it.
    check(meter.canStart(), `credit ceiling ${ceiling} reached before the planned create`)
    let t = Date.now()
    const plan = await call<{ id: string; look: { id: string | null; chosen: boolean } | null }>(
      key,
      'POST',
      '/api/v1/plans',
      { prompt: PROMPT, aspect: '16:9', durationSec: 15 },
    )
    check(plan.status === 201, 'create a plan', { status: plan.status, body: plan.json })
    log('plan', { planId: plan.json.id, look: plan.json.look })
    check(
      plan.json.look?.chosen === false && !!plan.json.look.id,
      'the plan picked a look from its template',
      {
        look: plan.json.look,
      },
    )
    const planLook = plan.json.look.id
    check(
      (await call(key, 'POST', `/api/v1/plans/${plan.json.id}/questions`)).status === 200,
      'plan questions',
    )
    check(
      (await call(key, 'POST', `/api/v1/plans/${plan.json.id}/brief`, { answers: [] })).status === 200,
      'plan brief',
    )
    const first = await call<Video>(key, 'POST', '/api/v1/videos', { prompt: PROMPT, planId: plan.json.id })
    check(first.status === 202, 'create from the plan', { status: first.status, body: first.json })
    const v1 = await finish('planned', first.json.id, 1, t)
    check(v1.look?.id === planLook, "the video has the plan's look", { look: v1.look, planLook })
    check(v1.plan?.planId === plan.json.id, 'the version keeps its plan', { plan: v1.plan })

    // 2. A remix in another look.
    const other = looks.find((l) => l.id !== planLook)
    check(!!other, 'another look to remix into')
    check(meter.canStart(), `credit ceiling ${ceiling} reached before the remix`, { total: meter.total })
    t = Date.now()
    const remix = await call<Video>(key, 'POST', `/api/v1/videos/${first.json.id}/remix`, {
      prompt: 'The same story for the payments team.',
      fromVersion: 1,
      look: other.id,
    })
    check(remix.status === 202, 'remix with a look', { status: remix.status, body: remix.json })
    const r1 = await finish('remix', remix.json.id, 1, t)
    check(r1.look?.id === other.id, 'the remix has the picked look', { look: r1.look })

    // 3. Restyle the first video into a third look.
    const third = looks.find((l) => l.id !== planLook && l.id !== other.id)
    check(!!third, 'a third look to restyle into')
    check(meter.canStart(), `credit ceiling ${ceiling} reached before the restyle`, { total: meter.total })
    t = Date.now()
    const restyle = await call<Video>(key, 'POST', `/api/v1/videos/${first.json.id}/versions`, {
      prompt: `Restyle this video in the ${third.name} look.`,
      fromVersion: 1,
      look: third.id,
    })
    check(restyle.status === 202, 'restyle', { status: restyle.status, body: restyle.json })
    const v2 = await finish('restyle', first.json.id, 2, t)
    check(v2.look?.id === third.id, 'v2 has the new look', { look: v2.look })

    log('summary', {
      ok: true,
      credits: meter.total,
      videos: made.map((m) => ({ ...m, page: `${site}/videos/${m.videoId}` })),
    })
  } catch (e) {
    log('FAIL', {
      msg: e instanceof Error ? e.message : String(e),
      ...(e instanceof GateError ? e.fields : {}),
      credits: meter.total,
      videos: made,
    })
    process.exitCode = 1
  }
}

if (process.argv[1]?.endsWith('looks-ui.ts')) await main()
