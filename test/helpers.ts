import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '../db/schema.js'
import { createApp } from '../src/app.js'
import { createDrizzleStore } from '../src/store/drizzle.js'
import { tick } from '../src/domain/reconciler.js'
import { finalizeAttempt } from '../src/domain/finalize.js'
import { assembleUpload } from '../src/domain/media-uploads.js'
import { receiveCallback } from '../src/domain/callback.js'
import { runOpenverseJob } from '../src/domain/openverse-jobs.js'
import { NARRATION_SRC } from '../src/lib/contract.js'
import { sha256Hex } from '../src/lib/crypto.js'
import type { AttemptRow, Role } from '../src/domain/types.js'
import { fixtureFiles, makeDeps, uploadAndManifest, type TestDeps } from './fakes.js'

export const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

export interface Harness {
  deps: TestDeps
  app: ReturnType<typeof createApp>
  admin: string
  member: string
  outsider: string
  call: (
    method: string,
    path: string,
    opts?: {
      as?: string
      key?: string
      body?: unknown
      origin?: string | null
      headers?: Record<string, string>
    },
  ) => Promise<Response>
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
      {
        kind: 'terminal',
        status: 'succeeded',
        resultText: 'done',
        usage: { totalCreditsCost: 42 },
        failure: null,
      },
    ],
    onTerminal: async () => {
      const a = await deps.store.getAttempt(req.requestId)
      if (!a) return
      const job = await deps.store.getJob(a.jobId)
      const files = fixtureFiles(job?.aspect)
      if (deps.nextSource) {
        files['source.tar.gz'] = deps.nextSource
        deps.nextSource = null
      }
      const previews = deps.nextPreviews
      deps.nextPreviews = null
      const manifest = await uploadAndManifest(
        deps.blobs,
        a.jobId,
        a.id,
        { ...files, ...previews?.files },
        {
          ...(previews?.lqip ? { lqip: previews.lqip } : {}),
          ...(previews?.skipped ? { previewsSkipped: previews.skipped } : {}),
        },
      )
      const bus = deps.nextBus
      deps.nextBus = null
      if (bus) {
        await deps.blobs.set('uploads', `${a.id}/narration-bus.wav`, bus)
        manifest.references = [{ path: NARRATION_SRC, sha256: sha256Hex(bus), bytes: bus.byteLength }]
      }
      const token = /--token (\S+)/.exec(req.prompt)?.[1] ?? null
      if (opts.autoCallback ?? true) await receiveCallback(deps, a.id, token, manifest)
    },
  })
  deps.platform.onAssemble = async (id) => {
    await assembleUpload(deps, id)
  }
  // The Openverse jobs a run's music pick queues run right away (against deps.outbound, 404 unless a test scripts it),
  // like a background function that finishes before the next look. Jobs people start stay queued for tests to run.
  deps.platform.onOpenverseJob = async (id) => {
    if (typeof (await deps.store.getOpenverseJob(id))?.params.attemptId === 'string')
      await runOpenverseJob(deps, id)
  }
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
    // Background work the request hands to waitUntil (the sweep kick) finishes before the call returns, so tests
    // see the same state however many awaits a step takes.
    const pending: Promise<unknown>[] = []
    const res = await app.fetch(req, {
      context: { deploy: { published: true }, waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    })
    await Promise.all(pending)
    return res
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

/** Signs a new person in (which creates their row) and, if asked, has the admin set their role. */
export async function person(h: Harness, id: string, role?: Role) {
  const cookie = h.deps.identity.addUser({ id, email: `${id}@acme.com`, name: id }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  if (role) await h.call('PATCH', `/api/v1/users/${id}`, { as: h.admin, body: { role } })
  return cookie
}

/** Creates a video and drives it until v1 is ready; returns its id. */
export async function readyVideo(h: Harness, as = h.member) {
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

/** Creates an API key for the signed-in person; returns the secret. */
export const apiKey = async (h: Harness, as: string, name = 'k') =>
  (await h.json(await h.call('POST', '/api/v1/keys', { as, body: { name } }))).key as string

/** One MCP JSON-RPC request with an API key; returns its result. */
export async function mcpCall(h: Harness, key: string, method: string, params: unknown) {
  const res = await h.call('POST', '/api/mcp', {
    origin: null,
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: { jsonrpc: '2.0', id: 1, method, params },
  })
  return ((await res.json()) as { result: any }).result
}

/** A request with a raw byte body, the way the Media page sends files. Background work isn't awaited. */
export function raw(
  h: Harness,
  as: string,
  method: string,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return h.app.fetch(
    new Request(`https://video.example.com${path}`, {
      method,
      headers: {
        cookie: as,
        origin: 'https://video.example.com',
        'content-type': 'application/octet-stream',
        ...headers,
      },
      body,
    }),
    { context: { deploy: { published: true }, waitUntil: () => undefined } },
  )
}

/** A one-request media upload. */
export const upload = (h: Harness, as: string, bytes: Uint8Array, q = 'filename=logo.png') =>
  raw(h, as, 'POST', `/api/v1/media?${q}`, bytes)

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** A PNG header with the given dimensions: enough for upload sniffing. */
export const png = (w = 640, h = 360) =>
  new Uint8Array([
    0x89,
    ...Buffer.from('PNG\r\n\x1a\n', 'latin1'),
    ...be32(13),
    ...Buffer.from('IHDR'),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  ])
export const font = () => new Uint8Array([...Buffer.from('wOF2'), 1, 2, 3, 4])

/** A Drizzle store on PGlite with every committed migration applied. */
export async function pgStore() {
  const pg = new PGlite()
  const dir = new URL('../netlify/database/migrations/', import.meta.url)
  for (const m of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  return createDrizzleStore(drizzle({ client: pg, schema }))
}
