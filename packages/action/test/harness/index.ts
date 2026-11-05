// The action's test harness (bead va-mg4i.2.2): run() in-process against the real Hono app (test/helpers.ts harness,
// memory or PGlite store) through the SDK's fetch, a fake GitHub, a fake image host and a fake clock, so a 30-minute
// wait takes milliseconds and nothing touches the network or spends credits.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { tick } from '../../../../src/domain/reconciler.js'
import type { RunnerSnapshot } from '../../../../src/deps.js'
import { failedSnap, running, succeeded } from '../../../../test/fakes.js'
import { apiKey, harness, pgStore, type Harness } from '../../../../test/helpers.js'
import type { Core } from '../../src/core.js'
import type { ActionDeps, RunResult } from '../../src/main.js'
import { run } from '../../src/main.js'
import { INPUTS } from '../../src/spec.js'
import { fakeGitHub, type FakeGitHub, type FakePull, type FakeUser } from './fake-github.js'

export { BOT, fakeGitHub, type FakeGitHub } from './fake-github.js'

export const SITE = 'https://video.example.com'

/** The app's fetch, the way the SDK calls it: background work (waitUntil) finishes before the response returns. */
export function appFetch(h: Harness, storage?: { headers: Record<string, string> }[]): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    // Signed file links point at storage (served outside the API in production): a stand-in, like the SDK's tests.
    if (!new URL(req.url).pathname.startsWith('/api/')) {
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => (headers[k] = v))
      storage?.push({ headers })
      return new Response(`FILE ${new URL(req.url).pathname}`)
    }
    const pending: Promise<unknown>[] = []
    const res = await h.app.fetch(req, {
      context: { deploy: { published: true }, waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    })
    await Promise.all(pending)
    return res
  }
}

/** A fake image host: url → response. Records every request's headers (no Authorization may reach an image host). */
export function fakeImageHost() {
  const files = new Map<string, { status?: number; bytes?: Uint8Array; type?: string; location?: string }>()
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    requests.push({ url: req.url, headers })
    const f = files.get(req.url)
    if (!f) return new Response('not found', { status: 404 })
    if (f.location) return new Response(null, { status: f.status ?? 302, headers: { location: f.location } })
    return new Response(f.bytes ?? new Uint8Array(), {
      status: f.status ?? 200,
      headers: { 'content-type': f.type ?? 'application/octet-stream' },
    })
  }) as typeof fetch
  return { files, requests, fetch: fetchFn }
}

/** Run outcomes for the fake Agent Runner, applied to every run until changed. */
export const outcomes = {
  ready: (credits = 42): RunnerSnapshot[] => [
    running(),
    { ...succeeded(), usage: { totalCreditsCost: credits } },
  ],
  failed: (): RunnerSnapshot[] => [running(), failedSnap()],
  /** Never finishes (until the attempt's deadline times it out). */
  stillRunning: (): RunnerSnapshot[] => [running()],
}

export interface TestEnv {
  h: Harness
  key: string
  gh: FakeGitHub
  images: ReturnType<typeof fakeImageHost>
  /** Holds a run at a named point until released (two runs interleaved, bead 1.5b). */
  pauses: Map<string, Promise<void>>
  /** Sets every new run's timeline. */
  outcome(timeline: RunnerSnapshot[]): void
  /** Requests to the storage host (signed file links): never with the key. */
  storage: { headers: Record<string, string> }[]
}

export async function makeEnv(
  o: { store?: 'memory' | 'pglite'; gh?: Parameters<typeof fakeGitHub>[0] } = {},
) {
  const h = o.store === 'pglite' ? harness({}, { store: await pgStore() }) : harness()
  const key = await apiKey(h, h.member, 'ci')
  const gh = fakeGitHub({ permissions: { dana: 'write', 'mia-member': 'write' }, ...o.gh })
  const env: TestEnv = {
    h,
    key,
    gh,
    images: fakeImageHost(),
    pauses: new Map(),
    storage: [],
    outcome: (timeline) => {
      const base = h.deps.runner.defaultScript
      h.deps.runner.defaultScript = (req) => ({ ...base(req), timeline })
    },
  }
  return env
}

/** A GitHub event and its webhook payload. */
export interface GhEvent {
  name: string
  payload: Record<string, unknown>
}

const repoPayload = (gh: FakeGitHub) => ({ full_name: gh.repo, private: gh.state.visibility === 'private' })

function pullPayload(gh: FakeGitHub, p: FakePull) {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    user: p.user,
    author_association: p.author_association,
    labels: p.labels.map((name) => ({ name })),
    html_url: `https://github.com/${gh.repo}/pull/${p.number}`,
    head: {
      sha: p.headSha,
      repo: p.headRepo === undefined ? { full_name: gh.repo } : p.headRepo && { full_name: p.headRepo },
    },
    base: { repo: { full_name: gh.repo } },
  }
}

