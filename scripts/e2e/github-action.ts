// Live check for the GitHub Action (github-action plan §10, §11; bead va-mg4i.2.16). Spends credits: phase 1 starts
// about 4 runs (PER_RUN = 150 each, from the README's 90-210), so CREDIT_CEILING defaults to 600, and no scenario starts
// once the credits so far plus its runs would pass it. Ask the owner before every live run; --dry first.
//
//   npx tsx scripts/e2e/github-action.ts --dry [--phase 1]    # checks env and tools, prints the plan and credits
//   npx tsx scripts/e2e/github-action.ts --selftest           # the same scenarios in-process (no network, no credits)
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SANDBOX_REPO=netlify-labs/video-agent-action-sandbox \
//     GH_TOKEN=<a PAT that can push, label, comment and release there> [ACTION_REF=<sha>] [CREDIT_CEILING=600] \
//     npx tsx scripts/e2e/github-action.ts [--keep]
//
// GH_TOKEN must not be a GITHUB_TOKEN: events made with one never start workflows. ACTION_REF (default HEAD) must be
// pushed to origin with a fresh packages/action/dist (npm run action:check). While netlify-labs/video-agent is private,
// its Actions access must be "organization" (spike A2); the script checks it and never changes it.
//
// Setup commits three workflows to the sandbox's default branch (issue_comment and workflow_dispatch workflows only run
// from there), pinned to netlify-labs/video-agent/packages/action@<ACTION_REF>, and sets the VIDEO_AGENT_URL variable and
// the VIDEO_AGENT_KEY secret (the key goes on stdin, never on a command line or in a log). Then the phase 1 scenarios in
// scripts/e2e/lib/github-action-scenarios.ts run, each logged as JSON lines with the credits so far. Cleanup (unless
// --keep): close the PRs and delete their branches, delete the release and tag, the videos and leftover library items.
// Exits non-zero on failure, with the failing workflow run's URL when there is one.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base, key, log, sdk } from './lib.js'
import { dry, dryRun } from './narration-lib.js'
import {
  PHASE1,
  PHASE2,
  PHASE3,
  projectedRuns,
  runScenarios,
  ScenarioError,
  type Driver,
  type ScenarioContext,
} from './lib/github-action-scenarios.js'

const env = process.env
const keep = process.argv.includes('--keep')
const phase = Number(/--phase[= ](\d)/.exec(process.argv.join(' '))?.[1] ?? '1')
const sandbox = env.SANDBOX_REPO ?? ''
const ghToken = env.GH_TOKEN ?? ''
const ceiling = Number(env.CREDIT_CEILING ?? (phase === 2 ? 900 : phase === 3 ? 450 : 600))
const baseVideo = env.BASE_VIDEO ?? ''
const perRun = Number(env.PER_RUN ?? 150)
const runTimeoutMin = Number(env.RUN_TIMEOUT_MINUTES ?? 45)
const THIS_REPO = 'netlify-labs/video-agent'

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' })
const actionRef = env.ACTION_REF ?? git('rev-parse', 'HEAD').stdout.trim()
const scenarios = phase === 1 ? PHASE1 : phase === 2 ? PHASE2 : phase === 3 ? PHASE3 : []

