// The Hono app behind /api/*. createApp(deps) is used by the Netlify Function, tests and spec generation.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import type { Deps } from './deps.js'
import { assertSameOrigin, principalFromRequest } from './domain/auth.js'
import { receiveCallback } from './domain/callback.js'
import { createKey, listKeys, revokeKey } from './domain/keys.js'
import { assertCan, type Principal } from './domain/policy.js'
import { resolveUnresolved, tick } from './domain/reconciler.js'
import { setupChecks } from './domain/setup.js'
import { listUsers, updateUser } from './domain/users.js'
import {
  cancelVersion,
  createVideo,
  deleteVideo,
  listVideos,
  publishVersion,
  updateVideo,
  loadJob,
  retryVersion,
  reviseVideo,
  unpublishVersion,
  videoDto,
} from './domain/videos.js'
import { signedFilePath } from './domain/files.js'
import { handleMcp } from './mcp.js'
import { ApiError, errorBody } from './lib/errors.js'
import * as s from './schemas.js'

/** The bits of Netlify's function context the app uses. */
export interface NetlifyContext {
  deploy?: { context?: string; id?: string; published?: boolean }
  waitUntil?: (p: Promise<unknown>) => void
}

export interface AppOptions {
  /** Only the published production deploy serves the API (previews get a copy of the database). */
  isLive: (ctx: NetlifyContext | undefined) => boolean
  /** Whether context/ still holds the neutral template default. */
  contextIsDefault: boolean
}

type Env = { Bindings: { context?: NetlifyContext }; Variables: { principal: Principal } }

const SETUP_TTL_MS = 60_000
const PAID_PATHS = [
  /^\/api\/v1\/videos$/,
  /^\/api\/v1\/videos\/[^/]+\/versions$/,
  /^\/api\/v1\/videos\/[^/]+\/versions\/\d+\/retry$/,
]

const err = (desc: string) => ({
  content: { 'application/json': { schema: s.ErrorSchema } },
  description: desc,
})
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const errors = {
  400: err('Invalid request'),
  401: err('Not signed in'),
  403: err('Not allowed'),
  404: err('Not found'),
  409: err('Conflict or not ready'),
}
const security = [{ cookieAuth: [] }, { bearerAuth: [] }]

const IdParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })
const VersionParam = IdParam.extend({
  n: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'n', in: 'path' } }),
})
const FileParam = VersionParam.extend({
  file: z.enum(['video', 'poster', 'gif', 'captions']).openapi({ param: { name: 'file', in: 'path' } }),
})

