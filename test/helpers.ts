import { createApp } from '../src/app.js'
import { tick } from '../src/domain/reconciler.js'
import { finalizeAttempt } from '../src/domain/finalize.js'
import { receiveCallback } from '../src/domain/callback.js'
import type { AttemptRow } from '../src/domain/types.js'
import { fixtureFiles, makeDeps, uploadAndManifest, type TestDeps } from './fakes.js'

export interface Harness {
  deps: TestDeps
  app: ReturnType<typeof createApp>
  admin: string
  member: string
  outsider: string
  call: (method: string, path: string, opts?: { as?: string; key?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> }) => Promise<Response>
  json: <T = any>(res: Response) => Promise<T>
  /** Runs sweep ticks (advancing the clock a minute each) until nothing changes or n ticks pass. */
  drive: (n?: number) => Promise<void>
  attempts: (jobId: string) => Promise<AttemptRow[]>
}

export function harness(
  env: Record<string, string> = {},
  opts: { live?: boolean; autoFinalize?: boolean; autoCallback?: boolean; store?: TestDeps['store'] } = {},
): Harness {
  const deps = makeDeps(env, opts.store)
  const app = createApp(deps, { isLive: () => opts.live ?? true, contextIsDefault: false })
  const admin = deps.identity.addUser({ id: 'u_admin', email: 'admin@acme.com', name: 'Ada Admin' }).cookie
  const member = deps.identity.addUser({ id: 'u_member', email: 'mia@acme.com', name: 'Mia Member' }).cookie
  const outsider = deps.identity.addUser({ id: 'u_out', email: 'eve@evil.com', name: 'Eve' }).cookie

  // Default run: uploads the fixture files and (optionally) posts the callback when it finishes.
  deps.runner.defaultScript = (req) => ({
    timeline: [
      { kind: 'running', state: 'running', latestStep: 'Writing the composition', usage: null },
      { kind: 'terminal', status: 'succeeded', resultText: 'done', usage: { totalCreditsCost: 42 }, failure: null },
    ],
    onTerminal: async () => {
      const a = await deps.store.getAttempt(req.requestId)
      if (!a) return
      const job = await deps.store.getJob(a.jobId)
      const manifest = await uploadAndManifest(deps.blobs, a.jobId, a.id, fixtureFiles(job?.aspect))
      const token = /--token (\S+)/.exec(req.prompt)?.[1] ?? null
      if (opts.autoCallback ?? true) await receiveCallback(deps, a.id, token, manifest)
    },
  })
  if (opts.autoFinalize ?? true) {
    deps.platform.onDispatch = async (id) => {
      await finalizeAttempt(deps, id)
    }
  }

  const call: Harness['call'] = async (method, path, o = {}) => {
    const headers = new Headers(o.headers)
    if (o.as) headers.set('cookie', o.as)
    if (o.key) headers.set('authorization', `Bearer ${o.key}`)
    if (o.body !== undefined) headers.set('content-type', 'application/json')
    const origin = o.origin === undefined ? 'https://video.example.com' : o.origin
    if (origin) headers.set('origin', origin)
    const req = new Request(`https://video.example.com${path}`, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    })
    return app.fetch(req, { context: { deploy: { published: true }, waitUntil: () => undefined } })
  }
  const drive = async (n = 10) => {
    for (let i = 0; i < n; i++) {
      await tick(deps, { deadline: Date.now() + 10_000, maxItems: 20 })
      deps.clock.advance(61_000)
    }
  }
  return {
    deps,
    app,
    admin,
    member,
    outsider,
    call,
    json: async (res) => (await res.json()) as any,
    drive,
    attempts: (jobId) => deps.store.listAttempts(jobId),
  }
}
