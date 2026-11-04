// Openverse searches and imports that survive a slow Openverse. Its audio search often takes 20 to 60 seconds, longer
// than an API request may run, so a request tries for a few seconds itself and then hands the work to a job that
// openverse-background runs with minutes to spare. Every finished search is stored for every instance (openverse.ts):
// fresh for a day, then served stale at once while a background job refreshes it, for up to two weeks. A daily warm-up
// refreshes common and popular searches. Identical requests from one person share a job; each person starts a limited
// number per minute; the sweep reaps old jobs and searches.
import type { Deps } from '../deps.js'
import { ApiError, type ErrorCode } from '../lib/errors.js'
import { mediaDto } from './media.js'
import {
  cachedSearch,
  fetchSearchAt,
  importedTrack,
  importOpenverse,
  isStale,
  openverseTiming,
  OpenverseUnavailable,
  requestFromKey,
  SEARCH_FRESH_MS,
  SEARCH_USABLE_MS,
  searchRequest,
  storedSearch,
  SYNC_CALL,
  trackId,
  withLibrary,
  type CallOpts,
  type FetchedPage,
  type SearchPage,
  type SearchQuery,
  type SearchRequest,
} from './openverse.js'
import { assertCan, userPrincipal, type Principal } from './policy.js'
import type { OpenverseJobKind, OpenverseJobRow } from './types.js'

/** How long a job (and its result) can be read. */
export const JOB_TTL_MS = 30 * 60_000
/** Searches and imports one person can hand to jobs (or answer fresh from Openverse) per minute. */
export const JOBS_PER_MINUTE = 12
/** A background function runs for at most 15 minutes; a job stops itself a minute earlier. */
const JOB_DEADLINE_MS = 14 * 60_000
/** A queued job nobody picked up (a lost dispatch) is dispatched again after this long, until it's this old. */
const REDISPATCH_AFTER_MS = 30_000
const GIVE_UP_QUEUED_MS = 5 * 60_000
/** A running job not finished by now was cut off with its function. */
const RUNNING_STALE_MS = 16 * 60_000
/** Who the server's own refresh and warm-up jobs belong to: no person, so no one's rate limit and one job per search. */
export const SYSTEM_USER_ID = 'system:openverse'
/** A stale search isn't refreshed again this soon after a refresh was queued (one that failed included). */
const REFRESH_AGAIN_MS = 10 * 60_000
/** The most searches the sweep keeps, and the most used searches the warm-up refreshes besides the common ones. */
export const MAX_STORED_SEARCHES = 5_000
const WARM_TOP = 15
/** The warm-up refreshes searches fetched before this, so a daily run also takes yesterday's, a little short of stale. */
const warmCutoff = (deps: Deps) => deps.clock.now().getTime() - (SEARCH_FRESH_MS - 4 * 60 * 60_000)

/** Searches people often start with: offered as quick picks in Find music and kept warm every day. */
export const COMMON_SEARCHES = [
  'upbeat',
  'ambient',
  'corporate',
  'cinematic',
  'acoustic',
  'guitar',
  'piano',
  'lofi',
  'electronic',
  'inspiring',
  'happy',
  'calm',
  'energetic',
  'hip hop',
  'rock',
  'jazz',
  'orchestral',
  'chill',
] as const

type ImportResult = { mediaId: string; created: boolean }
type MediaDto = Awaited<ReturnType<typeof mediaDto>>
export type SearchResult = Awaited<ReturnType<typeof withLibrary>>

