// --selftest for the GitHub Action's live test (bead va-mg4i.2.16): the phase 1 scenarios against the action's test
// harness (the real app in-process, a fake GitHub, no credits, no network), the --dry plan, the credit ceiling, and
// secrets kept out of every log.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { png } from '../../test/helpers.js'
import { events, makeEnv, runAction, type TestEnv } from '../../packages/action/test/harness/index.js'
import {
  PHASE1,
  projectedRuns,
  runScenarios,
  type Driver,
  type ScenarioContext,
  type VideoSummary,
} from './lib/github-action-scenarios.js'

const SHOT = 'https://img.example.com/e2e-shot.png'

/** The scenarios' Driver over the in-process harness; every action run's logs are kept for the secrets check. */
function harnessDriver(env: TestEnv, logs: string[]): Driver {
  let nextPr = 100
  let nextRun = 9000
  const lastRun = new Map<number, string>()
  const act = async (
    event: Parameters<typeof runAction>[1]['event'],
    runId = String(nextRun++),
    inputs: Record<string, string> = {},
  ) => {
    const r = await runAction(env, { event, runId, inputs: { 'max-runs-per-day': '20', ...inputs } })
    logs.push(...r.logs, ...(r.failed ? [r.failed] : []))
    if (r.failed) throw new Error(r.failed)
    return runId
  }
  const json = async (path: string) => env.h.json(await env.h.call('GET', path, { key: env.key }))
  return {
    name: 'selftest',
    async openPr({ title, body }) {
      const n = nextPr++
      env.images.files.set(SHOT, { bytes: new Uint8Array(png()), type: 'image/png' })
      env.gh.pull({
        number: n,
        title,
        body: `${body}\n\n![the new screen](${SHOT})`,
        user: { login: 'dana' },
        files: ['app/routes/webhooks.tsx'],
      })
      return n
    },
    async editPr(n, body) {
      const p = env.gh.state.pulls.get(n)
      if (p) p.body = body
    },
    async label(n) {
      lastRun.set(n, await act(events.labeled(env.gh, n)))
    },
    async unlabel(n) {
      const p = env.gh.state.pulls.get(n)
      if (p) p.labels = p.labels.filter((l) => l !== 'video')
    },
    async comment(n, body) {
      await act(events.comment(env.gh, n, body))
    },
    async labelAndComment(n, body) {
      const labeled = events.labeled(env.gh, n)
      const commented = events.comment(env.gh, n, body)
      await Promise.all([act(labeled), act(commented)])
    },
    async rerun(n) {
      await act(events.labeled(env.gh, n), lastRun.get(n))
    },
    async release(tag, notes) {
      env.gh.release({ tag_name: tag, body: notes })
      await act(events.push(env.gh), undefined, { target: `release/${tag}` })
    },
    async sticky(n) {
      return (
        env.gh.state.comments.filter((c) => c.issue === n && c.user.login === 'github-actions[bot]').at(-1)
          ?.body ?? null
      )
    },
    async releaseBody(tag) {
      return env.gh.state.releases.find((r) => r.tag_name === tag)?.body ?? ''
    },
    async videosFor(ref) {
      const page = await json(`/api/v1/videos?owner=me&limit=50&q=${encodeURIComponent(ref)}`)
      return (page.items as (VideoSummary & { createdAt: string })[])
        .filter((v) => v.versions.some((x) => x.prompt.trimEnd().endsWith(ref)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },
    async library(prefix) {
      const page = await json('/api/v1/media?limit=50')
      return (page.items as { id: string; caption: string | null }[])
        .filter((m) => (m.caption ?? '').startsWith(prefix))
        .map((m) => m.id)
    },
  }
}

describe('github-action live test, in-process', () => {
  it('runs every phase 1 scenario against the harness, within the projected runs, with no secret in any log', async () => {
    const env = await makeEnv()
    const logs: string[] = []
    const d = harnessDriver(env, logs)
    const ctx: ScenarioContext = { owner: 'acme', repo: 'web', prs: {}, tag: 'v9.9.9' }
    const steps: string[] = []
    const done = await runScenarios(d, PHASE1, ctx, {
      ceiling: 10_000,
      perRun: 150,
      spent: async () => 0,
      log: (step, f) => steps.push(JSON.stringify({ step, ...f })),
    })
    expect(done).toEqual(PHASE1.map((s) => s.name))
    const all = await env.h.json(
      await env.h.call('GET', '/api/v1/videos?owner=me&limit=50', { key: env.key }),
    )
    // Runs started: a video per new PR and the release, plus v2; never more than the plan projects.
    const runs = (all.items as { versions: unknown[] }[]).reduce((n, v) => n + v.versions.length, 0)
    expect(runs).toBeLessThanOrEqual(projectedRuns(PHASE1))
    const text = [...logs, ...steps].join('\n')
    expect(text).not.toContain(env.key)
    expect(text).not.toContain('ghs_faketoken')
  })

  it('stops before a scenario that would pass the ceiling', async () => {
    const env = await makeEnv()
    const steps: { step: string; scenario?: string }[] = []
    const done = await runScenarios(
      harnessDriver(env, []),
      PHASE1,
      { owner: 'acme', repo: 'web', prs: {}, tag: 't' },
      {
        ceiling: 200,
        perRun: 150,
        spent: async () => 100,
        log: (step, f) => steps.push({ step, ...(f as { scenario?: string }) }),
      },
    )
    expect(done).toEqual([])
    expect(steps).toEqual([expect.objectContaining({ step: 'ceiling', scenario: 'label' })])
  })

  it('--dry prints the plan and the projected credits, makes no requests and never prints the token or key', () => {
    const r = spawnSync('npx', ['tsx', join(import.meta.dirname, 'github-action.ts'), '--dry'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        VIDEO_AGENT_URL: 'https://videos.acme.com',
        VIDEO_AGENT_KEY: 'nva_k_supersecretvalue',
        SANDBOX_REPO: 'acme/sandbox',
        GH_TOKEN: 'ghp_notarealtokenvalue000000000',
        ACTION_REF: '0123456789abcdef0123456789abcdef01234567',
      },
    })
    const lines = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const steps = lines.filter((l) => l.step === 'dry_step').map((l) => l.what as string)
    expect(steps[0]).toContain('0123456789ab is on origin')
    expect(steps.some((s) => s.startsWith('label (≈150 credits)'))).toBe(true)
    expect(steps.some((s) => s.startsWith('rerun (no new run)'))).toBe(true)
    expect(lines.find((l) => l.step === 'dry_credits')).toMatchObject({
      runs: projectedRuns(PHASE1),
      projected: projectedRuns(PHASE1) * 150,
      ceiling: 600,
    })
    expect(r.stdout).not.toContain('supersecretvalue')
    expect(r.stdout).not.toContain('ghp_notarealtoken')
    expect(lines.at(-1)?.network).toBe('none')
  })
})
