// The Hono app behind /api/*. createApp(deps) is used by the Netlify Function, tests and spec generation.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { Deps } from './deps.js'
import { listEngines } from './domain/engines.js'
import { assertSameOrigin, principalFromRequest } from './domain/auth.js'
import { receiveCallback } from './domain/callback.js'
import { claimLogin, createLogin, decideLogin, lookupLogin } from './domain/cli-login.js'
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
  setFavorite,
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
import { reviseCaptions } from './domain/captions.js'
import { resetPoster, setPoster } from './domain/poster.js'
import { signedFilePath, versionFileName } from './domain/files.js'
import { handleMcp } from './mcp.js'
import { listDestinations } from './domain/destinations/list.js'
import { publishToDestination, retryDestinationPublication } from './domain/destinations/publish.js'
import { removeDestinationEverywhere, unpublishFromDestination } from './domain/destinations/remove.js'
import {
  createDestination,
  deleteDestination,
  listAdminDestinations,
  rotateDestinationSecret,
  testDestination,
  updateDestination,
} from './domain/destinations/admin.js'
import { listDestinationTargets, revealDestinationSecret } from './domain/destinations/people.js'
import { destinationFiles, receiveDestinationCallback } from './domain/destinations/callbacks.js'
import { deleteConnection, listConnections } from './domain/destinations/connections.js'
import { googleRoutes } from './auth/google.js'
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
import { getAdminSettings, updateAdminSettings } from './domain/narration-settings.js'
import { enabledFeatures } from './domain/features.js'
import { PROMPT_TEMPLATE_VERSION } from './domain/prompt.js'
import { buildInfo } from './generated/build-info.js'
import { listLooks } from './domain/looks.js'
import { remixVideo, versionMediaItems } from './domain/remix.js'
import { listNotifications, markNotificationsRead } from './domain/notifications.js'
import { getProgress } from './domain/progress.js'
import { previewLink } from './domain/preview.js'
import { fillBeats } from './domain/beats.js'
import { cancelUpload, completeUpload, createUpload, getUpload, putPart } from './domain/media-uploads.js'
import { getMediaTrace, setMediaTrace } from './domain/media-trace.js'
import { TRACE_MAX_BYTES } from './lib/recording-trace.js'
import {
  getTakePeaks,
  getTakeSpeech,
  PEAKS_MAX_BYTES,
  putTakePeaks,
  putTakeSpeech,
} from './domain/take-extras.js'
import {
  deleteMedia,
  checkMedia,
  getMedia,
  listMedia,
  listVideoRecordings,
  SINGLE_UPLOAD_MAX,
  updateMedia,
  uploadMedia,
} from './domain/media.js'
import { deleteUnusedRecordings } from './domain/recording-retention.js'
import { discardEdit, editPreviewLink, getEdit, openEdit, renderEdit, saveEdit } from './domain/edits.js'
import {
  acquireNarrationLock,
  getNarrationLock,
  releaseNarrationLock,
  takeOverNarrationLock,
} from './domain/narration-lock.js'
import { rebaseNarration } from './domain/narration-rebase.js'
import { receiveCheckpoint } from './domain/checkpoints.js'
import {
  addComment,
  addComments,
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
import { MEDIA_ROLES } from './domain/types.js'
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
  /^\/api\/v1\/videos\/[^/]+\/remix$/,
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
/** The only paths besides /api/v1/config that skip requireAuth, and only for POST. */
const CLI_LOGIN_OPEN = [/^\/api\/v1\/cli\/logins$/, /^\/api\/v1\/cli\/logins\/cli_[\w-]+\/token$/]
const clientIp = (c: Context<Env>) => c.req.header('x-nf-client-connection-ip') ?? 'unknown'

const IdParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })
const IdempotencyHeader = z.object({ 'idempotency-key': z.string().max(200).optional() })
const VersionParam = IdParam.extend({
  n: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'n', in: 'path' } }),
})
const FileParam = VersionParam.extend({
  file: z
    .enum(['video', 'poster', 'gif', 'captions', 'narration-audio', 'transcript'])
    .openapi({ param: { name: 'file', in: 'path' } }),
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

  // Netlify's request id ties a client's error (the SDK's requestId, the CLI's message) to these log lines.
  app.onError((e, c) => {
    const requestId = c.req.header('x-nf-request-id') ?? null
    if (e instanceof ApiError) {
      if (e.code === 'rate_limited') c.header('Retry-After', '60')
      deps.log.info('api.error', {
        path: c.req.path,
        method: c.req.method,
        status: e.status,
        code: e.code,
        requestId,
      })
      return c.json(errorBody(e.code, e.message, e.details), e.status as 400)
    }
    deps.log.error('api.unhandled', { path: c.req.path, method: c.req.method, requestId, error: e })
    return c.json(errorBody('internal', 'Something went wrong.'), 500)
  })
  app.notFound((c) => c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}.`), 404))

  // Every request in one debug line (DEBUG_LEVEL=verbose): who, what, the outcome and how long it took. The
  // logger redacts signed-URL parameters; bodies aren't logged here (prompts are, where they're used).
  if (deps.log.verbose)
    app.use('*', async (c, next) => {
      const started = Date.now()
      await next()
      const p = c.get('principal') as Principal | undefined
      deps.log.debug('http.request', {
        method: c.req.method,
        path: c.req.path,
        query: new URL(c.req.url).search || null,
        status: c.res.status,
        ms: Date.now() - started,
        ...(p ? { caller: p.kind, userId: p.userId, role: p.role } : {}),
        userAgent: c.req.header('user-agent')?.slice(0, 160) ?? null,
      })
    })

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
        'access-control-allow-headers': 'authorization,content-type,idempotency-key,if-match,if-none-match',
        'access-control-max-age': '600',
        vary: 'origin',
      })
    }
    await next()
    if (allowed && c.req.header('authorization')) {
      c.header('access-control-allow-origin', origin)
      // The SDK reads these: request ids in errors, ETags for waiting, Retry-After, and a new video's Location.
      c.header('access-control-expose-headers', 'x-nf-request-id,etag,retry-after,location')
      c.header('vary', 'origin')
    }
  })

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    if (c.req.path === '/api/v1/config' || c.req.method === 'OPTIONS') return next()
    // video-agent login: the CLI has no credentials yet; it starts a login and claims it with its device code.
    if (c.req.method === 'POST' && CLI_LOGIN_OPEN.some((r) => r.test(c.req.path))) return next()
    // Receiver callbacks authenticate with their own per-operation token (publish destinations §3.3).
    if (c.req.path.startsWith('/api/v1/destination-callbacks/')) return next()
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
  /** A queued video's response: its location, a kick unless the request was a replay, and the stored status. */
  const queued = (c: Context<Env>, res: Awaited<ReturnType<typeof createVideo>>) => {
    c.header('location', res.body.links.self)
    if (!res.replayed) kick(c)
    return c.json(res.body, res.status as 202)
  }

  // ───── public ─────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/health',
      operationId: 'getHealth',
      'x-sdk': false,
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
      operationId: 'getConfig',
      'x-sdk': { resource: 'config', method: 'get' },
      summary: 'Get public config',
      description: 'Public configuration for the sign-in screen.',
      tags: ['system'],
      responses: { 200: json(s.PublicConfigSchema, 'Config') },
    }),
    async (c) => {
      const features = await enabledFeatures(deps)
      return c.json(
        {
          version: { ...buildInfo, promptTemplate: PROMPT_TEMPLATE_VERSION },
          features,
          admission: deps.config.allowedEmailDomains,
          siteUrl: deps.config.siteUrl,
          planningAvailable: deps.gateway.available(),
          mcpOAuth: oauthEnabled(deps),
          authProvider: deps.config.authProvider,
          requiredTeams: deps.config.netlifyRequiredTeams,
          narrationEnabled: features.includes('narration'),
          remixEnabled: features.includes('remix'),
          youtubeAvailable: features.includes('youtube'),
          // The deploy form lets these be skipped; say which are still needed (names only, never values).
          missingSettings: [
            ...(deps.config.runnerTokenPresent ? [] : (['RUNNER_API_TOKEN'] as const)),
            ...(deps.config.allowedEmailDomains ? [] : (['ALLOWED_EMAIL_DOMAINS'] as const)),
            ...(deps.config.adminEmails.length ? [] : (['ADMIN_EMAILS'] as const)),
          ],
        },
        200,
      )
    },
  )

  // ───── videos ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos',
      operationId: 'createVideo',
      'x-sdk': {
        resource: 'videos',
        method: 'create',
        fieldFeatures: {
          planId: 'planning',
          look: 'looks',
          externalRef: 'external_ref',
          externalUrl: 'external_ref',
          private: 'external_ref',
          context: 'context',
          recording: 'screen_recording',
          agent: 'screen_recording',
        },
      },
      summary: 'Create a video',
      description: 'Creates a video from a prompt and queues its first version.',
      tags: ['videos'],
      security,
      request: {
        headers: IdempotencyHeader,
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
      return queued(c, res)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos',
      operationId: 'listVideos',
      'x-sdk': { resource: 'videos', method: 'list', fieldFeatures: { externalRef: 'external_ref' } },
      summary: 'List videos',
      description: 'Lists videos, newest first.',
      tags: ['videos'],
      security,
      request: {
        query: z.object({
          status: s.StatusSchema.optional(),
          owner: z.enum(['me', 'all']).optional(),
          published: z.enum(['true', 'false']).optional(),
          favorite: z
            .enum(['true', 'false'])
            .optional()
            .openapi({ description: 'true: only videos you starred' }),
          q: z.string().max(200).optional(),
          externalRef: s.ExternalRefSchema.optional().openapi({
            description: 'Only videos made with this externalRef (exact match), newest first',
          }),
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
        favorite: q.favorite === 'true',
      })
      return c.json(res, 200)
    },
  )
  for (const method of ['put', 'delete'] as const)
    app.openapi(
      createRoute({
        method,
        path: '/api/v1/videos/{id}/favorite',
        operationId: method === 'put' ? 'favoriteVideo' : 'unfavoriteVideo',
        'x-sdk': { resource: 'videos', method: method === 'put' ? 'favorite' : 'unfavorite' },
        summary: method === 'put' ? 'Star a video' : 'Unstar a video',
        description:
          method === 'put'
            ? 'Adds the video to your favorites. Favorites are per person: only you see them. Idempotent.'
            : 'Removes the video from your favorites. Idempotent.',
        tags: ['videos'],
        security,
        request: { params: IdParam },
        responses: { 204: { description: method === 'put' ? 'Starred' : 'Unstarred' }, ...errors },
      }),
      async (c) => {
        await setFavorite(deps, c.get('principal'), c.req.valid('param').id, method === 'put')
        return c.body(null, 204)
      },
    )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}',
      operationId: 'getVideo',
      'x-sdk': { resource: 'videos', method: 'get' },
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
      operationId: 'updateVideo',
      'x-sdk': { resource: 'videos', method: 'update' },
      summary: 'Update a video',
      description:
        'Renames a video, makes it private, or sets the language spoken in it (for narration captions).',
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
      operationId: 'deleteVideo',
      'x-sdk': { resource: 'videos', method: 'delete' },
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
      operationId: 'reviseVideo',
      'x-sdk': {
        resource: 'videos',
        method: 'revise',
        fieldFeatures: { planId: 'planning', scope: 'scoped_revision', look: 'looks', context: 'context' },
      },
      summary: 'Revise a video',
      description:
        "Starts the next version from a ready one. With scope, only those scenes of fromVersion are redone and everything else stays exactly as it is (redo a scene): 409 not_editable when that version can't be redone scene by scene (no editing contract, or its engine can't), 400 for scene ids it doesn't have.",
      tags: ['versions'],
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeader,
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
      return queued(c, res)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/remix',
      operationId: 'remixVideo',
      'x-sdk': {
        resource: 'videos',
        method: 'remix',
        feature: 'remix',
        fieldFeatures: {
          planId: 'planning',
          look: 'looks',
          externalRef: 'external_ref',
          externalUrl: 'external_ref',
          private: 'external_ref',
          context: 'context',
          recording: 'screen_recording',
        },
      },
      summary: 'Remix a video',
      description:
        "Makes a NEW video, owned by you, that starts from this video's finished composition (a ready version) and changes it as the prompt says: anything from swapping a name to the same format on a new topic. Its shape, length, sound, AI voice-over and library media come from the source unless you set them; recorded narration, comments and publications don't carry over. A private video's remix is private. Returns the new video.",
      tags: ['videos'],
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeader,
        body: { content: { 'application/json': { schema: s.RemixSchema } }, required: true },
      },
      responses: {
        202: json(s.VideoSchema, 'Queued: the new video'),
        ...errors,
        409: err('Not ready, remixing turned off by an admin (remix_disabled), or a key reused'),
        503: err('Setup required'),
      },
    }),
    async (c) => {
      const res = await remixVideo(
        deps,
        c.get('principal'),
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'],
      )
      return queued(c, res)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/media',
      operationId: 'listVersionMedia',
      'x-sdk': { resource: 'versions', method: 'media' },
      summary: "A version's library media",
      description:
        'The library items a version was made with, in order (items since deleted from the library included). A remix keeps them unless you pass mediaIds.',
      tags: ['versions'],
      security,
      request: { params: VersionParam },
      responses: { 200: json(z.object({ items: z.array(s.MediaSchema) }), 'Media'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json(await versionMediaItems(deps, c.get('principal'), p.id, p.n), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/beats',
      operationId: 'getVersionBeats',
      'x-sdk': { resource: 'versions', method: 'beats', feature: 'scoped_revision' },
      summary: "A version's scenes",
      description:
        "The scenes (beats) of a ready version, in order, for redoing some of them: pass their ids as scope.beats with this version as fromVersion. Null for a version that can't be edited scene by scene. Versions made before this list existed get it filled on first read. 409 when the version isn't ready.",
      tags: ['versions'],
      security,
      request: { params: VersionParam },
      responses: {
        200: json(z.object({ beats: z.array(s.BeatInfoSchema).nullable() }), 'Scenes'),
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json({ beats: await fillBeats(deps, c.get('principal'), p.id, p.n) }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/retry',
      operationId: 'retryVersion',
      'x-sdk': { resource: 'versions', method: 'retry' },
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
      operationId: 'cancelVersion',
      'x-sdk': { resource: 'versions', method: 'cancel' },
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
      operationId: 'publishVersion',
      'x-sdk': { resource: 'versions', method: 'publish' },
      summary: 'Publish a version',
      description:
        "Publishes a version to a public share page and links. With showTranscript, the share page offers the narration's transcript.",
      tags: ['publishing'],
      security,
      request: {
        params: VersionParam,
        body: { content: { 'application/json': { schema: s.PublishSchema } }, required: false },
      },
      responses: { 200: json(s.PublicationSchema, 'Published'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const body = c.req.valid('json') as { showTranscript?: boolean } | undefined
      return c.json(
        await publishVersion(deps, c.get('principal'), p.id, p.n, { showTranscript: body?.showTranscript }),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/videos/{id}/versions/{n}/publish',
      operationId: 'unpublishVersion',
      'x-sdk': { resource: 'versions', method: 'unpublish' },
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
  // Publish destinations (docs/plans/2026-11-04-publish-destinations.md §6.1).
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/looks',
      operationId: 'listLooks',
      'x-sdk': { resource: 'looks', method: 'list', feature: 'looks' },
      summary: 'List looks',
      description:
        "The visual styles a video can be made in (pass an id as `look` when creating, revising or remixing), each with whether an admin has it on, and the default for creates that omit a look. Every signed-in role can list them; a look's name and description are never private.",
      tags: ['videos'],
      security,
      responses: { 200: json(s.LooksSchema, 'Looks'), ...errors },
    }),
    async (c) => c.json(await listLooks(deps), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/destinations',
      operationId: 'listDestinations',
      'x-sdk': { resource: 'destinations', method: 'list', feature: 'destinations' },
      summary: 'List destinations',
      description:
        'Where a ready version can be published: the share page, YouTube (when set up) and HTTP destinations, each with whether it is ready for you and, if not, why.',
      tags: ['publishing'],
      security,
      responses: { 200: json(z.object({ items: z.array(s.DestinationSchema) }), 'Destinations'), ...errors },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optionsSchema is free-form JSON
    async (c) => c.json({ items: (await listDestinations(deps, c.get('principal'))) as any[] }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/destinations',
      operationId: 'publishToDestination',
      'x-sdk': { resource: 'destinations', method: 'publish', feature: 'destinations' },
      summary: 'Publish a version to a destination',
      description:
        "Publishes a ready version to a destination. The share page publishes at once; others publish in the background: watch the version's destinations list.",
      tags: ['publishing'],
      security,
      request: {
        params: VersionParam,
        headers: IdempotencyHeader,
        body: { content: { 'application/json': { schema: s.PublishToDestinationSchema } }, required: true },
      },
      responses: { 200: json(s.DestinationPublicationSchema, 'Publishing'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const dto = await publishToDestination(
        deps,
        c.get('principal'),
        p.id,
        p.n,
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'],
      )
      return c.json(dto, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/destination-publications/{id}',
      operationId: 'unpublishFromDestination',
      'x-sdk': { resource: 'destinations', method: 'unpublish', feature: 'destinations' },
      summary: 'Remove a version from a destination',
      description: 'Removes a destination publication, from any state. Removal runs in the background.',
      tags: ['publishing'],
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({ options: z.record(z.string(), z.unknown()).optional() }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(s.DestinationPublicationSchema, 'Removing'), ...errors },
    }),
    async (c) => {
      const body = (c.req.valid('json') as { options?: Record<string, unknown> } | undefined) ?? {}
      return c.json(
        await unpublishFromDestination(deps, c.get('principal'), c.req.valid('param').id, body.options),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/destination-publications/{id}/retry',
      operationId: 'retryDestinationPublication',
      'x-sdk': { resource: 'destinations', method: 'retry', feature: 'destinations' },
      summary: 'Try a failed destination publication again',
      description:
        'Starts a new attempt on the same publication, so the destination can find what an earlier one made.',
      tags: ['publishing'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.DestinationPublicationSchema, 'Trying again'), ...errors },
    }),
    async (c) =>
      c.json(await retryDestinationPublication(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/destinations/{id}/targets',
      operationId: 'listDestinationTargets',
      'x-sdk': { resource: 'destinations', method: 'targets', feature: 'destinations' },
      summary: "A destination's targets for a video",
      description:
        'Things the destination already holds for you (its own sites, playlists or pages), to add the video to instead of making something new. Empty when it has none or did not answer in time.',
      tags: ['publishing'],
      security,
      request: { params: IdParam, query: z.object({ videoId: z.string() }) },
      responses: {
        200: json(
          z.object({
            targets: z.array(s.TargetSchema),
            dropped: z.number().int(),
            noun: z.string().nullable(),
            error: z.string().nullable(),
          }),
          'Targets',
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await listDestinationTargets(
          deps,
          c.get('principal'),
          c.req.valid('param').id,
          c.req.valid('query').videoId,
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/destination-publications/{id}/secret',
      operationId: 'revealDestinationSecret',
      'x-sdk': { resource: 'destinations', method: 'revealSecret', feature: 'destinations' },
      summary: 'Reveal a one-time secret',
      description:
        'Returns a secret the destination handed back (such as a site password), once, to the publisher only.',
      tags: ['publishing'],
      security,
      request: { params: IdParam },
      responses: { 200: json(z.object({ label: z.string(), value: z.string() }), 'The secret'), ...errors },
    }),
    async (c) => {
      c.header('cache-control', 'no-store')
      return c.json(await revealDestinationSecret(deps, c.get('principal'), c.req.valid('param').id), 200)
    },
  )
  const AdminDestinationSchema = z
    .object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      enabled: z.boolean(),
      optionsSchema: z.unknown().nullable(),
      capabilities: z.record(z.string(), z.unknown()),
      sharePublisherContact: z.boolean(),
      revision: z.number().int(),
      createdAt: z.string(),
      updatedAt: z.string(),
      live: z.number().int(),
      failed: z.number().int(),
    })
    .openapi('AdminDestination')
  const DestinationInputSchema = z
    .object({
      name: z.string().max(60).optional(),
      url: z.string().max(2000).optional(),
      enabled: z.boolean().optional(),
      optionsSchema: z.unknown().optional(),
      sharePublisherContact: z.boolean().optional(),
    })
    .openapi('DestinationInput')
  const WithSecret = AdminDestinationSchema.extend({ secret: z.string() }).openapi(
    'AdminDestinationWithSecret',
  )
  const adminDest = (
    path: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    operationId: string,
    summary: string,
  ) => ({ method, path, operationId, 'x-sdk': false as const, summary, tags: ['admin'], security })
  app.openapi(
    createRoute({
      ...adminDest('/api/v1/admin/destinations', 'get', 'listAdminDestinations', 'List HTTP destinations'),
      responses: {
        200: json(z.object({ items: z.array(AdminDestinationSchema) }), 'Destinations'),
        ...errors,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optionsSchema is free-form JSON
    async (c) => c.json({ items: (await listAdminDestinations(deps, c.get('principal'))) as any[] }, 200),
  )
  app.openapi(
    createRoute({
      ...adminDest('/api/v1/admin/destinations', 'post', 'createDestination', 'Add an HTTP destination'),
      description: 'Adds an HTTP destination. Its signing secret is in this response only.',
      request: {
        body: { content: { 'application/json': { schema: DestinationInputSchema } }, required: true },
      },
      responses: { 201: json(WithSecret, 'Added'), ...errors },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optionsSchema is free-form JSON
    async (c) => c.json((await createDestination(deps, c.get('principal'), c.req.valid('json'))) as any, 201),
  )
  app.openapi(
    createRoute({
      ...adminDest(
        '/api/v1/admin/destinations/{id}',
        'patch',
        'updateDestination',
        'Change an HTTP destination',
      ),
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: DestinationInputSchema } }, required: true },
      },
      responses: { 200: json(AdminDestinationSchema, 'Changed'), ...errors },
    }),
    async (c) =>
      c.json(
        (await updateDestination(
          deps,
          c.get('principal'),
          c.req.valid('param').id,
          c.req.valid('json'),
        )) as never,
        200,
      ),
  )
  app.openapi(
    createRoute({
      ...adminDest(
        '/api/v1/admin/destinations/{id}',
        'delete',
        'deleteDestination',
        'Delete an HTTP destination',
      ),
      description: 'Refused while it still has publications (Remove from everywhere first).',
      request: { params: IdParam },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await deleteDestination(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      ...adminDest(
        '/api/v1/admin/destinations/{id}/rotate',
        'post',
        'rotateDestinationSecret',
        'Rotate the signing secret',
      ),
      request: { params: IdParam },
      responses: { 200: json(WithSecret, 'Rotated'), ...errors },
    }),
    async (c) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optionsSchema is free-form JSON
      c.json((await rotateDestinationSecret(deps, c.get('principal'), c.req.valid('param').id)) as any, 200),
  )
  app.openapi(
    createRoute({
      ...adminDest('/api/v1/admin/destinations/{id}/test', 'post', 'testDestination', 'Send a test ping'),
      description: 'Sends a signed ping; stores the capabilities the receiver reports.',
      request: { params: IdParam },
      responses: {
        200: json(
          z.object({
            ok: z.boolean(),
            status: z.number().int(),
            capabilities: z.record(z.string(), z.unknown()).nullable(),
            error: z.string().nullable(),
          }),
          'Tested',
        ),
        ...errors,
      },
    }),

    async (c) =>
      c.json((await testDestination(deps, c.get('principal'), c.req.valid('param').id)) as never, 200),
  )
  app.openapi(
    createRoute({
      ...adminDest(
        '/api/v1/admin/destinations/{id}/remove-all',
        'post',
        'removeDestinationEverywhere',
        'Remove from everywhere',
      ),
      description: "Removes every one of this destination's publications.",
      request: { params: IdParam },
      responses: { 200: json(z.object({ removing: z.number().int() }), 'Removing'), ...errors },
    }),
    async (c) =>
      c.json(await removeDestinationEverywhere(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me/connections',
      operationId: 'listConnections',
      'x-sdk': { resource: 'connections', method: 'list', feature: 'youtube' },
      summary: 'Your connected accounts',
      description:
        'Accounts you connected for publishing (your YouTube channel), and whether YouTube is set up here.',
      tags: ['publishing'],
      security,
      responses: {
        200: json(
          z.object({
            youtube: z.object({ configured: z.boolean(), available: z.boolean(), connectUrl: z.string() }),
            items: z.array(
              z.object({
                id: z.string(),
                kind: z.literal('youtube'),
                account: z.string(),
                accountId: z.string(),
                status: z.enum(['ok', 'reconnect']),
                connectedAt: z.string(),
              }),
            ),
          }),
          'Connections',
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await listConnections(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/me/connections/{id}',
      operationId: 'deleteConnection',
      'x-sdk': { resource: 'connections', method: 'delete', feature: 'youtube' },
      summary: 'Disconnect an account',
      description: 'Revokes the grant and forgets it. What was already published stays where it is.',
      tags: ['publishing'],
      security,
      request: { params: IdParam },
      responses: { 204: { description: 'Disconnected' }, ...errors },
    }),
    async (c) => {
      await deleteConnection(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  // Receiver callbacks (publish destinations §3.3, §3.5): no session or API key; a per-operation Bearer token.
  const bearer = (c: Context) => /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null
  const smallBody = async (c: Context) => {
    const text = await c.req.raw.clone().text()
    if (text.length > 16 * 1024) throw new ApiError('invalid_request', 'Body too large.')
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ApiError('invalid_request', 'Body must be JSON.')
    }
  }
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/destination-callbacks/{id}',
      operationId: 'receiveDestinationCallback',
      'x-sdk': false,
      summary: 'Receiver callback',
      description:
        "An HTTP destination reports how a publish or removal it answered 202 to ended. Authorization: Bearer <the request's callback token>.",
      tags: ['publishing'],
      request: { params: IdParam },
      responses: { 204: { description: 'Applied (or a duplicate)' }, ...errors, 410: err('Removed') },
    }),
    async (c) => {
      await receiveDestinationCallback(deps, c.req.valid('param').id, bearer(c), await smallBody(c))
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/destination-callbacks/{id}/files',
      operationId: 'refreshDestinationFiles',
      'x-sdk': false,
      summary: 'Fresh file links',
      description:
        "New signed links to a publication's files, for a receiver that needs more time to copy them.",
      tags: ['publishing'],
      request: { params: IdParam },
      responses: {
        200: json(z.object({ files: z.array(z.record(z.string(), z.unknown())) }), 'Links'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(await destinationFiles(deps, c.req.valid('param').id, bearer(c), await smallBody(c)), 200),
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/videos/{id}/versions/{n}/verdict',
      operationId: 'setVerdict',
      'x-sdk': { resource: 'versions', method: 'setVerdict' },
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
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/versions/{n}/captions',
      operationId: 'correctCaptions',
      'x-sdk': { resource: 'versions', method: 'captions' },
      summary: 'Correct the captions',
      description:
        "Corrects recorded narration's caption text without a render: every cue, in order, with its id and timing unchanged. The captions and transcript get new revision files; the share page follows. Owner or admin. 409 when expectedRev isn't the current revision or the captions are burned in.",
      tags: ['versions'],
      security,
      request: {
        params: VersionParam,
        body: { content: { 'application/json': { schema: s.ReviseCaptionsSchema } }, required: true },
      },
      responses: { 200: json(s.VersionCaptionsSchema, 'Corrected'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const r = await reviseCaptions(deps, c.get('principal'), p.id, p.n, c.req.valid('json'))
      return c.json({ status: r.status, policy: r.policy, rev: r.rev }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/videos/{id}/versions/{n}/poster',
      operationId: 'setPoster',
      'x-sdk': { resource: 'versions', method: 'setPoster' },
      summary: 'Set the poster',
      description:
        "Sets a ready version's poster to a frame or an uploaded image, without a render. Send a JPEG with the video's shape, and WebPs 480 and 960 px wide when you can. The share page follows. Owner or admin.",
      tags: ['versions'],
      security,
      request: {
        params: VersionParam,
        body: { content: { 'application/json': { schema: s.SetPosterSchema } }, required: true },
      },
      responses: { 200: json(s.VersionPosterSchema, 'Set'), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      const r = await setPoster(deps, c.get('principal'), p.id, p.n, c.req.valid('json'))
      return c.json({ source: r.custom?.source ?? 'frame', at: r.custom?.at ?? null }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/videos/{id}/versions/{n}/poster',
      operationId: 'resetPoster',
      'x-sdk': { resource: 'versions', method: 'resetPoster' },
      summary: 'Reset the poster',
      description: "Goes back to the render's own poster. Owner or admin.",
      tags: ['versions'],
      security,
      request: { params: VersionParam },
      responses: { 204: { description: 'Reset' }, ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param')
      await resetPoster(deps, c.get('principal'), p.id, p.n)
      return c.body(null, 204)
    },
  )
  // Before the {file} route, which would otherwise take 'preview' as a file name.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/versions/{n}/preview',
      operationId: 'getVersionPreview',
      'x-sdk': { resource: 'versions', method: 'preview' },
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
      operationId: 'getVersionFile',
      'x-sdk': false,
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
      const version = await deps.store.getVersion(id, n)
      if (!out || !version) throw new ApiError('not_ready', 'This version has no files yet.')
      // narration-audio and transcript: narrated versions only; captions and transcript follow the caption revision.
      const name = versionFileName(version, out, file)
      if (!name) throw new ApiError('not_found', 'This version has no such file.')
      c.header('cache-control', 'private, no-store')
      return c.redirect(
        await signedFilePath(deps, job, n, file, {
          download: c.req.valid('query').download === '1',
          stable: true,
          name,
        }),
        302,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/videos/{id}/versions/{n}/previews/{name}',
      operationId: 'addPreviewVariant',
      'x-sdk': false,
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
      operationId: 'listKeys',
      'x-sdk': { resource: 'keys', method: 'list' },
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
      operationId: 'createKey',
      'x-sdk': false,
      summary: 'Create an API key',
      description: 'Creates an API key. Its secret is shown once.',
      tags: ['keys'],
      security,
      request: { body: { content: { 'application/json': { schema: s.CreateKeySchema } }, required: true } },
      responses: { 201: json(s.NewKeySchema, 'Created'), ...errors },
    }),
    async (c) => c.json(await createKey(deps, c.get('principal'), c.req.valid('json').name), 201),
  )
  const cliErrors = { 404: err('Not found'), 409: err('Browser login is off'), 429: err('Too many') }
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/cli/logins',
      operationId: 'createCliLogin',
      'x-sdk': { resource: 'cliLogins', method: 'create' },
      summary: 'Start a CLI login',
      description:
        'Starts video-agent login. No credentials: returns a device code for the CLI and a user code the person types on the approve page.',
      tags: ['cli'],
      request: {
        body: { content: { 'application/json': { schema: s.CreateCliLoginSchema } }, required: true },
      },
      responses: { 201: json(s.CliLoginSchema, 'Started'), 400: err('Invalid request'), ...cliErrors },
    }),
    async (c) => c.json(await createLogin(deps, { ...c.req.valid('json'), clientIp: clientIp(c) }), 201),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/cli/logins/{id}/token',
      operationId: 'claimCliLogin',
      'x-sdk': { resource: 'cliLogins', method: 'claim' },
      summary: 'Claim a CLI login',
      description:
        "The CLI's poll. Pending until the person approves; then claimed once, with a new API key. Poll no faster than intervalSec.",
      tags: ['cli'],
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: s.ClaimCliLoginSchema } }, required: true },
      },
      responses: { 200: json(s.CliLoginClaimSchema, 'Status'), 400: err('Invalid request'), ...cliErrors },
    }),
    async (c) => c.json(await claimLogin(deps, c.req.valid('param').id, c.req.valid('json').deviceCode), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/cli/logins/lookup',
      operationId: 'lookupCliLogin',
      'x-sdk': false,
      summary: 'Look up a CLI login by its code',
      description:
        'For the approve page: the login waiting for the code you typed. Signed-in browser sessions only.',
      tags: ['cli'],
      security,
      request: {
        body: { content: { 'application/json': { schema: s.LookupCliLoginSchema } }, required: true },
      },
      responses: { 200: json(s.CliLoginRequestSchema, 'Login'), ...errors, ...cliErrors },
    }),
    async (c) => c.json(await lookupLogin(deps, c.get('principal'), c.req.valid('json').userCode), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/cli/logins/approve',
      operationId: 'decideCliLogin',
      'x-sdk': false,
      summary: 'Approve or deny a CLI login',
      description:
        'Approves or denies the login waiting for the code you typed. Signed-in browser sessions only.',
      tags: ['cli'],
      security,
      request: {
        body: { content: { 'application/json': { schema: s.DecideCliLoginSchema } }, required: true },
      },
      responses: { 200: json(s.CliLoginDecisionSchema, 'Decided'), ...errors, ...cliErrors },
    }),
    async (c) => {
      const { userCode, decision } = c.req.valid('json')
      return c.json(await decideLogin(deps, c.get('principal'), userCode, decision), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/keys/{id}',
      operationId: 'revokeKey',
      'x-sdk': { resource: 'keys', method: 'revoke' },
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
      operationId: 'listGrants',
      'x-sdk': { resource: 'grants', method: 'list' },
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
      operationId: 'revokeGrant',
      'x-sdk': { resource: 'grants', method: 'revoke' },
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
      path: '/api/v1/engines',
      operationId: 'listEngines',
      'x-sdk': { resource: 'engines', method: 'list', feature: 'engines' },
      summary: 'List render engines',
      description:
        'The engines a video can be made with here: HyperFrames always, and Remotion when this deployment offers it (bring your own license), with its license notice.',
      tags: ['videos'],
      security,
      responses: { 200: json(z.object({ items: z.array(s.EngineSchema) }), 'Engines'), ...errors },
    }),
    async (c) => c.json({ items: await listEngines(deps) }, 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me',
      operationId: 'getMe',
      'x-sdk': { resource: 'me', method: 'get' },
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
      operationId: 'listUsers',
      'x-sdk': false,
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
      operationId: 'updateUser',
      'x-sdk': false,
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
      operationId: 'getWebhook',
      'x-sdk': { resource: 'webhooks', method: 'get' },
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
      operationId: 'setWebhook',
      'x-sdk': { resource: 'webhooks', method: 'set' },
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
      operationId: 'deleteWebhook',
      'x-sdk': { resource: 'webhooks', method: 'delete' },
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
      operationId: 'testWebhook',
      'x-sdk': { resource: 'webhooks', method: 'test' },
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
      operationId: 'getTeamWebhook',
      'x-sdk': false,
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
      operationId: 'setTeamWebhook',
      'x-sdk': false,
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
      operationId: 'deleteTeamWebhook',
      'x-sdk': false,
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
      operationId: 'testTeamWebhook',
      'x-sdk': false,
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
      method: 'get',
      path: '/api/v1/admin/settings',
      operationId: 'getSettings',
      'x-sdk': false,
      summary: 'Get settings',
      description: 'Settings an admin can change without a redeploy: recorded voice-over. Admins only.',
      tags: ['admin'],
      security,
      responses: { 200: json(s.AdminSettingsSchema, 'Settings'), ...errors },
    }),
    async (c) => c.json(await getAdminSettings(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/admin/settings',
      operationId: 'updateSettings',
      'x-sdk': false,
      summary: 'Update settings',
      description:
        'Changes the settings given; leave a field out to keep it. Takes effect at once. Admins only.',
      tags: ['admin'],
      security,
      request: {
        body: { content: { 'application/json': { schema: s.UpdateAdminSettingsSchema } }, required: true },
      },
      responses: { 200: json(s.AdminSettingsSchema, 'Updated'), ...errors },
    }),
    async (c) => c.json(await updateAdminSettings(deps, c.get('principal'), c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/plans',
      operationId: 'createPlan',
      'x-sdk': { resource: 'plans', method: 'create', feature: 'planning' },
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
      operationId: 'getPlan',
      'x-sdk': { resource: 'plans', method: 'get', feature: 'planning' },
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
      operationId: 'askPlanQuestions',
      'x-sdk': { resource: 'plans', method: 'questions', feature: 'planning' },
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
      operationId: 'writePlanBrief',
      'x-sdk': { resource: 'plans', method: 'brief', feature: 'planning' },
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
      operationId: 'updatePlan',
      'x-sdk': { resource: 'plans', method: 'update', feature: 'planning' },
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
      operationId: 'getUsage',
      'x-sdk': { resource: 'me', method: 'usage' },
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
      operationId: 'listNotifications',
      'x-sdk': { resource: 'notifications', method: 'list' },
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
      operationId: 'markNotificationsRead',
      'x-sdk': { resource: 'notifications', method: 'markRead' },
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
      operationId: 'getVideoProgress',
      'x-sdk': { resource: 'videos', method: 'progress' },
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
      operationId: 'createEdit',
      'x-sdk': false,
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
      operationId: 'getEdit',
      'x-sdk': false,
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
      operationId: 'saveEdit',
      'x-sdk': false,
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
      operationId: 'discardEdit',
      'x-sdk': false,
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
      operationId: 'renderEdit',
      'x-sdk': false,
      summary: 'Render a draft',
      description:
        'Renders your draft as the next version, unchanged: the run checks and renders and never redesigns. Recorded narration is mixed over the kept visuals.',
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        headers: IdempotencyHeader,
        body: { content: { 'application/json': { schema: s.RenderEditSchema } }, required: false },
      },
      responses: { 202: json(s.VideoSchema, 'Queued'), ...errors, 503: err('Setup required') },
    }),
    async (c) => {
      // The body is optional (older clients send none): checked here, since the validator skips a missing one.
      const body = s.RenderEditSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) throw new ApiError('invalid_request', 'That render request is not valid.')
      const res = await renderEdit(
        deps,
        c.get('principal'),
        c.req.valid('param').id,
        c.req.valid('header')['idempotency-key'],
        body.data,
      )
      return queued(c, res)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/edits/{id}/rebase-narration',
      operationId: 'rebaseEditNarration',
      'x-sdk': false,
      summary: "Rebase a draft's narration",
      description:
        "Moves your draft's narration onto your draft of version toN (opened, or created), saved and checked like any save: the narration lock, the recordings you may use and the limits against that version. Your other draft is kept.",
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        body: { content: { 'application/json': { schema: s.RebaseNarrationSchema } }, required: true },
      },
      responses: {
        200: json(s.EditSchema, 'Your draft of toN, updated'),
        201: json(s.EditSchema, 'A new draft of toN'),
        ...errors,
      },
    }),
    async (c) => {
      const r = await rebaseNarration(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json'))
      return c.json(r.edit, r.created ? 201 : 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/edits/{id}/preview',
      operationId: 'getEditPreview',
      'x-sdk': false,
      summary: 'Get a draft preview link',
      description: "A short-lived link to play the draft's current rev in the sandboxed preview.",
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 200: json(s.PreviewLinkSchema, 'Preview link'), ...errors },
    }),
    async (c) => c.json(await editPreviewLink(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  // ───── narration soft lock (plan 2026-11-02 §2.7) ─────
  const lockPath = '/api/v1/videos/{id}/narration-lock'
  const lockErrors = {
    ...errors,
    409: err('Someone else is editing the narration (narration_locked; details: holder, takenOverBy, at)'),
  }
  app.openapi(
    createRoute({
      method: 'get',
      path: lockPath,
      operationId: 'getNarrationLock',
      'x-sdk': false,
      summary: 'Get the narration lock',
      description: "Who is editing this video's narration, if anyone.",
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 200: json(s.NarrationLockSchema, 'The lock'), ...errors },
    }),
    async (c) => c.json(await getNarrationLock(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: lockPath,
      operationId: 'takeNarrationLock',
      'x-sdk': false,
      summary: 'Acquire the narration lock',
      description:
        "Takes the video's narration lock for your draft, or heartbeats it (every 30 s; it lapses after 2 min without one). Only the holder saves narration ops.",
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        body: { content: { 'application/json': { schema: s.AcquireNarrationLockSchema } }, required: true },
      },
      responses: { 200: json(s.NarrationLockSchema, 'Held'), ...lockErrors },
    }),
    async (c) =>
      c.json(
        await acquireNarrationLock(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: lockPath,
      operationId: 'releaseNarrationLock',
      'x-sdk': false,
      summary: 'Release the narration lock',
      description: "Releases your narration lock; someone else's is left alone.",
      tags: ['editor'],
      security,
      request: { params: EditParam },
      responses: { 204: { description: 'Released' }, ...errors },
    }),
    async (c) => {
      await releaseNarrationLock(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: `${lockPath}/take-over`,
      operationId: 'takeOverNarrationLock',
      'x-sdk': false,
      summary: 'Take over the narration lock',
      description:
        'Moves the narration lock to you, whoever holds it. Their draft is kept; their next heartbeat or narration save is refused and says you took over.',
      tags: ['editor'],
      security,
      request: {
        params: EditParam,
        body: {
          content: { 'application/json': { schema: s.AcquireNarrationLockSchema.pick({ draftId: true }) } },
          required: true,
        },
      },
      responses: { 200: json(s.NarrationTakeOverSchema, 'Yours now'), ...errors },
    }),
    async (c) =>
      c.json(
        await takeOverNarrationLock(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  // ───── media library (plan v2 §9) ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media',
      operationId: 'uploadMedia',
      'x-sdk': false,
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
      // Recordings are held to their own budgets and scope, which only upload sessions check.
      if (c.req.query('role') !== undefined || c.req.query('scopeJobId') !== undefined)
        throw new ApiError(
          'invalid_request',
          'Recordings upload in a session: POST /api/v1/media/uploads with role and scopeJobId.',
        )
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const q = c.req.valid('query')
      return c.json(await uploadMedia(deps, c.get('principal'), bytes, q), 201)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media',
      operationId: 'listMedia',
      'x-sdk': { resource: 'media', method: 'list' },
      summary: 'List media',
      description: "The team's media library, newest first, plus your own uploads still being checked.",
      tags: ['media'],
      security,
      request: {
        query: z.object({
          kind: z.enum(MEDIA_KINDS).optional(),
          q: z.string().max(200).optional().openapi({
            description: 'Words to find in the title, file name, notes, source title or creator',
          }),
          sort: z.enum(['newest', 'oldest', 'name']).optional().openapi({ description: 'Default newest' }),
          recordings: z.enum(['include', 'only', 'exclude']).optional().openapi({
            description:
              'Your voice-over recordings: listed with the rest (include, the default), only, or left out',
          }),
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
      operationId: 'checkMedia',
      'x-sdk': { resource: 'media', method: 'check' },
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
      method: 'get',
      path: '/api/v1/videos/{id}/recordings',
      operationId: 'listRecordings',
      'x-sdk': { resource: 'media', method: 'recordings' },
      summary: "List a video's recordings",
      description:
        "The voice-over recordings made for this video or used on it that you can read: your own, and the ones its versions (or their uploader's drafts) use. Newest first, with where each is used and how long it's kept, so a recording whose draft expired can be placed again.",
      tags: ['media'],
      security,
      request: { params: IdParam },
      responses: { 200: json(s.RecordingListSchema, 'Recordings'), ...errors },
    }),
    async (c) => c.json(await listVideoRecordings(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/recordings/delete-unused',
      operationId: 'deleteUnusedRecordings',
      'x-sdk': { resource: 'media', method: 'deleteUnusedRecordings' },
      summary: 'Delete unused recordings',
      description:
        "Deletes your voice-over recordings that no draft or version uses, at once (they're otherwise kept 30 days after their last use). Recordings in use are kept.",
      tags: ['media'],
      security,
      responses: { 200: json(s.DeletedRecordingsSchema, 'Deleted'), ...errors },
    }),
    async (c) => c.json(await deleteUnusedRecordings(deps, c.get('principal')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/media/uploads',
      operationId: 'createUpload',
      'x-sdk': { resource: 'uploads', method: 'create' },
      summary: 'Start an upload',
      description:
        "Starts an upload session for a file over 4 MB, or for any voice-over recording. Declare its size and sha256 (a recorder may send the hash it computed while recording; the server checks every part and the whole file); quota is reserved. A voice-over recording names its role and the video it's for (scopeJobId), which you must be able to see. A screen recording (role screen-recording, needs the screen_recording feature) names no video and is held to its own limits: H.264 MP4, 150 MB, 5 minutes, a constant 24-30 fps, a keyframe at least every 2 s, fast start.",
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
                role: z
                  .enum(MEDIA_ROLES)
                  .optional()
                  .openapi({ description: 'A voice-over recording (take) or uploaded narration' }),
                scopeJobId: z
                  .string()
                  .max(64)
                  .optional()
                  .openapi({ description: 'The video a recording is for (required with role)' }),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        201: json(s.UploadSessionSchema, 'Session'),
        ...errors,
        409: err('Recorded voice-over is turned off (narration_disabled)'),
        413: err('Recordings storage full (details: quotaBytes, usedBytes, remainingBytes)'),
        429: err('Too many uploads in progress, or too many recordings this hour'),
      },
    }),
    async (c) => c.json(await createUpload(deps, c.get('principal'), c.req.valid('json')), 201),
  )
  const UploadParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/uploads/{id}',
      operationId: 'getUpload',
      'x-sdk': { resource: 'uploads', method: 'get' },
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
      operationId: 'uploadPart',
      'x-sdk': false,
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
      operationId: 'completeUpload',
      'x-sdk': { resource: 'uploads', method: 'complete' },
      summary: 'Finish an upload',
      description:
        "The file is assembled and checked in the background; poll the session or the item. A recording's whole-file sha256 is checked first: a mismatch is a 400 and the session fails.",
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
      responses: {
        202: json(s.UploadSessionSchema, 'Assembling'),
        ...errors,
        413: err('Recordings storage full (details: quotaBytes, usedBytes, remainingBytes)'),
      },
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
      operationId: 'abortUpload',
      'x-sdk': { resource: 'uploads', method: 'abort' },
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
      operationId: 'searchMusic',
      'x-sdk': { resource: 'music', method: 'search' },
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
      operationId: 'searchLibraryMusic',
      'x-sdk': { resource: 'music', method: 'library' },
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
      operationId: 'listCommonMusic',
      'x-sdk': { resource: 'music', method: 'common' },
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
      operationId: 'importMusic',
      'x-sdk': { resource: 'music', method: 'import' },
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
      operationId: 'getMusicJob',
      'x-sdk': { resource: 'music', method: 'job' },
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
      operationId: 'getMedia',
      'x-sdk': { resource: 'media', method: 'get' },
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
      operationId: 'updateMedia',
      'x-sdk': { resource: 'media', method: 'update' },
      summary: 'Rename or annotate an item',
      description:
        'Changes the title (the name shown in the library) or the caption (notes the planner and agent read). Uploader or admin. Leave a field out to keep it; null clears it.',
      tags: ['media'],
      security,
      request: {
        params: MediaParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                title: z.string().max(120).nullable().optional(),
                caption: z.string().max(500).nullable().optional(),
              }),
            },
          },
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
      operationId: 'deleteMedia',
      'x-sdk': { resource: 'media', method: 'delete' },
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
  // A screen recording's pointer trace (screen-recording plan §4.7): set or replaced by its uploader until a version
  // uses the recording, then frozen; read back (normalized) by its uploader and admins only.
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/media/{id}/trace',
      operationId: 'setMediaTrace',
      'x-sdk': { resource: 'media', method: 'setTrace', feature: 'screen_recording' },
      summary: "Set a screen recording's pointer trace",
      description: `Stores the pointer trace (the cursor and click log, schema v1, at most ${TRACE_MAX_BYTES / 1024 / 1024} MB) for a ready screen recording: its uploader or an admin. Text from the recorded page is scrubbed. Sending again replaces it until a video uses the recording, then 409 trace_frozen. Shares the 10-an-hour budget with recording uploads.`,
      tags: ['media'],
      security,
      // Before the body is read: a trace over the cap is refused on its declared length.
      middleware: [
        async (c: Context<Env>, next: Next) => {
          if (Number(c.req.header('content-length') ?? 0) > TRACE_MAX_BYTES)
            throw new ApiError(
              'quota_exceeded',
              `A pointer trace must be ${TRACE_MAX_BYTES / 1024 / 1024} MB or smaller.`,
            )
          await next()
        },
      ] as const,
      request: {
        params: MediaParam,
        body: { content: { 'application/json': { schema: s.TraceBodySchema } }, required: true },
      },
      responses: { 200: json(s.MediaSchema, 'The recording, with its trace'), ...errors },
    }),
    async (c) =>
      c.json(
        await setMediaTrace(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/{id}/trace',
      operationId: 'getMediaTrace',
      'x-sdk': { resource: 'media', method: 'getTrace', feature: 'screen_recording' },
      summary: "Get a screen recording's pointer trace",
      description: "The stored (normalized) pointer trace, for the recording's uploader and admins only.",
      tags: ['media'],
      security,
      request: { params: MediaParam },
      responses: { 200: json(s.TraceBodySchema, 'The trace'), ...errors },
    }),
    async (c) => {
      const trace = await getMediaTrace(deps, c.get('principal'), c.req.valid('param').id)
      // The stored trace passed the domain's full schema; the API schema only declares its top level.
      return c.json(trace as unknown as z.infer<typeof s.TraceBodySchema>, 200)
    },
  )
  // A recording's waveform peaks and speech spans (voice-over plan §5.1, §6.1): the uploader sends them; readers of
  // the take get them.
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/media/{id}/peaks',
      operationId: 'setMediaPeaks',
      'x-sdk': false,
      summary: "Store a recording's peaks",
      description: `Stores a recording's waveform peaks (peaks.bin, the VAPK format, at most ${PEAKS_MAX_BYTES / 1024} KB) as the request body. Only the uploader, before or after the recording is ready; sending again replaces them.`,
      tags: ['media'],
      security,
      request: {
        params: MediaParam,
        body: {
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
          required: true,
        },
      },
      responses: { 200: json(s.TakePeaksStoredSchema, 'Stored'), ...errors },
    }),
    async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > PEAKS_MAX_BYTES + 1024)
        throw new ApiError('invalid_request', `Peaks must be ${PEAKS_MAX_BYTES / 1024} KB or smaller.`)
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(await putTakePeaks(deps, c.get('principal'), c.req.valid('param').id, bytes), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/{id}/peaks',
      operationId: 'getMediaPeaks',
      'x-sdk': false,
      summary: "Get a recording's peaks",
      description: "A recording's waveform peaks (peaks.bin), for anyone who can read the recording.",
      tags: ['media'],
      security,
      request: { params: MediaParam },
      responses: {
        200: {
          description: 'peaks.bin',
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const bytes = await getTakePeaks(deps, c.get('principal'), c.req.valid('param').id)
      return c.body(new Uint8Array(bytes), 200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      })
    },
  )
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/media/{id}/speech',
      operationId: 'setMediaSpeech',
      'x-sdk': false,
      summary: "Store a recording's speech spans",
      description:
        'Stores where the voice is in a recording, as [start, end) spans in source samples. Only the uploader, before or after the recording is ready; sending again replaces them.',
      tags: ['media'],
      security,
      request: {
        params: MediaParam,
        body: { content: { 'application/json': { schema: s.SpeechSummarySchema } }, required: true },
      },
      responses: { 200: json(s.SpeechSummarySchema, 'Stored'), ...errors },
    }),
    async (c) =>
      c.json(
        await putTakeSpeech(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/media/{id}/speech',
      operationId: 'getMediaSpeech',
      'x-sdk': false,
      summary: "Get a recording's speech spans",
      description: 'Where the voice is in a recording, for anyone who can read the recording.',
      tags: ['media'],
      security,
      request: { params: MediaParam },
      responses: { 200: json(s.SpeechSummarySchema, 'Speech spans'), ...errors },
    }),
    async (c) => c.json(await getTakeSpeech(deps, c.get('principal'), c.req.valid('param').id), 200),
  )
  const CommentParam = z.object({ id: z.string() })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/videos/{id}/comments',
      operationId: 'listComments',
      'x-sdk': { resource: 'comments', method: 'list' },
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
      operationId: 'addComment',
      'x-sdk': { resource: 'comments', method: 'add' },
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
      path: '/api/v1/videos/{id}/comments/batch',
      operationId: 'addComments',
      'x-sdk': { resource: 'comments', method: 'addBatch' },
      summary: 'Post several notes as one block',
      description:
        'Posts notes from one pass through the video (each optionally at a moment and a spot) as one review block: one comment per note, sharing a groupId. The owner gets one notification.',
      tags: ['comments'],
      security,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: s.CreateCommentsSchema } }, required: true },
      },
      responses: { 201: json(z.object({ items: z.array(s.CommentSchema) }), 'Created'), ...errors },
    }),
    async (c) =>
      c.json(await addComments(deps, c.get('principal'), c.req.valid('param').id, c.req.valid('json')), 201),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/videos/{id}/comments/read',
      operationId: 'markCommentsRead',
      'x-sdk': { resource: 'comments', method: 'markRead' },
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
      operationId: 'updateComment',
      'x-sdk': { resource: 'comments', method: 'update' },
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
      operationId: 'deleteComment',
      'x-sdk': { resource: 'comments', method: 'delete' },
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
      operationId: 'transferVideos',
      'x-sdk': false,
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
      operationId: 'getStats',
      'x-sdk': false,
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
      operationId: 'resolveAttempt',
      'x-sdk': false,
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
      operationId: 'resumeQueue',
      'x-sdk': false,
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
  // Connecting a YouTube channel (publish destinations §4), when the Google OAuth env is set.
  if (deps.config.google) app.route('/', googleRoutes(deps))

  // ───── agent callback (hidden from the public spec) ─────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/internal/runs/{id}/done',
      operationId: 'reportRunDone',
      'x-sdk': false,
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
      operationId: 'reportRunCheckpoint',
      'x-sdk': false,
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
        tag(
          'cli',
          'CLI login',
          'video-agent login: the CLI starts a login, you approve it in the browser, it gets a key.',
        ),
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