if (process.argv.includes('--selftest')) {
  const r = spawnSync('npx', ['vitest', 'run', 'scripts/e2e/github-action.test.ts'], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

if (dry) {
  const tool = (bin: string, arg = '--version') => spawnSync(bin, [arg], { encoding: 'utf8' }).status === 0
  const problems: string[] = []
  if (!tool('gh')) problems.push('the gh CLI is needed')
  if (phase < 1 || phase > 3)
    problems.push(`there are no phase ${phase} scenarios (4's live test uses only the README)`)
  if (phase === 2 && !baseVideo)
    problems.push('phase 2 needs BASE_VIDEO: a ready video the CI account can see')
  if (sandbox && !/^[\w.-]+\/[\w.-]+$/.test(sandbox)) problems.push('SANDBOX_REPO must be owner/name')
  dryRun({
    script: 'github-action',
    required: {
      VIDEO_AGENT_URL: base || undefined,
      VIDEO_AGENT_KEY: key || undefined,
      SANDBOX_REPO: sandbox || undefined,
      // Never printed: only whether it's set.
      GH_TOKEN: ghToken ? 'set' : undefined,
    },
    optional: {
      ACTION_REF: actionRef,
      CREDIT_CEILING: String(ceiling),
      PER_RUN: String(perRun),
      ...(phase === 2 ? { BASE_VIDEO: baseVideo || undefined } : {}),
    },
    steps: [
      `check: ${actionRef.slice(0, 12)} is on origin with a fresh packages/action/dist; ${THIS_REPO}'s Actions access is "organization" (checked, never changed)`,
      `setup: commit pr-video.yml, pr-video-commands.yml and release-video.yml to ${sandbox || 'SANDBOX_REPO'}'s default branch, pinned to ${THIS_REPO}/packages/action@${actionRef.slice(0, 12)}; set the VIDEO_AGENT_URL variable and the VIDEO_AGENT_KEY secret (stdin)`,
      ...scenarios.map(
        (s) => `${s.name} (${s.runs ? `≈${s.runs * perRun} credits` : 'no new run'}): ${s.what}`,
      ),
      `credits: each video's usage.totalCreditsCost; a scenario doesn't start once the total plus its runs would pass CREDIT_CEILING ${ceiling}`,
      keep
        ? 'keep everything (--keep)'
        : 'cleanup: close the PRs and delete their branches, the release and tag, the videos and leftover library items',
    ],
    credits: {
      runs: projectedRuns(scenarios),
      perRun,
      projected: projectedRuns(scenarios) * perRun,
      ceiling,
    },
    problems,
  })
}

// ───── the live driver ─────

function gh(args: string[], input?: string): string {
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    env: { ...env, GH_TOKEN: ghToken },
    ...(input !== undefined ? { input } : {}),
  })
  if (r.status !== 0)
    throw new ScenarioError(`gh ${args.slice(0, 2).join(' ')} failed`, { stderr: r.stderr.slice(0, 500) })
  return r.stdout
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
const ghJson = <T>(args: string[]): T => JSON.parse(gh(args)) as T
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const pin = `${THIS_REPO}/packages/action@${actionRef} # e2e`
const WORKFLOWS: Record<string, string> = {
  'pr-video.yml': `name: PR video (e2e)
on:
  pull_request:
    types: [labeled, synchronize]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: pr-video-\${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  video:
    if: contains(github.event.pull_request.labels.*.name, 'video')
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${pin}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }}
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          max-runs-per-day: '20'
          on-push: revise
`,
  'pr-video-commands.yml': `name: PR video commands (e2e)
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
jobs:
  command:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/video')
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${pin}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }}
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          max-runs-per-day: '20'
`,
  'release-video.yml': `name: Release video (e2e)
on:
  workflow_dispatch:
    inputs:
      tag:
        required: true
      base_video:
        default: ''
      publish:
        default: 'false'
      release_asset:
        default: 'false'
permissions:
  contents: write
jobs:
  video:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${pin}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }}
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          target: release/\${{ inputs.tag }}
          base-video: \${{ inputs.base_video }}
          publish: \${{ inputs.publish }}
          release-asset: \${{ inputs.release_asset }}
          max-runs-per-day: '20'
`,
}

interface WfRun {
  databaseId: number
  createdAt: string
  status: string
  conclusion: string | null
  url: string
  attempt?: number
}

/** Waits for the workflow's first run created after `since` to complete; fails with its URL unless it succeeded. */
async function waitRun(workflow: string, since: string): Promise<WfRun> {
  const deadline = Date.now() + runTimeoutMin * 60_000
  for (;;) {
    const runs = ghJson<WfRun[]>([
      'run',
      'list',
      '-R',
      sandbox,
      '--workflow',
      workflow,
      '--limit',
      '10',
      '--json',
      'databaseId,createdAt,status,conclusion,url',
    ])
    const run = runs
      .filter((r) => r.createdAt >= since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success')
        throw new ScenarioError(`${workflow} run ${run.conclusion ?? 'failed'}`, { url: run.url })
      log('workflow_run', { workflow, id: run.databaseId, url: run.url, outcome: run.conclusion })
      return run
    }
    if (Date.now() > deadline)
      throw new ScenarioError(`${workflow} didn't finish in ${runTimeoutMin} minutes`, { url: run?.url })
    await sleep(15_000)
  }
}

let client: ReturnType<typeof sdk> | null = null
const releases: string[] = []
/** Videos made straight through the API (the phase 3 comparison), deleted at cleanup. */
const made: string[] = []
/** Made on first use, after main() has checked VIDEO_AGENT_URL (the SDK refuses an empty URL). */
const va = () => (client ??= sdk())
const lastRun = new Map<number, number>()

const live: Driver = {
  name: 'live',
  async openPr({ title, body }) {
    const dir = mkdtempSync(join(tmpdir(), 'va-e2e-pr-'))
    const branch = `va-e2e/${Date.now()}`
    try {
      gh(['repo', 'clone', sandbox, dir, '--', '--depth', '1'])
      const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
      g('checkout', '-b', branch)
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs', `${branch.replace('/', '-')}.md`), `${title}\n`)
      g('add', '.')
      g('-c', 'user.name=video-agent-e2e', '-c', 'user.email=e2e@invalid', 'commit', '-m', title)
      if (g('push', 'origin', branch).status !== 0) throw new ScenarioError('push failed')
      const url = gh([
        'pr',
        'create',
        '-R',
        sandbox,
        '--head',
        branch,
        '--title',
        title,
        '--body',
        body,
      ]).trim()
      const n = Number(/\/pull\/(\d+)/.exec(url)?.[1])
      log('pr_opened', { n, url })
      return n
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  async editPr(n, body) {
    gh(['pr', 'edit', String(n), '-R', sandbox, '--body', body])
  },
  async label(n) {
    const since = new Date(Date.now() - 2000).toISOString()
    gh(['pr', 'edit', String(n), '-R', sandbox, '--add-label', 'video'])
    lastRun.set(n, (await waitRun('pr-video.yml', since)).databaseId)
  },
  async unlabel(n) {
    gh(['pr', 'edit', String(n), '-R', sandbox, '--remove-label', 'video'])
  },
  async comment(n, body) {
    const since = new Date(Date.now() - 2000).toISOString()
    gh(['pr', 'comment', String(n), '-R', sandbox, '--body', body])
    await waitRun('pr-video-commands.yml', since)
  },
  async labelAndComment(n, body) {
    const since = new Date(Date.now() - 2000).toISOString()
    gh(['pr', 'edit', String(n), '-R', sandbox, '--add-label', 'video'])
    gh(['pr', 'comment', String(n), '-R', sandbox, '--body', body])
    await Promise.all([waitRun('pr-video.yml', since), waitRun('pr-video-commands.yml', since)])
  },
  async rerun(n) {
    const id = lastRun.get(n)
    if (!id) throw new ScenarioError('no run to re-run')
    gh(['run', 'rerun', String(id), '-R', sandbox])
    await sleep(10_000)
    gh(['run', 'watch', String(id), '-R', sandbox, '--exit-status'])
  },
  async release(tag, notes, inputs = {}) {
    gh(['release', 'create', tag, '-R', sandbox, '--title', tag, '--notes', notes])
    const since = new Date(Date.now() - 2000).toISOString()
    const fields = Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k.replace(/-/g, '_')}=${v}`])
    gh(['workflow', 'run', 'release-video.yml', '-R', sandbox, '-f', `tag=${tag}`, ...fields])
    await waitRun('release-video.yml', since)
    releases.push(tag)
  },
  async push(n, messages) {
    const dir = mkdtempSync(join(tmpdir(), 'va-e2e-push-'))
    try {
      const branch = ghJson<{ headRefName: string }>([
        'pr',
        'view',
        String(n),
        '-R',
        sandbox,
        '--json',
        'headRefName',
      ]).headRefName
      gh(['repo', 'clone', sandbox, dir, '--', '--depth', '5', '--branch', branch])
      const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
      const since = new Date(Date.now() - 2000).toISOString()
      // Quick succession: the PR workflow's concurrency group keeps one running and one pending run.
      for (const [i, m] of messages.entries()) {
        writeFileSync(join(dir, 'docs', `push-${Date.now()}-${i}.md`), `${m}\n`)
        g('add', '.')
        g('-c', 'user.name=video-agent-e2e', '-c', 'user.email=e2e@invalid', 'commit', '-m', m)
        if (g('push', 'origin', branch).status !== 0) throw new ScenarioError('push failed')
      }
      await waitRun('pr-video.yml', since)
      // The last push's run, if it was queued behind the first.
      await sleep(20_000)
      await waitRun('pr-video.yml', new Date(Date.now() - 60_000).toISOString()).catch(() => undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  async videosByExternalRef(externalRef) {
    const page = await va().videos.list({ owner: 'me', externalRef, limit: 50 })
    return [...page.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },
  async createDirect(prompt, title) {
    const v = await va().videos.create({ prompt, title })
    made.push(v.id)
    await va().videos.wait(v.id, { timeoutMs: runTimeoutMin * 60_000 })
    return v.id
  },
  webUrl: (id) => `${base}/videos/${id}`,
  async releaseAssets(tag) {
    return ghJson<{ assets: { name: string }[] }>([
      'release',
      'view',
      tag,
      '-R',
      sandbox,
      '--json',
      'assets',
    ]).assets.map((a) => a.name)
  },
  async sticky(n) {
    const comments = ghJson<{ body: string; user: { login: string } }[][]>([
      'api',
      '--paginate',
      '--slurp',
      `repos/${sandbox}/issues/${n}/comments`,
    ]).flat()
    return (
      comments
        .filter((c) => c.user.login === 'github-actions[bot]' && c.body.includes('<!-- video-agent:v1'))
        .at(-1)?.body ?? null
    )
  },
  async releaseBody(tag) {
    return ghJson<{ body: string }>(['release', 'view', tag, '-R', sandbox, '--json', 'body']).body
  },
  async videosFor(ref) {
    const page = await va().videos.list({ owner: 'me', q: ref, limit: 50 })
    return page.items
      .filter((v) => v.versions.some((x) => x.prompt.trimEnd().endsWith(ref)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },
  async library(prefix) {
    const page = await va().media.list({ q: prefix, limit: 50 })
    return page.items.filter((m) => (m.caption ?? '').startsWith(prefix)).map((m) => m.id)
  },
}

// ───── the run ─────

async function main() {
  for (const [k, v] of Object.entries({
    VIDEO_AGENT_URL: base,
    VIDEO_AGENT_KEY: key,
    SANDBOX_REPO: sandbox,
    GH_TOKEN: ghToken,
  }))
    if (!v) throw new ScenarioError(`${k} is required (run with --dry to see everything it needs)`)
  if (
    git('ls-remote', '--exit-code', 'origin').status !== 0 ||
    git('branch', '-r', '--contains', actionRef).stdout.trim() === ''
  )
    throw new ScenarioError(`ACTION_REF ${actionRef} isn't on origin yet`)
  if (spawnSync('npm', ['run', 'action:check'], { encoding: 'utf8' }).status !== 0)
    throw new ScenarioError('packages/action/dist is stale: npm run action:build')
  const access = ghJson<{ access_level: string }>([
    'api',
    `repos/${THIS_REPO}/actions/permissions/access`,
  ]).access_level
  if (access === 'none')
    throw new ScenarioError(
      `${THIS_REPO}'s Actions access is "none": ask the owner to set it to "organization" for the live test (plan §3.1)`,
    )

  // Setup: workflows on the default branch, the URL variable and the key secret.
  const dir = mkdtempSync(join(tmpdir(), 'va-e2e-setup-'))
  try {
    gh(['repo', 'clone', sandbox, dir, '--', '--depth', '1'])
    mkdirSync(join(dir, '.github/workflows'), { recursive: true })
    for (const [file, text] of Object.entries(WORKFLOWS))
      writeFileSync(join(dir, '.github/workflows', file), text)
    const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    g('add', '.github/workflows')
    g(
      '-c',
      'user.name=video-agent-e2e',
      '-c',
      'user.email=e2e@invalid',
      'commit',
      '-m',
      `e2e: action workflows pinned to ${actionRef.slice(0, 12)}`,
    )
    g('push', 'origin', 'HEAD')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  gh(['variable', 'set', 'VIDEO_AGENT_URL', '-R', sandbox, '--body', base])
  gh(['secret', 'set', 'VIDEO_AGENT_KEY', '-R', sandbox], key)
  gh(['label', 'create', 'video', '-R', sandbox, '--force', '--color', 'FF7A00'])
  log('setup', { sandbox, actionRef: actionRef.slice(0, 12), outcome: 'ok' })

  const [owner = '', repo = ''] = sandbox.split('/')
  const ctx: ScenarioContext = {
    owner,
    repo,
    prs: {},
    tag: `e2e-v${Date.now()}`,
    ...(baseVideo ? { baseVideo } : {}),
  }
  const refs = () => [
    ...Object.values(ctx.prs).map((n) => `[va-ref github:${owner}/${repo}#pr-${n}]`),
    ...[ctx.tag, ...releases].map((t) => `[va-ref github:${owner}/${repo}@${t}]`),
  ]
  const madeVideos = async () => [
    ...(await Promise.all(refs().map((r) => live.videosFor(r)))).flat(),
    ...(
      await Promise.all(
        made.map((id) =>
          va()
            .videos.get(id)
            .catch(() => null),
        ),
      )
    ).filter((v) => v !== null),
  ]
  const spent = async () =>
    Math.round(
      (await madeVideos()).reduce(
        (sum, v) => sum + v.versions.reduce((s, x) => s + (x.usage?.totalCreditsCost ?? 0), 0),
        0,
      ),
    )
  let failed: unknown = null
  try {
    const done = await runScenarios(live, scenarios, ctx, { ceiling, perRun, spent, log })
    log('SUMMARY', { scenarios: done, credits: await spent(), ceiling })
  } catch (e) {
    failed = e
    log('FAIL', {
      msg: e instanceof Error ? e.message : String(e),
      ...(e instanceof ScenarioError ? e.fields : {}),
    })
  } finally {
    if (!keep) {
      for (const n of Object.values(ctx.prs))
        spawnSync('gh', ['pr', 'close', String(n), '-R', sandbox, '--delete-branch'], {
          env: { ...env, GH_TOKEN: ghToken },
        })
      for (const tag of new Set([ctx.tag, ...releases]))
        spawnSync('gh', ['release', 'delete', tag, '-R', sandbox, '--yes', '--cleanup-tag'], {
          env: { ...env, GH_TOKEN: ghToken },
        })
      for (const v of await madeVideos().catch(() => []))
        await va()
          .videos.delete(v.id)
          .catch(() => undefined)
      for (const n of Object.values(ctx.prs))
        for (const id of await live.library(`PR #${n} screenshot`).catch(() => []))
          await va()
            .media.delete(id)
            .catch(() => undefined)
      log('cleanup', { prs: Object.values(ctx.prs), tag: ctx.tag })
    }
  }
  if (failed) process.exit(1)
}

await main()