export interface OpenverseJobDto {
  id: string
  /** Warm-up jobs are the server's own and never shown. */
  kind: Exclude<OpenverseJobKind, 'warmup'>
  status: OpenverseJobRow['status']
  search: SearchResult | null
  media: MediaDto | null
  created: boolean | null
  error: { code: string; message: string } | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

/** Either the answer now, or the job that will have it. */
export type Started<T> = { done: T; job?: never } | { job: OpenverseJobDto; done?: never }

const iso = (ms: number) => new Date(ms).toISOString()
const day = (ms: number) => iso(ms).slice(0, 10)

/** One short try inside an API request: everything in it must finish within the inline budget. */
const inline = (): CallOpts => ({
  ...SYNC_CALL,
  timeoutMs: openverseTiming.inlineMs,
  downloadMs: openverseTiming.inlineMs,
  deadline: AbortSignal.timeout(openverseTiming.inlineMs),
})

async function assertRate(deps: Deps, p: Principal) {
  const since = iso(deps.clock.now().getTime() - 60_000)
  if ((await deps.store.countOpenverseJobs(p.userId, since)) >= JOBS_PER_MINUTE)
    throw new ApiError('rate_limited', 'Too many music searches in a minute. Wait a moment, then try again.')
}

async function inflight(deps: Deps, p: Principal, kind: OpenverseJobKind, key: string) {
  return deps.store.findOpenverseJob({
    kind,
    key,
    userId: p.userId,
    statuses: ['queued', 'running'],
    since: iso(deps.clock.now().getTime() - JOB_TTL_MS),
  })
}

function newRow(
  deps: Deps,
  p: Pick<Principal, 'userId'>,
  kind: OpenverseJobKind,
  key: string,
  params: Record<string, unknown>,
): OpenverseJobRow {
  const now = deps.clock.now()
  return {
    id: `ovj_${deps.ids.uuid().replaceAll('-', '').slice(0, 24)}`,
    userId: p.userId,
    kind,
    key,
    params,
    status: 'queued',
    result: null,
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: iso(now.getTime() + JOB_TTL_MS),
  }
}

async function dispatch(deps: Deps, id: string) {
  // A lost dispatch isn't fatal: the sweep dispatches queued jobs again.
  await deps.platform.dispatchOpenverseJob(id).catch((e: unknown) => {
    deps.log.warn('openverse.dispatch_failed', { jobId: id, error: e })
  })
}

/** Queues a job, or returns the identical one this person already has queued or running. */
async function enqueue(
  deps: Deps,
  p: Principal,
  kind: OpenverseJobKind,
  key: string,
  params: Record<string, unknown>,
) {
  const row = newRow(deps, p, kind, key, params)
  const stored = await deps.store.insertOpenverseJobIfAbsent(row)
  if (stored.id === row.id) {
    deps.log.info('openverse.job_queued', { jobId: row.id, kind })
    await dispatch(deps, row.id)
  }
  return jobDto(deps, p, stored)
}

/**
 * A job the server starts for itself (a run's music pick, src/domain/music-pick.ts) on the person's behalf: no inline
 * try and no rate limit. A finished identical search from the last few minutes is returned as is, and an identical job
 * already queued or running for this person is shared.
 */
export async function queueOpenverseJob(
  deps: Deps,
  userId: string,
  kind: OpenverseJobKind,
  key: string,
  params: Record<string, unknown>,
): Promise<OpenverseJobRow> {
  const req = kind === 'search' ? requestFromKey(key) : null
  const known = req && (cachedSearch(deps, req) ?? (await storedSearch(deps, req)))
  if (req && known) {
    // A stored search answers at once (refreshed in the background when stale), as a finished job like any other.
    if (isStale(deps, known.fetchedAt)) await queueRefresh(deps, req)
    const row = {
      ...newRow(deps, { userId }, kind, key, params),
      status: 'done' as const,
      result: known.page,
    }
    await deps.store.insertOpenverseJobIfAbsent(row)
    return row
  }
  const row = newRow(deps, { userId }, kind, key, params)
  const stored = await deps.store.insertOpenverseJobIfAbsent(row)
  if (stored.id === row.id) {
    deps.log.info('openverse.job_queued', { jobId: row.id, kind, by: 'server' })
    await dispatch(deps, row.id)
    return (await deps.store.getOpenverseJob(row.id)) ?? stored
  }
  return stored
}

/** The params a search job runs with: the request's own fields, read back from its key. */
const searchParams = (req: SearchRequest) => {
  const p = new URLSearchParams(req.key)
  return { q: p.get('q'), license: p.get('license'), category: p.get('category') ?? 'all', page: req.page }
}

/**
 * Queues the server's own refresh of a stale search, unless one is queued or running already or was queued in the last
 * few minutes (so a down Openverse isn't asked again on every request). Never fails the request that noticed.
 */
export async function queueRefresh(deps: Deps, req: SearchRequest) {
  try {
    const recent = await deps.store.findOpenverseJob({
      kind: 'search',
      key: req.key,
      userId: SYSTEM_USER_ID,
      statuses: ['queued', 'running', 'failed', 'done'],
      since: iso(deps.clock.now().getTime() - REFRESH_AGAIN_MS),
    })
    if (recent) return
    const row = newRow(deps, { userId: SYSTEM_USER_ID }, 'search', req.key, searchParams(req))
    const stored = await deps.store.insertOpenverseJobIfAbsent(row)
    if (stored.id !== row.id) return
    deps.log.info('openverse.refresh_queued', { jobId: row.id })
    await dispatch(deps, row.id)
  } catch (e) {
    deps.log.warn('openverse.refresh_failed', { error: e })
  }
}

/** Counts a person's first-page search, for the warm-up's most used searches. Best effort. */
async function recordUse(deps: Deps, req: SearchRequest) {
  if (req.page !== 1) return
  await deps.store.addOpenverseSearchUse(req.key, day(deps.clock.now().getTime())).catch((e: unknown) => {
    deps.log.warn('openverse.use_failed', { error: e })
  })
}

/** A finished page as the API answers it: the library checked now, and how old the page is. */
const answer = (deps: Deps, r: FetchedPage) =>
  withLibrary(deps, r.page, { fetchedAt: r.fetchedAt, stale: isStale(deps, r.fetchedAt) })

/**
 * A search: from the stored searches when anyone searched the same in the last two weeks (a stale one is answered at
 * once and refreshed in the background), else a short try, else a job.
 */
export async function startOpenverseSearch(
  deps: Deps,
  p: Principal,
  q: SearchQuery,
): Promise<Started<SearchResult>> {
  assertCan(p, 'media:upload')
  const req = searchRequest(q)
  await recordUse(deps, req)
  const known = cachedSearch(deps, req) ?? (await storedSearch(deps, req))
  if (known) {
    if (isStale(deps, known.fetchedAt)) await queueRefresh(deps, req)
    return { done: await answer(deps, known) }
  }
  const running = await inflight(deps, p, 'search', req.key)
  if (running) return { job: await jobDto(deps, p, running) }
  await assertRate(deps, p)
  try {
    return { done: await answer(deps, await fetchSearchAt(deps, req, inline())) }
  } catch (e) {
    if (!(e instanceof OpenverseUnavailable)) throw e
  }
  return { job: await enqueue(deps, p, 'search', req.key, searchParams(req)) }
}

/** An import: the item already imported, else a short try, else a job. */
export async function startOpenverseImport(
  deps: Deps,
  p: Principal,
  input: { id: string; caption?: string | undefined },
): Promise<Started<{ created: boolean; media: MediaDto }>> {
  assertCan(p, 'media:upload')
  const id = trackId(input.id)
  const existing = await importedTrack(deps, id)
  if (existing) return { done: { created: false, media: await mediaDto(deps, p, existing) } }
  const running = await inflight(deps, p, 'import', id)
  if (running) return { job: await jobDto(deps, p, running) }
  await assertRate(deps, p)
  try {
    return { done: await importOpenverse(deps, p, input, inline()) }
  } catch (e) {
    if (!(e instanceof OpenverseUnavailable)) throw e
  }
  return { job: await enqueue(deps, p, 'import', id, { id, caption: input.caption?.trim() || undefined }) }
}

export async function jobDto(deps: Deps, p: Principal, j: OpenverseJobRow): Promise<OpenverseJobDto> {
  const out: OpenverseJobDto = {
    id: j.id,
    kind: j.kind === 'import' ? 'import' : 'search',
    status: j.status,
    search: null,
    media: null,
    created: null,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    expiresAt: j.expiresAt,
  }
  if (j.status !== 'done' || !j.result) return out
  if (j.kind === 'search')
    return {
      ...out,
      search: await withLibrary(deps, j.result as SearchPage, { fetchedAt: j.updatedAt, stale: false }),
    }
  const r = j.result as ImportResult
  const m = await deps.store.getMedia(r.mediaId)
  if (!m || m.deletedAt)
    return {
      ...out,
      status: 'failed',
      error: { code: 'not_found', message: 'The imported track has since been deleted from the library.' },
    }
  return { ...out, media: await mediaDto(deps, p, m), created: r.created }
}

/** One job, for the person who started it. */
export async function getOpenverseJob(deps: Deps, p: Principal, id: string) {
  const j = await deps.store.getOpenverseJob(id)
  if (!j || j.userId !== p.userId || j.expiresAt <= deps.clock.now().toISOString())
    throw new ApiError('not_found', 'Job not found. Jobs are kept for 30 minutes; start the search again.')
  return jobDto(deps, p, j)
}

/** Polls a job until it finishes or `until` (epoch ms) passes; for MCP tools, which answer in one call. */
export async function waitForOpenverseJob(deps: Deps, p: Principal, id: string, until: number) {
  let job = await getOpenverseJob(deps, p, id)
  while ((job.status === 'queued' || job.status === 'running') && Date.now() < until) {
    const ms = Math.min(openverseTiming.pollMs, Math.max(0, until - Date.now()))
    await new Promise((resolve) => setTimeout(resolve, ms))
    job = await getOpenverseJob(deps, p, id)
  }
  return job
}

/** A failed job's error, to throw. */
export const jobError = (job: OpenverseJobDto) =>
  new ApiError(
    (job.error?.code ?? 'upstream_error') as ErrorCode,
    job.error?.message ?? "Openverse didn't answer. Try again shortly.",
  )

/** The background step (openverse-background): runs a queued job once, with long timeouts and retries. */
export async function runOpenverseJob(deps: Deps, id: string): Promise<'skipped' | 'done' | 'failed'> {
  if (!(await deps.store.claimOpenverseJob(id, deps.clock.now().toISOString()))) return 'skipped'
  const job = await deps.store.getOpenverseJob(id)
  if (!job) return 'skipped'
  const started = Date.now()
  try {
    const p = await jobPrincipal(deps, job)
    // A music pick asks for fewer retries (it moves on to other words instead); never more than the default.
    const asked = job.params.retries
    const retries =
      typeof asked === 'number' && asked >= 0
        ? Math.min(Math.trunc(asked), openverseTiming.job.retries)
        : openverseTiming.job.retries
    const opts: CallOpts = {
      ...openverseTiming.job,
      retries,
      deadline: AbortSignal.timeout(JOB_DEADLINE_MS),
    }
    let result: SearchPage | ImportResult | WarmupResult
    if (job.kind === 'warmup') {
      result = await runWarmup(deps, job.params.keys, opts)
    } else if (job.kind === 'search') {
      result = (await fetchSearchAt(deps, searchRequest(job.params as unknown as SearchQuery), opts)).page
    } else {
      if (!p) throw new ApiError('forbidden', 'Only a person can import.')
      const params = job.params as { id: string; caption?: string }
      const r = await importOpenverse(deps, p, params, opts)
      result = { mediaId: r.media.id, created: r.created }
    }
    await deps.store.updateOpenverseJob(id, {
      status: 'done',
      result,
      error: null,
      updatedAt: deps.clock.now().toISOString(),
    })
    deps.log.info('openverse.job_done', { jobId: id, kind: job.kind, ms: Date.now() - started })
    return 'done'
  } catch (e) {
    const error =
      e instanceof ApiError
        ? { code: e.code, message: e.message }
        : { code: 'internal', message: 'Something went wrong. Try again.' }
    if (e instanceof ApiError) deps.log.warn('openverse.job_failed', { jobId: id, kind: job.kind, error })
    else deps.log.error('openverse.job_failed', { jobId: id, kind: job.kind, error: e })
    await deps.store.updateOpenverseJob(id, {
      status: 'failed',
      error,
      updatedAt: deps.clock.now().toISOString(),
    })
    return 'failed'
  }
}

/** The person a job runs for (their role now, not when they asked), or null for the server's own jobs. */
async function jobPrincipal(deps: Deps, job: OpenverseJobRow): Promise<Principal | null> {
  if (job.userId === SYSTEM_USER_ID) return null
  const user = await deps.store.getUser(job.userId)
  if (!user || user.disabledAt) throw new ApiError('forbidden', 'Your account is no longer active.')
  const p = userPrincipal(user)
  assertCan(p, 'media:upload')
  return p
}

// ───────── daily warm-up ─────────

type WarmupResult = { refreshed: number; skipped: number; failed: number; left: number }

/**
 * The searches the warm-up should refresh: the common ones (music, CC0 and CC BY, first page) and the most used first
 * pages of the last two weeks, those missing or no longer fresh.
 */
export async function planWarmup(deps: Deps): Promise<string[]> {
  const now = deps.clock.now().getTime()
  const common = COMMON_SEARCHES.map((q) => searchRequest({ q, license: 'cc0,by', category: 'music' }).key)
  const top = await deps.store.topOpenverseSearches(day(now - SEARCH_USABLE_MS), WARM_TOP)
  const keys = [...new Set([...common, ...top.map((t) => t.key)])].filter((k) => requestFromKey(k))
  const out: string[] = []
  for (const key of keys) {
    const row = await deps.store.getOpenverseSearch(key)
    if (!row || Date.parse(row.fetchedAt) < warmCutoff(deps)) out.push(key)
  }
  return out
}

/**
 * Starts the daily warm-up (the openverse-warmup schedule): one background job that refreshes the planned searches,
 * spaced out. Idempotent: nothing is queued when every search is fresh or a warm-up is already queued or running.
 */
export async function startWarmup(deps: Deps): Promise<{ jobId: string | null; keys: number }> {
  const keys = await planWarmup(deps)
  if (!keys.length) return { jobId: null, keys: 0 }
  const row = newRow(deps, { userId: SYSTEM_USER_ID }, 'warmup', 'daily', { keys })
  const stored = await deps.store.insertOpenverseJobIfAbsent(row)
  if (stored.id !== row.id) return { jobId: stored.id, keys: 0 }
  deps.log.info('openverse.warmup_queued', { jobId: row.id, keys: keys.length })
  await dispatch(deps, row.id)
  return { jobId: row.id, keys: keys.length }
}

/**
 * Refreshes stored searches from Openverse, a few at a time, each started at least `warmGapMs` after the one before
 * (the app's rate limit is shared with people searching). Skips searches refreshed meanwhile, keeps going past
 * failures, and stops when Openverse says it's busy or the job's deadline nears.
 */
async function runWarmup(deps: Deps, raw: unknown, opts: CallOpts): Promise<WarmupResult> {
  const keys = (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === 'string').slice(0, 100)
  const r: WarmupResult = { refreshed: 0, skipped: 0, failed: 0, left: 0 }
  const { warmGapMs, warmConcurrency } = openverseTiming
  const call: CallOpts = { ...opts, retries: Math.min(opts.retries, 1) }
  let next = 0
  let stop = false
  // Read through a function: other workers set it while this one awaits.
  const stopped = () => stop || opts.deadline?.aborted === true
  let lastStart = -Infinity
  let gate = Promise.resolve()
  // Starts are serialized through the gate, so they stay spaced however many run at once.
  const spaced = () => {
    const turn = gate.then(async () => {
      const wait = lastStart + warmGapMs - deps.clock.now().getTime()
      if (wait > 0) await openverseTiming.sleep(wait)
      lastStart = deps.clock.now().getTime()
    })
    gate = turn.catch(() => {})
    return turn
  }
  const worker = async () => {
    while (!stopped() && next < keys.length) {
      const req = requestFromKey(keys[next++] ?? '')
      const row = req && (await deps.store.getOpenverseSearch(req.key))
      if (!req || (row && Date.parse(row.fetchedAt) >= warmCutoff(deps))) {
        r.skipped++
        continue
      }
      await spaced()
      if (stopped()) break
      try {
        await fetchSearchAt(deps, req, call)
        r.refreshed++
      } catch (e) {
        r.failed++
        deps.log.warn('openverse.warmup_search_failed', { error: e })
        if ((e instanceof ApiError && e.code === 'rate_limited') || opts.deadline?.aborted) stop = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, warmConcurrency) }, worker))
  r.left = Math.max(0, keys.length - next)
  deps.log.info('openverse.warmup_done', r)
  return r
}