export function createApp(deps: Deps, opts: AppOptions) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody(
            'invalid_request',
            'The request is not valid.',
            result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
          400,
        )
      }
      return undefined
    },
  })

  let setupCache: { at: number; value: Awaited<ReturnType<typeof setupChecks>> } | null = null
  const setup = async (fresh = false) => {
    if (!fresh && setupCache && Date.now() - setupCache.at < SETUP_TTL_MS) return setupCache.value
    const value = await setupChecks(deps, { contextIsDefault: opts.contextIsDefault })
    setupCache = { at: Date.now(), value }
    return value
  }

  app.onError((e, c) => {
    if (e instanceof ApiError) {
      if (e.code === 'rate_limited') c.header('Retry-After', '60')
      return c.json(errorBody(e.code, e.message, e.details), e.status as 400)
    }
    deps.log.error('api.unhandled', { path: c.req.path, method: c.req.method, error: e })
    return c.json(errorBody('internal', 'Something went wrong.'), 500)
  })
  app.notFound((c) => c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}.`), 404))

  // Deploy-context guard: previews and old deploys serve nothing.
  app.use('*', async (c, next) => {
    if (!opts.isLive(c.env.context)) {
      return c.json(
        errorBody('not_found', 'This deploy is not the live production deploy of this video agent.'),
        404,
      )
    }
    await next()
  })

  // CORS for API-key clients on named origins only; never for cookie sessions.
  app.use('/api/v1/*', async (c, next) => {
    const origin = c.req.header('origin')
    const allowed = origin && deps.config.allowedOrigins.includes(origin.toLowerCase())
    if (c.req.method === 'OPTIONS' && allowed) {
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE',
        'access-control-allow-headers': 'authorization,content-type,idempotency-key',
        'access-control-max-age': '600',
        vary: 'origin',
      })
    }
    await next()
    if (allowed && c.req.header('authorization')) {
      c.header('access-control-allow-origin', origin)
      c.header('vary', 'origin')
    }
  })

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    if (c.req.path === '/api/v1/config' || c.req.method === 'OPTIONS') return next()
    const principal = await principalFromRequest(deps, c.req.raw)
    assertSameOrigin(c.req.raw, principal)
    c.set('principal', principal)
    await next()
  }
  app.use('/api/v1/*', requireAuth)
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.method === 'POST' && PAID_PATHS.some((r) => r.test(c.req.path))) {
      const st = await setup()
      if (!st.ready)
        throw new ApiError(
          'setup_required',
          'This video agent is not set up yet. An admin should open /setup.',
        )
    }
    await next()
  })

  const kick = (c: Context<Env>) => {
    const p = tick(deps, { deadline: Date.now() + 20_000, maxItems: 5 }).catch((e: unknown) => {
      deps.log.warn('api.kick_failed', { error: e })
    })
    c.env.context?.waitUntil?.(p)
  }
  const statusOf = (code: number) => code as 202

  // ───── public ─────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/health',
      summary: 'Liveness and setup readiness (no secrets)',
      tags: ['system'],
      request: { query: z.object({ fresh: z.enum(['1']).optional() }) },
      responses: { 200: json(s.HealthSchema, 'Health') },
    }),
    async (c) => {
      const st = await setup(c.req.valid('query').fresh === '1')
      return c.json({ ok: true, ready: st.ready, checks: st.checks }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/config',
      summary: 'Public configuration for the sign-in screen',
      tags: ['system'],
      responses: { 200: json(s.PublicConfigSchema, 'Config') },
    }),
    (c) => c.json({ admission: deps.config.allowedEmailDomains, siteUrl: deps.config.siteUrl }, 200),
  )

  // ───── videos ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos',
      summary: 'Create a video from a prompt',
      tags: ['videos'],
      security,
      request: {
        headers: z.object({ 'idempotency-key': z.string().max(200).optional() }),
        body: { content: { 'application/json': { schema: s.CreateVideoSchema } }, required: true },
      },
      responses: { 202: json(s.VideoSchema, 'Queued'), ...errors, 503: err('Setup required') },
    }),
    async (c) => {
      const res = await createVideo(
        deps,
        c.get('principal'),
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'],
      )
      c.header('location', res.body.links.self)
      if (!res.replayed) kick(c)
      return c.json(res.body, statusOf(res.status))
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos',
      summary: 'List videos, newest first',
      tags: ['videos'],
      security,
      request: {
        query: z.object({
          status: s.StatusSchema.optional(),
          owner: z.enum(['me', 'all']).optional(),
          published: z.enum(['true', 'false']).optional(),
          q: z.string().max(200).optional(),
          cursor: z.string().max(500).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
      },
      responses: { 200: json(s.VideoListSchema, 'Videos'), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const res = await listVideos(deps, c.get('principal'), {
        ...q,
        published: q.published === undefined ? undefined : q.published === 'true',
      })
      return c.json(res, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}',
      summary: 'One video with its versions',
      tags: ['videos'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.VideoSchema, 'Video'), 304: { description: 'Not modified' }, ...errors },
    }),
    async (c) => {
      await loadJob(deps.store, c.get('principal'), c.req.valid('param').id)
      assertCan(c.get('principal'), 'video:read')
      const dto = await videoDto(deps.store, deps, c.req.valid('param').id, c.get('principal'))
      c.header('etag', dto.etag)
      c.header('cache-control', 'private, no-cache')
      if (c.req.header('if-none-match') === dto.etag) return c.body(null, 304)
      return c.json(dto, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/videos/{id}',
      summary: 'Rename a video or make it private',
      tags: ['videos'],
      security,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: s.UpdateVideoSchema } }, required: true },
      },
      responses: { 200: json(s.VideoSchema, 'Updated'), ...errors },
    }),
    async (c) =>
      c.json(await updateVideo(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/videos/{id}',
      summary: 'Delete a video, its versions, files and public links',
      tags: ['videos'],
      security,
      request: { params: IdParam },
      responses: { 202: { description: 'Deleted; files are removed in the background' }, ...errors },
    }),
    async (c) => {
      await deleteVideo(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 202)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions',
      summary: 'Revise: start the next version from a ready one',
      tags: ['versions'],
      security,
      request: {
        params: IdParam,
        headers: z.object({ 'idempotency-key': z.string().max(200).optional() }),
        body: { content: { 'application/json': { schema: s.ReviseSchema } }, required: true },
      },
      responses: { 202: json(s.VideoSchema, 'Queued'), ...errors, 503: err('Setup required') },
    }),
    async (c) => {
      const res = await reviseVideo(
        deps,
        c.get('principal'),
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'],
      )
      c.header('location', res.body.links.self)
      if (!res.replayed) kick(c)
      return c.json(res.body, statusOf(res.status))
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/retry',
      summary: 'Try a failed, cancelled or timed-out version again',
      tags: ['versions'],
      security,
      request: { params: VersionParam },
      responses: { 202: json(s.VideoSchema, 'Queued'), ...errors, 503: err('Setup required') },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const dto = await retryVersion(deps, c.get('principal'), p.id, p.n)
      kick(c)
      return c.json(dto, 202)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/cancel',
      summary: 'Stop a version in progress',
      tags: ['versions'],
      security,
      request: { params: VersionParam },
      responses: { 202: json(s.VideoSchema, 'Cancelling'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const dto = await cancelVersion(deps, c.get('principal'), p.id, p.n)
      kick(c)
      return c.json(dto, 202)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/publish',
      summary: 'Publish a version to a public link',
      tags: ['publishing'],
      security,
      request: { params: VersionParam },
      responses: { 200: json(s.PublicationSchema, 'Published'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json(await publishVersion(deps, c.get('principal'), p.id, p.n), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/videos/{id}/versions/{n}/publish',
      summary: 'Unpublish a version (its link stops working on the next request)',
      tags: ['publishing'],
      security,
      request: { params: VersionParam },
      responses: { 204: { description: 'Unpublished' }, ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      await unpublishVersion(deps, c.get('principal'), p.id, p.n)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/{file}',
      summary: 'Download a file: redirects to a signed URL valid for 10 minutes',
      tags: ['versions'],
      security,
      request: { params: FileParam, query: z.object({ download: z.enum(['1']).optional() }) },
      responses: { 302: { description: 'Signed URL' }, ...errors },
    }),
    async (c) => {
      const { id, n, file } = c.req.valid('param')
      await loadJob(deps.store, c.get('principal'), id)
      assertCan(c.get('principal'), 'video:read')
      const out = await deps.store.getOutput(id, n)
      if (!out) throw new ApiError('not_ready', 'This version has no files yet.')
      c.header('cache-control', 'private, no-store')
      return c.redirect(
        await signedFilePath(deps, id, n, file, 600, c.req.valid('query').download === '1'),
        302,
      )
    },
  )

  // ───── keys, me, users, stats ─────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/keys',
      summary: 'Your API keys',
      tags: ['keys'],
      security,
      responses: { 200: json(z.array(s.KeySchema), 'Keys'), ...errors },
    }),
    async (c) => c.json(await listKeys(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/keys',
      summary: 'Create an API key (the secret is shown once)',
      tags: ['keys'],
      security,
      request: { body: { content: { 'application/json': { schema: s.CreateKeySchema } }, required: true } },
      responses: { 201: json(s.NewKeySchema, 'Created'), ...errors },
    }),
    async (c) => c.json(await createKey(deps, c.get('principal'), c.req.valid('json').name), 201),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/keys/{id}',
      summary: 'Revoke an API key',
      tags: ['keys'],
      security,
      request: { params: IdParam },
      responses: { 204: { description: 'Revoked' }, ...errors },
    }),
    async (c) => {
      await revokeKey(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me',
      summary: 'Who you are',
      tags: ['me'],
      security,
      responses: { 200: json(s.MeSchema, 'Me'), ...errors },
    }),
    (c) => {
      const p = c.get('principal')
      return c.json(
        {
          id: p.userId,
          email: p.email,
          name: p.name,
          role: p.role,
          via: p.kind === 'user' ? ('session' as const) : ('apiKey' as const),
        },
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/users',
      summary: 'List users (admin)',
      tags: ['admin'],
      security,
      responses: { 200: json(z.array(s.UserSchema), 'Users'), ...errors },
    }),
    async (c) => c.json(await listUsers(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/users/{id}',
      summary: 'Change a role, disable or enable a user (admin)',
      tags: ['admin'],
      security,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: s.UpdateUserSchema } }, required: true },
      },
      responses: { 200: json(s.UserSchema, 'Updated'), ...errors },
    }),
    async (c) =>
      c.json(await updateUser(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/stats',
      summary: 'Runs, queue, failures and credits (admin)',
      tags: ['admin'],
      security,
      responses: { 200: json(s.StatsSchema, 'Stats'), ...errors },
    }),
    async (c) => {
      assertCan(c.get('principal'), 'stats:read')
      const now = deps.clock.now()
      const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString()
      const monthAgo = new Date(now.getTime() - 35 * 86400_000).toISOString()
      const [inFlight, queued, unresolved, failures, usage, users, settings] = await Promise.all([
        deps.store.listAttemptsByStage(['starting', 'running', 'cancelling', 'finishing'], 100),
        deps.store.listAttemptsByStage(['queued'], 1000),
        deps.store.listAttemptsByStage(['unresolved'], 100),
        deps.store.failuresSince(weekAgo),
        deps.store.usageSince(monthAgo),
        deps.store.listUsers(),
        deps.store.getSettings(),
      ])
      const email = new Map(users.map((u) => [u.id, u.email]))
      const titles = new Map<string, string>()
      for (const a of [...inFlight, ...unresolved]) {
        if (!titles.has(a.jobId)) titles.set(a.jobId, (await deps.store.getJob(a.jobId))?.title ?? a.jobId)
      }
      const title = (jobId: string) => titles.get(jobId) ?? jobId
      const runUrl = (a: { runnerId: string | null; sessionId: string | null }) =>
        a.runnerId ? deps.runner.runUrl(a.runnerId, a.sessionId) : null
      return c.json(
        {
          inFlight: inFlight.map((a) => ({
            attemptId: a.id,
            jobId: a.jobId,
            title: title(a.jobId),
            versionN: a.versionN,
            stage: a.stage,
            startedAt: a.startedAt,
            runUrl: runUrl(a),
          })),
          queued: queued.length,
          oldestQueuedAt: queued.map((a) => a.queuedAt).sort()[0] ?? null,
          unresolved: unresolved.map((a) => ({
            attemptId: a.id,
            jobId: a.jobId,
            title: title(a.jobId),
            versionN: a.versionN,
            runUrl: runUrl(a),
          })),
          failuresThisWeek: failures,
          usage: usage.map((u) => ({ ...u, email: email.get(u.userId) ?? null })),
          maxActiveRuns: deps.config.maxActiveRuns,
          queuePausedReason: settings?.queuePausedReason ?? null,
        },
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/admin/attempts/{id}/resolve',
      summary: 'Mark an unresolved start as failed and free its slot (admin)',
      tags: ['admin'],
      security,
      request: { params: IdParam },
      responses: { 204: { description: 'Resolved' }, ...errors },
    }),
    async (c) => {
      assertCan(c.get('principal'), 'attempts:resolve')
      if (!(await resolveUnresolved(deps, c.req.valid('param').id)))
        throw new ApiError('conflict', 'That attempt is not unresolved.')
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/admin/queue/resume',
      summary: 'Resume a queue paused because AI credits were unavailable (admin)',
      tags: ['admin'],
      security,
      responses: { 204: { description: 'Resumed' }, ...errors },
    }),
    async (c) => {
      assertCan(c.get('principal'), 'stats:read')
      await deps.store.updateSettings({ queuePausedReason: null })
      kick(c)
      return c.body(null, 204)
    },
  )

  // ───── MCP: the same operations as tools for AI clients (API keys only) ─────
  const mcp = async (c: Context<Env>) => {
    if (!c.req.header('authorization')) {
      return c.json(
        errorBody(
          'unauthorized',
          'Send your API key as "Authorization: Bearer nva_…". Create one on the API keys page.',
        ),
        401,
        { 'www-authenticate': 'Bearer realm="video-agent"' },
      )
    }
    const principal = await principalFromRequest(deps, c.req.raw)
    if (principal.kind !== 'apiKey') throw new ApiError('unauthorized', 'MCP needs an API key.')
    return handleMcp(deps, principal, c.req.raw, () => {
      kick(c)
    })
  }
  // /mcp is the short URL people paste into their clients; the function serves it directly.
  app.all('/api/mcp', mcp)
  app.all('/mcp', mcp)

  // ───── agent callback (hidden from the public spec) ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/internal/runs/{id}/done',
      hide: true,
      request: { params: IdParam },
      responses: {
        202: { description: 'Received' },
        400: err('Invalid'),
        401: err('Bad token'),
        409: err('Conflict'),
        410: err('Gone'),
      },
    }),
    async (c) => {
      const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        throw new ApiError('invalid_request', 'Body must be JSON.')
      }
      await receiveCallback(deps, c.req.valid('param').id, token, body)
      kick(c)
      return c.body(null, 202)
    },
  )

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key: nva_<keyId>_<secret>, created in the web app.',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: 'nf_jwt',
    description: 'The web app session (Netlify Identity). State-changing requests must be same-origin.',
  })

  const spec = () =>
    app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Video Agent API',
        version: '1.0.0',
        description: 'Make videos from a prompt with Netlify Agent Runners and HyperFrames.',
      },
      servers: [{ url: deps.config.siteUrl }],
    })
  app.get('/api/openapi.json', (c) => c.json(spec()))
  app.get('/api/docs', (c) =>
    c.html(`<!doctype html><html><head><title>Video Agent API</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script id="api-reference" type="application/json">${JSON.stringify(spec()).replaceAll('<', '\\u003c')}</script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4"></script></body></html>`),
  )

  return Object.assign(app, { spec })
}
