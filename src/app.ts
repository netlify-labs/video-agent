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
  setVerdict,
  transferVideos,
  loadJob,
  retryVersion,
  reviseVideo,
  unpublishVersion,
  videoDto,
} from './domain/videos.js'
import { signedFilePath } from './domain/files.js'
import { handleMcp } from './mcp.js'
import {
  listGrants,
  oauthEnabled,
  principalFromAccessToken,
  resourceMetadataUrl,
  revokeGrant,
} from './auth/oauth.js'
import { oauthRoutes } from './auth/routes.js'
import { webAuthRoutes, webSignInEnabled } from './auth/web.js'
import * as hooks from './domain/webhook-settings.js'
import { listNotifications, markNotificationsRead } from './domain/notifications.js'
import { getProgress } from './domain/progress.js'
import { previewLink } from './domain/preview.js'
import { cancelUpload, completeUpload, createUpload, getUpload, putPart } from './domain/media-uploads.js'
import {
  deleteMedia,
  checkMedia,
  getMedia,
  listMedia,
  SINGLE_UPLOAD_MAX,
  updateMedia,
  uploadMedia,
} from './domain/media.js'
import { discardEdit, editPreviewLink, getEdit, openEdit, renderEdit, saveEdit } from './domain/edits.js'
import { receiveCheckpoint } from './domain/checkpoints.js'
import {
  addComment,
  deleteComment,
  listComments,
  markCommentsRead,
  updateComment,
} from './domain/comments.js'
import * as planning from './domain/plans.js'
import { addPreview } from './domain/previews.js'
import { myUsage, planningByUserWeek } from './domain/usage.js'
import { ApiError, errorBody } from './lib/errors.js'
import { MEDIA_KINDS } from './lib/media/classify.js'
import { AUDIO_CATEGORIES, LICENSE_FILTERS } from './domain/openverse.js'
import {
  COMMON_SEARCHES,
  getOpenverseJob,
  startOpenverseImport,
  startOpenverseSearch,
} from './domain/openverse-jobs.js'
import { libraryMatches } from './domain/music-library.js'
import { PREVIEW_NAMES } from './lib/media/previews.js'
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
  /^\/api\/v1\/edits\/[^/]+\/render$/,
  /^\/api\/v1\/videos$/,
  /^\/api\/v1\/videos\/[^/]+\/versions$/,
  /^\/api\/v1\/videos\/[^/]+\/versions\/\d+\/retry$/,
]

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const err = (desc: string) => json(s.ErrorSchema, desc)
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
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE',
        'access-control-allow-headers': 'authorization,content-type,idempotency-key,if-match',
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
    const rotated: { cookie?: string } = {}
    const principal = await principalFromRequest(deps, c.req.raw, {
      setCookie: (v) => {
        rotated.cookie = v
      },
    })
    assertSameOrigin(c.req.raw, principal)
    c.set('principal', principal)
    await next()
    if (rotated.cookie) c.header('set-cookie', rotated.cookie, { append: true })
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
      summary: 'Check health',
      description: 'Liveness and setup readiness. Never returns secrets.',
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
      summary: 'Get public config',
      description: 'Public configuration for the sign-in screen.',
      tags: ['system'],
      responses: { 200: json(s.PublicConfigSchema, 'Config') },
    }),
    (c) =>
      c.json(
        {
          admission: deps.config.allowedEmailDomains,
          siteUrl: deps.config.siteUrl,
          planningAvailable: deps.gateway.available(),
          mcpOAuth: oauthEnabled(deps),
          authProvider: deps.config.authProvider,
          requiredTeams: deps.config.netlifyRequiredTeams,
          // The deploy form lets these be skipped; say which are still needed (names only, never values).
          missingSettings: [
            ...(deps.config.runnerTokenPresent ? [] : (['RUNNER_API_TOKEN'] as const)),
            ...(deps.config.allowedEmailDomains ? [] : (['ALLOWED_EMAIL_DOMAINS'] as const)),
            ...(deps.config.adminEmails.length ? [] : (['ADMIN_EMAILS'] as const)),
          ],
        },
        200,
      ),
  )

  // ───── videos ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos',
      summary: 'Create a video',
      description: 'Creates a video from a prompt and queues its first version.',
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
      summary: 'List videos',
      description: 'Lists videos, newest first.',
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
      summary: 'Get a video',
      description: 'One video with its versions.',
      tags: ['videos'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.VideoSchema, 'Video'), 304: { description: 'Not modified' }, ...errors },
    }),
    async (c) => {
      await loadJob(deps.store, c.get('principal'), c.req.valid('param').id)
      assertCan(c.get('principal'), 'video:read')
      const dto = await videoDto(deps.store, deps, c.req.valid('param').id, c.get('principal'))
      // The signed file URLs' expiry is part of the HTTP validator, so a 304 never revives expired URLs.
      const exp = /[?&]exp=(\d+)/.exec(dto.versions.find((v) => v.files)?.files?.poster ?? '')?.[1]
      const etag = exp ? dto.etag.replace(/"$/, `-${exp}"`) : dto.etag
      c.header('etag', etag)
      c.header('cache-control', 'private, no-cache')
      if (c.req.header('if-none-match') === etag) return c.body(null, 304)
      return c.json(dto, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/videos/{id}',
      summary: 'Update a video',
      description: 'Renames a video or makes it private.',
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
      summary: 'Delete a video',
      description: 'Deletes a video, its versions, files and public links.',
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
      summary: 'Revise a video',
      description: 'Starts the next version from a ready one.',
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
      summary: 'Retry a version',
      description: 'Tries a failed, cancelled or timed-out version again.',
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
      summary: 'Cancel a version',
      description: 'Stops a version in progress.',
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
      summary: 'Publish a version',
      description: 'Publishes a version to a public share page and links.',
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
      summary: 'Unpublish a version',
      description: "Takes a version's public links down; they stop working on the next request.",
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
      method: 'put',
      path: '/api/v1/videos/{id}/versions/{n}/verdict',
      summary: 'Set your verdict',
      description:
        'Approve a version or request changes; null clears your verdict. Not allowed on your own version.',
      tags: ['review'],
      security,
      request: {
        params: VersionParam,
        body: { content: { 'application/json': { schema: s.SetVerdictSchema } }, required: true },
      },
      responses: { 200: json(s.VideoSchema, 'Updated'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json(await setVerdict(deps, c.get('principal'), p.id, p.n, c.req.valid('json')), 200)
    },
  )
  // Before the {file} route, which would otherwise take 'preview' as a file name.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/preview',
      summary: 'Get a preview link',
      description:
        "A short-lived link to play a ready version's composition in the sandboxed preview. With live=1, a running version's latest snapshot.",
      tags: ['videos'],
      security,
      request: { params: VersionParam, query: z.object({ live: z.enum(['1']).optional() }) },
      responses: { 200: json(s.PreviewLinkSchema, 'Preview link'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json(
        await previewLink(deps, c.get('principal'), p.id, p.n, { live: c.req.valid('query').live === '1' }),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/{file}',
      summary: 'Download a file',
      description: 'Redirects to a signed URL valid for 5 to 10 minutes.',
      tags: ['versions'],
      security,
      request: { params: FileParam, query: z.object({ download: z.enum(['1']).optional() }) },
      responses: { 302: { description: 'Signed URL' }, ...errors },
    }),
    async (c) => {
      const { id, n, file } = c.req.valid('param')
      const job = await loadJob(deps.store, c.get('principal'), id)
      assertCan(c.get('principal'), 'video:read')
      const out = await deps.store.getOutput(id, n)
      if (!out) throw new ApiError('not_ready', 'This version has no files yet.')
      c.header('cache-control', 'private, no-store')
      return c.redirect(
        await signedFilePath(deps, job, n, file, {
          download: c.req.valid('query').download === '1',
          stable: true,
        }),
        302,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/videos/{id}/versions/{n}/previews/{name}',
      summary: 'Add a preview variant',
      description:
        "Admins only. Adds a preview variant (or the placeholder, name lqip) to a ready version that doesn't have it yet.",
      tags: ['versions'],
      security,
      request: {
        params: VersionParam.extend({
          name: z.enum(['lqip', ...PREVIEW_NAMES]).openapi({ param: { name: 'name', in: 'path' } }),
        }),
        body: {
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
          required: true,
        },
      },
      responses: { 201: json(z.object({ name: z.string(), bytes: z.number().int() }), 'Added'), ...errors },
    }),
    async (c) => {
      const { id, n, name } = c.req.valid('param')
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(await addPreview(deps, c.get('principal'), id, n, name, bytes), 201)
    },
  )

  // ───── keys, me, users, stats ─────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/keys',
      summary: 'List API keys',
      description: 'Your API keys.',
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
      summary: 'Create an API key',
      description: 'Creates an API key. Its secret is shown once.',
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
      description: 'Revokes an API key; requests with it stop working.',
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
      path: '/api/v1/oauth/grants',
      summary: 'List connected apps',
      description: 'Your connected OAuth apps. 404 when MCP OAuth is off.',
      tags: ['keys'],
      security,
      responses: { 200: json(z.array(s.OAuthGrantSchema), 'Connected apps'), ...errors },
    }),
    async (c) => c.json(await listGrants(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/oauth/grants/{id}',
      summary: 'Disconnect an app',
      description: 'Disconnects an OAuth app; its tokens stop working.',
      tags: ['keys'],
      security,
      request: { params: IdParam },
      responses: { 204: { description: 'Revoked' }, ...errors },
    }),
    async (c) => {
      await revokeGrant(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me',
      summary: 'Get your account',
      description: 'Who you are: your account and role.',
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
      summary: 'List users',
      description: 'Everyone who has signed in, with their roles. Admins only.',
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
      summary: 'Update a user',
      description: 'Changes a role, or disables or enables a user. Admins only.',
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
      path: '/api/v1/me/webhook',
      summary: 'Get your webhook',
      description: 'Your webhook, for events on videos you own.',
      tags: ['keys'],
      security,
      responses: { 200: json(s.WebhookSettingSchema.nullable(), 'Webhook or null'), ...errors },
    }),
    async (c) => c.json(await hooks.getMyWebhook(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/me/webhook',
      summary: 'Set your webhook',
      description: 'Sets your webhook URL. A signing secret is returned once, on create or rotate.',
      tags: ['keys'],
      security,
      request: { body: { content: { 'application/json': { schema: s.PutWebhookSchema } }, required: true } },
      responses: { 200: json(s.WebhookSettingSchema, 'Saved'), ...errors },
    }),
    async (c) => c.json(await hooks.putMyWebhook(deps, c.get('principal'), c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/me/webhook',
      summary: 'Remove your webhook',
      description: 'Removes your webhook; pending deliveries to it are dropped.',
      tags: ['keys'],
      security,
      responses: { 204: { description: 'Removed' }, ...errors },
    }),
    async (c) => {
      await hooks.deleteMyWebhook(deps, c.get('principal'))
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/me/webhook/test',
      summary: 'Test your webhook',
      description: 'Sends a signed webhook.test event to your webhook now.',
      tags: ['keys'],
      security,
      responses: { 200: json(s.WebhookTestSchema, 'Result'), ...errors },
    }),
    async (c) => c.json(await hooks.testWebhook(deps, c.get('principal'), 'personal'), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/admin/team-webhook',
      summary: 'Get the team webhook',
      description: 'The team webhook, for events on every video. Admins only.',
      tags: ['admin'],
      security,
      responses: { 200: json(s.WebhookSettingSchema.nullable(), 'Webhook or null'), ...errors },
    }),
    async (c) => c.json(await hooks.getTeamWebhook(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/admin/team-webhook',
      summary: 'Set the team webhook',
      description:
        'Sets the team webhook URL. A signing secret is returned once, on create or rotate. Admins only.',
      tags: ['admin'],
      security,
      request: { body: { content: { 'application/json': { schema: s.PutWebhookSchema } }, required: true } },
      responses: { 200: json(s.WebhookSettingSchema, 'Saved'), ...errors },
    }),
    async (c) => c.json(await hooks.putTeamWebhook(deps, c.get('principal'), c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/admin/team-webhook',
      summary: 'Remove the team webhook',
      description: 'Removes the team webhook; pending deliveries to it are dropped. Admins only.',
      tags: ['admin'],
      security,
      responses: { 204: { description: 'Removed' }, ...errors },
    }),
    async (c) => {
      await hooks.deleteTeamWebhook(deps, c.get('principal'))
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/admin/team-webhook/test',
      summary: 'Test the team webhook',
      description: 'Sends a signed webhook.test event to the team webhook now. Admins only.',
      tags: ['admin'],
      security,
      responses: { 200: json(s.WebhookTestSchema, 'Result'), ...errors },
    }),
    async (c) => c.json(await hooks.testWebhook(deps, c.get('principal'), 'team'), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/plans',
      summary: 'Start a plan',
      description: 'Starts planning a video: a fast router decides whether a few questions would help.',
      tags: ['planning'],
      security,
      request: { body: { content: { 'application/json': { schema: s.CreatePlanSchema } }, required: true } },
      responses: { 201: json(s.PlanSchema, 'Plan'), ...errors },
    }),
    async (c) => c.json(await planning.createPlan(deps, c.get('principal'), c.req.valid('json')), 201),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/plans/{id}',
      summary: 'Get a plan',
      description: 'One of your plans.',
      tags: ['planning'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.PlanSchema, 'Plan'), ...errors },
    }),
    async (c) => c.json(await planning.getPlan(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/plans/{id}/questions',
      summary: 'Ask questions',
      description: 'Zero to six multiple-choice questions about the video; empty when the prompt covers it.',
      tags: ['planning'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.PlanSchema, 'Plan with questions'), ...errors },
    }),
    async (c) =>
      c.json(await planning.generateQuestions(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/plans/{id}/brief',
      summary: 'Write the brief',
      description: 'Turns the answers into an editable brief.',
      tags: ['planning'],
      security,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: s.PlanAnswersSchema } }, required: true },
      },
      responses: { 200: json(s.PlanSchema, 'Plan with a brief'), ...errors },
    }),
    async (c) =>
      c.json(
        await planning.generateBrief(
          deps,
          c.get('principal'),
          c.req.valid('param').id,
          c.req.valid('json').answers,
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/plans/{id}',
      summary: 'Edit the brief',
      description: 'Saves your edits to the brief. Send the briefRev you loaded.',
      tags: ['planning'],
      security,
      request: {
        params: IdParam,
        headers: z.object({ 'if-match': z.string().optional() }),
        body: { content: { 'application/json': { schema: s.PatchPlanSchema } }, required: true },
      },
      responses: { 200: json(s.PlanSchema, 'Saved'), ...errors },
    }),
    async (c) => {
      // The revision comes in the body (some CDNs consume If-Match before it reaches the function) or If-Match.
      const raw = c.req.header('if-match')?.replace(/"/g, '')
      const body = c.req.valid('json')
      const ifMatch = body.briefRev ?? (raw && /^\d+$/.test(raw) ? Number(raw) : null)
      return c.json(
        await planning.updatePlanBrief(
          deps,
          c.get('principal'),
          c.req.valid('param').id,
          c.req.valid('json').brief,
          ifMatch,
        ),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me/usage',
      summary: 'Get your usage',
      description: 'Your credits this month: agent runs and planning (estimates).',
      tags: ['usage'],
      security,
      responses: { 200: json(s.MyUsageSchema, 'Usage'), ...errors },
    }),
    async (c) => c.json(await myUsage(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/notifications',
      summary: 'List notifications',
      description: 'Comments and approvals on your videos, newest first, with an unread count.',
      tags: ['notifications'],
      security,
      request: {
        query: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
      },
      responses: { 200: json(s.NotificationListSchema, 'Notifications'), ...errors },
    }),
    async (c) => c.json(await listNotifications(deps, c.get('principal'), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/notifications/read',
      summary: 'Mark notifications read',
      description: 'Marks notifications read: all, or up to a time.',
      tags: ['notifications'],
      security,
      request: {
        body: {
          content: { 'application/json': { schema: z.object({ upTo: z.string().optional() }) } },
          required: false,
        },
      },
      responses: { 204: { description: 'Marked read' }, ...errors },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { upTo?: string }
      await markNotificationsRead(deps, c.get('principal'), body.upTo)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/progress',
      summary: 'Get progress',
      description: "Live progress of the latest version's run: the agent's step, steps and credits so far.",
      tags: ['videos'],
      security,
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(s.ProgressSchema, 'Progress'), ...errors },
    }),
    async (c) => c.json(await getProgress(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/edits',
      summary: 'Open an edit draft',
      description: 'Opens your edit draft of a finished, editable version, creating it if you have none.',
      tags: ['editor'],
      security,
      request: { params: VersionParam },
      responses: {
        200: json(s.EditSchema, 'Your open draft'),
        201: json(s.EditSchema, 'A new draft'),
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const r = await openEdit(deps, c.get('principal'), p.id, p.n)
      return c.json(r.edit, r.created ? 201 : 200)
    },
  )
  const EditParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/edits/{id}',
      summary: 'Get an edit draft',
      description: 'One of your edit drafts.',
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 200: json(s.EditSchema, 'Draft'), ...errors },
    }),
    async (c) => c.json(await getEdit(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/edits/{id}',
      summary: 'Save edits',
      description:
        'Saves the full list of edits as the next rev. rev must match the draft, for multi-tab safety.',
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        body: { content: { 'application/json': { schema: s.SaveEditSchema } }, required: true },
      },
      responses: { 200: json(s.EditSchema, 'Saved'), ...errors },
    }),
    async (c) =>
      c.json(await saveEdit(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/edits/{id}',
      summary: 'Discard a draft',
      description: 'Discards one of your edit drafts.',
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 204: { description: 'Discarded' }, ...errors },
    }),
    async (c) => {
      await discardEdit(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/edits/{id}/render',
      summary: 'Render a draft',
      description:
        'Renders your draft as the next version, unchanged: the run checks and renders and never redesigns.',
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        headers: z.object({ 'idempotency-key': z.string().max(200).optional() }),
      },
      responses: { 202: json(s.VideoSchema, 'Queued'), ...errors, 503: err('Setup required') },
    }),
    async (c) => {
      const res = await renderEdit(
        deps,
        c.get('principal'),
        c.req.valid('param').id,
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
      path: '/api/v1/edits/{id}/preview',
      summary: 'Get a draft preview link',
      description: "A short-lived link to play the draft's current rev in the sandboxed preview.",
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 200: json(s.PreviewLinkSchema, 'Preview link'), ...errors },
    }),
    async (c) => c.json(await editPreviewLink(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  // ───── media library (plan v2 §9) ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media',
      summary: 'Upload a file',
      description:
        'Uploads one file up to 4 MB as the request body: images, SVG, fonts, short clips. Bigger files use upload sessions.',
      tags: ['media'],
      security,
      request: {
        query: z.object({
          filename: z.string().max(200).optional(),
          caption: z.string().max(500).optional(),
        }),
        body: {
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
          required: true,
        },
      },
      responses: { 201: json(s.MediaSchema, 'Uploaded'), ...errors },
    }),
    async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0)
      if (declared > SINGLE_UPLOAD_MAX + 1024)
        throw new ApiError('invalid_request', 'Files over 4 MB upload in parts: start an upload session.')
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const q = c.req.valid('query')
      return c.json(await uploadMedia(deps, c.get('principal'), bytes, q), 201)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media',
      summary: 'List media',
      description: "The team's media library, newest first, plus your own uploads still being checked.",
      tags: ['media'],
      security,
      request: {
        query: z.object({
          kind: z.enum(MEDIA_KINDS).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
      responses: { 200: json(s.MediaListSchema, 'Media'), ...errors },
    }),
    async (c) => c.json(await listMedia(deps, c.get('principal'), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/check',
      summary: 'Check for duplicates',
      description:
        'Before uploading, finds what the library already has for each file: the same file (by sha256) or a different file with the same name.',
      tags: ['media'],
      security,
      request: { body: { content: { 'application/json': { schema: s.MediaCheckSchema } }, required: true } },
      responses: { 200: json(s.MediaCheckResultSchema, 'Matches'), ...errors },
    }),
    async (c) => c.json(await checkMedia(deps, c.get('principal'), c.req.valid('json').files), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/uploads',
      summary: 'Start an upload',
      description:
        'Starts an upload session for a file over 4 MB. Declare its size and sha256; quota is reserved.',
      tags: ['media'],
      security,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                filename: z.string().min(1).max(200),
                size: z.number().int().positive(),
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
                caption: z.string().max(500).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        201: json(s.UploadSessionSchema, 'Session'),
        ...errors,
        429: err('Too many uploads in progress'),
      },
    }),
    async (c) => c.json(await createUpload(deps, c.get('principal'), c.req.valid('json')), 201),
  )
  const UploadParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/uploads/{id}',
      summary: 'Get an upload',
      description: 'An upload session: which parts arrived (to resume) and its status.',
      tags: ['media'],
      security,
      request: { params: UploadParam },
      responses: { 200: json(s.UploadSessionSchema, 'Session'), ...errors },
    }),
    async (c) => c.json(await getUpload(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/media/uploads/{id}/parts/{index}',
      summary: 'Upload a part',
      description:
        'Sends one part (at most 4 MB) as the request body; x-part-sha256 guards against corruption.',
      tags: ['media'],
      security,
      request: {
        params: z.object({ id: z.string(), index: z.coerce.number().int().min(0) }),
        headers: z.object({
          'x-part-sha256': z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        }),
        body: {
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
          required: true,
        },
      },
      responses: {
        200: json(z.object({ idx: z.number().int(), sha256: z.string(), duplicate: z.boolean() }), 'Stored'),
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(
        await putPart(deps, c.get('principal'), p.id, p.index, bytes, c.req.valid('header')['x-part-sha256']),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/uploads/{id}/complete',
      summary: 'Finish an upload',
      description: 'The file is assembled and checked in the background; poll the session or the item.',
      tags: ['media'],
      security,
      request: {
        params: UploadParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                poster: z
                  .string()
                  .max(700_000)
                  .optional()
                  .openapi({ description: 'Base64 JPEG poster for a clip' }),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 202: json(s.UploadSessionSchema, 'Assembling'), ...errors },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { poster?: string }
      return c.json(await completeUpload(deps, c.get('principal'), c.req.valid('param').id, body), 202)
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/media/uploads/{id}',
      summary: 'Cancel an upload',
      description: 'Cancels an unfinished upload session and frees its parts and quota.',
      tags: ['media'],
      security,
      request: { params: UploadParam },
      responses: { 204: { description: 'Cancelled' }, ...errors },
    }),
    async (c) => {
      await cancelUpload(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  // ───── Openverse: find openly licensed music and import it (CC0 and CC BY only) ─────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/openverse/search',
      summary: 'Search Openverse',
      description:
        'Searches Openverse for CC0 or CC BY audio (music by default); NC, ND and SA licences are never returned. Creators and admins. When Openverse is slow, answers 202 with a job to poll.',
      tags: ['media'],
      security,
      request: {
        query: z.object({
          q: z.string().min(1).max(200),
          license: z.enum(LICENSE_FILTERS).optional().openapi({
            description: 'cc0 (no credit needed) or cc0,by (the default; CC BY tracks are credited)',
          }),
          category: z
            .enum(AUDIO_CATEGORIES)
            .optional()
            .openapi({ description: 'music (the default), sound_effect, or all audio' }),
          page: z.coerce.number().int().min(1).max(10).optional(),
        }),
      },
      responses: {
        200: json(
          s.OpenverseSearchSchema,
          'Tracks: fresh, or from an identical search in the last two weeks (stale after a day, then refreshed in the background)',
        ),
        202: json(
          s.OpenverseJobSchema,
          'Openverse is slow: poll the job (the Location header) for the tracks',
        ),
        ...errors,
        429: err('Openverse is busy, or too many searches this minute'),
        502: err("Openverse didn't answer"),
      },
    }),
    async (c) => {
      const r = await startOpenverseSearch(deps, c.get('principal'), c.req.valid('query'))
      if (r.job) return c.json(r.job, 202, { location: `/api/v1/media/openverse/jobs/${r.job.id}` })
      return c.json(r.done, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/openverse/library',
      summary: 'Search library music',
      description:
        'Audio already in the team library that matches music search words (title, caption, filename, creator or source), answered at once without asking Openverse.',
      tags: ['media'],
      security,
      request: { query: z.object({ q: z.string().min(1).max(200) }) },
      responses: { 200: json(s.MusicLibraryMatchesSchema, 'Matching library audio'), ...errors },
    }),
    async (c) =>
      c.json({ items: await libraryMatches(deps, c.get('principal'), c.req.valid('query').q) }, 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/openverse/common',
      summary: 'List quick music picks',
      description: 'Common music searches, kept warm every day: quick picks that answer at once.',
      tags: ['media'],
      security,
      responses: { 200: json(s.OpenverseCommonSchema, 'The searches'), ...errors },
    }),
    async (c) => c.json({ queries: [...COMMON_SEARCHES] }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/openverse/import',
      summary: 'Import from Openverse',
      description:
        'Imports an Openverse track into the library by its id: re-read from Openverse, licence checked, file downloaded and verified as audio. Importing it again returns the same item. When Openverse is slow, answers 202 with a job to poll.',
      tags: ['media'],
      security,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                id: z.string().min(1).max(64).openapi({ description: 'The Openverse audio id' }),
                caption: z.string().max(500).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(s.MediaSchema, 'Already in the library'),
        201: json(s.MediaSchema, 'Imported'),
        202: json(s.OpenverseJobSchema, 'Importing in the background: poll the job (the Location header)'),
        ...errors,
        429: err('Openverse is busy, or too many imports this minute'),
        502: err("Openverse or the track's host didn't answer"),
      },
    }),
    async (c) => {
      const r = await startOpenverseImport(deps, c.get('principal'), c.req.valid('json'))
      if (r.job) return c.json(r.job, 202, { location: `/api/v1/media/openverse/jobs/${r.job.id}` })
      return r.done.created ? c.json(r.done.media, 201) : c.json(r.done.media, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/openverse/jobs/{id}',
      summary: 'Get an Openverse job',
      description:
        'An Openverse search or import running in the background: its status, then the tracks or the library item. Only for the person who started it.',
      tags: ['media'],
      security,
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(s.OpenverseJobSchema, 'The job'), ...errors },
    }),
    async (c) => c.json(await getOpenverseJob(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  const MediaParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/{id}',
      summary: 'Get a media item',
      description: 'One media item.',
      tags: ['media'],
      security,
      request: { params: MediaParam },
      responses: { 200: json(s.MediaSchema, 'Media'), ...errors },
    }),
    async (c) => c.json(await getMedia(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/media/{id}',
      summary: 'Update a caption',
      description: 'Changes the caption (uploader or admin).',
      tags: ['media'],
      security,
      request: {
        params: MediaParam,
        body: {
          content: { 'application/json': { schema: z.object({ caption: z.string().max(500).nullable() }) } },
          required: true,
        },
      },
      responses: { 200: json(s.MediaSchema, 'Updated'), ...errors },
    }),
    async (c) =>
      c.json(await updateMedia(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/media/{id}',
      summary: 'Remove a media item',
      description: 'Removes it from the library (uploader or admin); versions that used it keep it.',
      tags: ['media'],
      security,
      request: { params: MediaParam },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await deleteMedia(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  const CommentParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/comments',
      summary: 'List comments',
      description: 'Comments on a video (optionally one version), oldest first, with your unread count.',
      tags: ['review'],
      security,
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({
          version: z.coerce.number().int().positive().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(s.CommentListSchema, 'Comments'), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query')
      return c.json(
        await listComments(deps, c.get('principal'), c.req.valid('param').id, {
          versionN: q.version,
          cursor: q.cursor,
          limit: q.limit,
        }),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/comments',
      summary: 'Add a comment',
      description: 'Comments on a version, optionally pinned to a moment (timeSec) and a spot (x, y).',
      tags: ['review'],
      security,
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { 'application/json': { schema: s.CreateCommentSchema } }, required: true },
      },
      responses: { 201: json(s.CommentSchema, 'Created'), ...errors },
    }),
    async (c) =>
      c.json(await addComment(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 201),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/comments/read',
      summary: 'Mark comments read',
      description: "Marks this video's comments read: all, or up to a time.",
      tags: ['review'],
      security,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: { 'application/json': { schema: z.object({ upTo: z.string().optional() }) } },
          required: false,
        },
      },
      responses: { 204: { description: 'Marked read' }, ...errors },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { upTo?: string }
      await markCommentsRead(deps, c.get('principal'), c.req.valid('param').id, body.upTo)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/comments/{id}',
      summary: 'Update a comment',
      description: 'Edit your comment, or resolve or reopen one (video owner or admin).',
      tags: ['review'],
      security,
      request: {
        params: CommentParam,
        body: { content: { 'application/json': { schema: s.PatchCommentSchema } }, required: true },
      },
      responses: { 200: json(s.CommentSchema, 'Updated'), ...errors },
    }),
    async (c) =>
      c.json(
        await updateComment(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/comments/{id}',
      summary: 'Delete a comment',
      description: 'Deletes your comment, or any comment on your video (owner or admin).',
      tags: ['review'],
      security,
      request: { params: CommentParam },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await deleteComment(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/transfers',
      summary: 'Transfer videos',
      description:
        "Transfers videos to another Creator or Admin: some videos, or all of a person's. Admins only.",
      tags: ['admin'],
      security,
      request: { body: { content: { 'application/json': { schema: s.TransferSchema } }, required: true } },
      responses: { 200: json(s.TransferResultSchema, 'Transferred'), ...errors },
    }),
    async (c) => {
      const b = c.req.valid('json')
      return c.json(
        await transferVideos(deps, c.get('principal'), {
          toUserId: b.toUserId,
          jobIds: b.videoIds,
          fromUserId: b.fromUserId,
        }),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/stats',
      summary: 'Get stats',
      description: 'Runs, queue, failures and credits. Admins only.',
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
        deps.store.listAttemptsByStage(
          ['finding_music', 'starting', 'running', 'cancelling', 'finishing'],
          100,
        ),
        deps.store.listAttemptsByStage(['queued'], 1000),
        deps.store.listAttemptsByStage(['unresolved'], 100),
        deps.store.failuresSince(weekAgo),
        deps.store.usageSince(monthAgo),
        deps.store.listUsers(),
        deps.store.getSettings(),
      ])
      const planningRows = planningByUserWeek(await deps.store.listGatewayCalls({ since: monthAgo }))
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
          usage: [
            ...usage.map((u) => {
              const p = planningRows.get(`${u.userId}|${u.week}`)
              planningRows.delete(`${u.userId}|${u.week}`)
              return {
                ...u,
                email: email.get(u.userId) ?? null,
                planningCredits: Math.round((p?.credits ?? 0) * 100) / 100,
                planningUnknown: p?.unknown ?? 0,
              }
            }),
            // People who planned but made no runs that week.
            ...[...planningRows.values()].map((p) => ({
              userId: p.userId,
              email: email.get(p.userId) ?? null,
              week: p.week,
              credits: 0,
              videos: 0,
              planningCredits: Math.round(p.credits * 100) / 100,
              planningUnknown: p.unknown,
            })),
          ],
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
      summary: 'Resolve a stuck start',
      description: 'Marks an unresolved start as failed and frees its slot. Admins only.',
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
      summary: 'Resume the queue',
      description: 'Resumes a queue paused because AI credits were unavailable. Admins only.',
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
    if (oauthEnabled(deps)) return mcpWithOAuth(c)
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
  // With OAuth on, other bearer tokens are tried as OAuth access tokens, and 401s point clients at the metadata.
  const mcpWithOAuth = async (c: Context<Env>) => {
    const challenge = (error?: string) => ({
      'www-authenticate': `Bearer ${error ? `error="${error}", ` : ''}resource_metadata="${resourceMetadataUrl(deps)}"`,
    })
    if (!c.req.header('authorization')) {
      return c.json(
        errorBody(
          'unauthorized',
          'Connect with OAuth (Sign in with Netlify), or send an API key as "Authorization: Bearer nva_…".',
        ),
        401,
        challenge(),
      )
    }
    let principal: Principal
    try {
      principal = await principalFromRequest(deps, c.req.raw, {
        otherBearer: (token) => principalFromAccessToken(deps, token),
      })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthorized')
        return c.json(errorBody(e.code, e.message), 401, challenge('invalid_token'))
      throw e
    }
    if (principal.kind === 'user') throw new ApiError('unauthorized', 'MCP needs an API key or OAuth.')
    return handleMcp(deps, principal, c.req.raw, () => {
      kick(c)
    })
  }
  // /mcp is the short URL people paste into their clients; the function serves it directly.
  app.all('/api/mcp', mcp)
  app.all('/mcp', mcp)
  if (oauthEnabled(deps)) app.route('/', oauthRoutes(deps))
  if (webSignInEnabled(deps)) app.route('/', webAuthRoutes(deps, { withCallback: !oauthEnabled(deps) }))

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

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/internal/runs/{id}/checkpoint',
      hide: true,
      request: {
        params: IdParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                seq: z.number().int().min(0),
                message: z.string().max(2000).optional(),
                renderPercent: z.number().int().min(0).max(100).optional(),
                bundle: z.string().max(3_000_000).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: { description: 'Accepted, or ignored as older than the latest' },
        400: err('Invalid'),
        401: err('Bad token'),
        410: err('Gone'),
        429: err('Too many'),
      },
    }),
    async (c) => {
      const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null
      return c.json(await receiveCheckpoint(deps, c.req.valid('param').id, token, c.req.valid('json')), 200)
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
    name: deps.config.authProvider === 'netlify' ? 'va_session' : 'nf_jwt',
    description:
      deps.config.authProvider === 'netlify'
        ? 'The web app session (Sign in with Netlify). State-changing requests must be same-origin.'
        : 'The web app session (Netlify Identity). State-changing requests must be same-origin.',
  })

  const tag = (name: string, displayName: string, description: string) => ({
    name,
    description,
    'x-displayName': displayName,
  })
  const spec = () =>
    app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Video Agent API',
        version: '1.0.0',
        description:
          'Make videos from a prompt with Netlify Agent Runners and HyperFrames. Everything the web app does is in this API: authenticate with a key from the [API keys](/keys) page.',
      },
      servers: [{ url: deps.config.siteUrl }],
      // The reference's sidebar groups, in this order, each with a name and one line on what's in it.
      tags: [
        tag(
          'videos',
          'Videos',
          'Create a video from a prompt, list and update videos, and follow a run while it works.',
        ),
        tag(
          'versions',
          'Versions',
          'Revise a video into its next version, retry or cancel one, and download its files.',
        ),
        tag(
          'planning',
          'Planning',
          'Plan before creating: a few questions, then an editable brief to create the video with.',
        ),
        tag(
          'editor',
          'Editor',
          'Edit a finished version in the browser: open a draft, save edits, preview and render them.',
        ),
        tag(
          'publishing',
          'Publishing',
          'Give a version a public share page, MP4, GIF and embed links, or take them down.',
        ),
        tag('review', 'Review', 'Comments pinned to moments in a video, and approvals.'),
        tag('media', 'Media', "The team's media library: uploads, music from Openverse and captions."),
        tag('notifications', 'Notifications', 'Comments and approvals on your videos.'),
        tag('keys', 'Keys and webhooks', 'API keys, connected OAuth apps and your webhook.'),
        tag('me', 'Account', 'Who you are.'),
        tag('usage', 'Usage', 'Your AI credits this month.'),
        tag(
          'admin',
          'Admin',
          'People and roles, the team webhook, transfers, stats and the queue. Admins only.',
        ),
        tag('system', 'System', 'Health and public configuration. No sign-in needed.'),
      ],
    })
  app.get('/api/openapi.json', (c) => c.json(spec()))
  app.get('/api/docs', (c) =>
    c.html(`<!doctype html><html><head><title>Video Agent API</title><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script id="api-reference" type="application/json">${JSON.stringify(spec()).replaceAll('<', '\\u003c')}</script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4"></script></body></html>`),
  )

  return Object.assign(app, { spec })
}