/** Sweep: dispatch lost jobs again, fail the ones that were cut off or never started, and delete expired ones. */
export async function sweepOpenverseJobs(deps: Deps, limit = 20) {
  const now = deps.clock.now().getTime()
  const stale = await deps.store.listStaleOpenverseJobs({
    queuedBefore: iso(now - REDISPATCH_AFTER_MS),
    runningBefore: iso(now - RUNNING_STALE_MS),
    limit,
  })
  for (const j of stale) {
    if (j.status === 'running' || j.createdAt < iso(now - GIVE_UP_QUEUED_MS)) {
      await deps.store.updateOpenverseJob(j.id, {
        status: 'failed',
        error: { code: 'upstream_error', message: 'Openverse took too long to answer. Try again.' },
        updatedAt: iso(now),
      })
      continue
    }
    await deps.store.updateOpenverseJob(j.id, { updatedAt: iso(now) })
    await dispatch(deps, j.id)
  }
  // Searches too old to serve, and use counts older than the warm-up looks at.
  await deps.store.deleteOldOpenverseSearches({
    fetchedBefore: iso(now - SEARCH_USABLE_MS),
    keep: MAX_STORED_SEARCHES,
  })
  await deps.store.deleteOpenverseSearchUses(day(now - SEARCH_USABLE_MS))
  return deps.store.deleteExpiredOpenverseJobs(iso(now))
}