export const events = {
  labeled: (gh: FakeGitHub, n: number, label = 'video', sender: FakeUser = { login: 'dana' }): GhEvent => {
    const p = gh.state.pulls.get(n) as FakePull
    if (!p.labels.includes(label)) p.labels.push(label)
    return {
      name: 'pull_request',
      payload: {
        action: 'labeled',
        label: { name: label },
        pull_request: pullPayload(gh, p),
        sender,
        repository: repoPayload(gh),
      },
    }
  },
  synchronize: (gh: FakeGitHub, n: number, sender: FakeUser = { login: 'dana' }): GhEvent => ({
    name: 'pull_request',
    payload: {
      action: 'synchronize',
      pull_request: pullPayload(gh, gh.state.pulls.get(n) as FakePull),
      sender,
      repository: repoPayload(gh),
    },
  }),
  comment: (
    gh: FakeGitHub,
    n: number,
    body: string,
    user: FakeUser = { login: 'dana' },
    association = 'CONTRIBUTOR',
  ): GhEvent => {
    const c = gh.comment(n, body, user, association)
    const isPr = gh.state.pulls.has(n)
    return {
      name: 'issue_comment',
      payload: {
        action: 'created',
        issue: {
          number: n,
          ...(isPr ? { pull_request: { url: `https://api.github.com/repos/${gh.repo}/pulls/${n}` } } : {}),
          labels: (gh.state.pulls.get(n)?.labels ?? []).map((name) => ({ name })),
        },
        comment: { id: c.id, body, user, author_association: association },
        sender: user,
        repository: repoPayload(gh),
      },
    }
  },
  release: (
    gh: FakeGitHub,
    tag: string,
    action = 'published',
    sender: FakeUser = { login: 'dana' },
  ): GhEvent => {
    const r = gh.state.releases.find((x) => x.tag_name === tag)
    return {
      name: 'release',
      payload: {
        action,
        release: r && { id: r.id, tag_name: r.tag_name, name: r.name, body: r.body, html_url: r.html_url },
        sender,
        repository: repoPayload(gh),
      },
    }
  },
  dispatch: (gh: FakeGitHub, sender: FakeUser = { login: 'dana' }): GhEvent => ({
    name: 'workflow_dispatch',
    payload: { sender, repository: repoPayload(gh) },
  }),
  push: (gh: FakeGitHub, sender: FakeUser = { login: 'dana' }): GhEvent => ({
    name: 'push',
    payload: { ref: 'refs/heads/main', sender, repository: repoPayload(gh) },
  }),
}

export interface ActionRun extends RunResult {
  logs: string[]
  warnings: string[]
  summary: string
  masked: string[]
  failed: string | null
}

/** Runs the action once: inputs (without INPUT_), an event, the run id; returns outputs, logs and the summary. */
export async function runAction(
  env: TestEnv,
  o: {
    inputs?: Record<string, string>
    event: GhEvent
    runId?: string
    extraEnv?: Record<string, string>
    deps?: Partial<ActionDeps>
  },
): Promise<ActionRun> {
  const dir = mkdtempSync(join(tmpdir(), 'action-run-'))
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify(o.event.payload))
  // GitHub fills each input's action.yml default when the workflow leaves it out.
  const defaults = Object.fromEntries(
    INPUTS.filter((i) => 'default' in i && i.name !== 'github-token').map((i) => [
      i.name,
      (i as { default: string }).default,
    ]),
  )
  const inputs: Record<string, string> = {
    ...defaults,
    url: SITE,
    'api-key': env.key,
    'github-token': 'ghs_faketoken',
    ...o.inputs,
  }
  const vars: Record<string, string | undefined> = {
    GITHUB_EVENT_NAME: o.event.name,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: env.gh.repo,
    GITHUB_RUN_ID: o.runId ?? '7001',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_WORKSPACE: dir,
    ...o.extraEnv,
  }
  for (const [k, v] of Object.entries(inputs)) vars[`INPUT_${k.toUpperCase()}`] = v
  const logs: string[] = []
  const warnings: string[] = []
  const masked: string[] = []
  let summary = ''
  let failed: string | null = null
  const core: Core = {
    getInput: (name) => (vars[`INPUT_${name.toUpperCase()}`] ?? '').trim(),
    setOutput: () => undefined,
    setSecret: (v) => masked.push(v),
    info: (m) => logs.push(m),
    warning: (m) => {
      warnings.push(m)
      logs.push(m)
    },
    setFailed: (m) => {
      failed = m
    },
    startGroup: (n) => logs.push(`::group::${n}`),
    endGroup: () => logs.push('::endgroup::'),
    summary: (m) => {
      summary += `${m}\n`
    },
  }
  const { h } = env
  const deps: ActionDeps = {
    env: vars,
    core,
    fetch: appFetch(h, env.storage),
    ghFetch: env.gh.fetch,
    imageFetch: env.images.fetch,
    // Test hosts: *.internal and 10.x resolve privately; everything else is public.
    resolve: async (host) => (host.endsWith('.internal') ? ['10.0.0.5'] : ['93.184.216.34']),
    now: () => h.deps.clock.now().getTime(),
    sleep: async (ms) => {
      h.deps.clock.advance(ms)
      await tick(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    },
    readFile: async (p) => new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(p))),
    cwd: dir,
    hook: async (point) => {
      const held = env.pauses.get(point)
      if (held) await held
    },
    ...o.deps,
  }
  const result = await run(deps)
  return { ...result, logs, warnings, summary, masked, failed }
}

/** Asserts a `video-agent:` line with these key=value fields exists; returns it. */
export function expectLog(logs: string[], fields: Record<string, string | number | boolean>): string {
  const want = Object.entries(fields).map(([k, v]) => {
    const s = String(v)
    return `${k}=${/[\s"=]/.test(s) || s === '' ? JSON.stringify(s) : s}`
  })
  const line = logs.find(
    (l) => l.startsWith('video-agent:') && want.every((w) => ` ${l} `.includes(` ${w} `)),
  )
  expect(
    line,
    `no log line with ${want.join(' ')}\n${logs.filter((l) => l.startsWith('video-agent:')).join('\n')}`,
  ).toBeDefined()
  return line as string
}
