// Openverse searches and imports that survive a slow Openverse. Its audio search often takes 20 to 60 seconds, longer
// than an API request may run, so a request tries for a few seconds itself and then hands the work to a job that
// openverse-background runs with minutes to spare. A finished search is also the cache every instance shares; identical
// requests from one person share a job; each person starts a limited number per minute; the sweep reaps old jobs.
import type { Deps } from '../deps.js'
import { ApiError, type ErrorCode } from '../lib/errors.js'
import { mediaDto } from './media.js'
import {
  CACHE_TTL_MS,
  cachedSearch,
  fetchSearch,
  importedTrack,
  importOpenverse,
  openverseTiming,
  OpenverseUnavailable,
  searchRequest,
  SYNC_CALL,
  trackId,
  withLibrary,
  type CallOpts,
  type SearchPage,
  type SearchQuery,
} from './openverse.js'
import { assertCan, type Principal } from './policy.js'
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

type ImportResult = { mediaId: string; created: boolean }
type MediaDto = Awaited<ReturnType<typeof mediaDto>>
export type SearchResult = Awaited<ReturnType<typeof withLibrary>>

export interface OpenverseJobDto {
  id: string
  kind: OpenverseJobKind
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
  if (kind === 'search') {
    const since = iso(deps.clock.now().getTime() - CACHE_TTL_MS)
    const recent = await deps.store.findOpenverseJob({ kind, key, statuses: ['done'], since })
    if (recent) return recent
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

/** A search: from a cache when someone searched the same recently, else a short try, else a job. */
export async function startOpenverseSearch(
  deps: Deps,
  p: Principal,
  q: SearchQuery,
): Promise<Started<SearchResult>> {
  assertCan(p, 'media:upload')
  const req = searchRequest(q)
  const now = deps.clock.now().getTime()
  const recent =
    cachedSearch(deps, req) ??
    ((
      await deps.store.findOpenverseJob({
        kind: 'search',
        key: req.key,
        statuses: ['done'],
        since: iso(now - CACHE_TTL_MS),
      })
    )?.result as SearchPage | undefined) ??
    null
  if (recent) return { done: await withLibrary(deps, recent) }
  const running = await inflight(deps, p, 'search', req.key)
  if (running) return { job: await jobDto(deps, p, running) }
  await assertRate(deps, p)
  const params = { q: q.q.trim().slice(0, 200), license: q.license, category: q.category, page: req.page }
  try {
    const page = await fetchSearch(deps, req, inline())
    // Kept as a finished job, so other instances answer the same search from it.
    await deps.store.insertOpenverseJobIfAbsent({
      ...newRow(deps, p, 'search', req.key, params),
      status: 'done',
      result: page,
    })
    return { done: await withLibrary(deps, page) }
  } catch (e) {
    if (!(e instanceof OpenverseUnavailable)) throw e
  }
  return { job: await enqueue(deps, p, 'search', req.key, params) }
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
    kind: j.kind,
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
  if (j.kind === 'search') return { ...out, search: await withLibrary(deps, j.result as SearchPage) }
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
    // The person's role now, not when they asked.
    const user = await deps.store.getUser(job.userId)
    if (!user || user.disabledAt) throw new ApiError('forbidden', 'Your account is no longer active.')
    const p: Principal = {
      kind: 'user',
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      apiKeyId: null,
    }
    assertCan(p, 'media:upload')
    const opts: CallOpts = { ...openverseTiming.job, deadline: AbortSignal.timeout(JOB_DEADLINE_MS) }
    let result: SearchPage | ImportResult
    if (job.kind === 'search') {
      result = await fetchSearch(deps, searchRequest(job.params as unknown as SearchQuery), opts)
    } else {
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
  return deps.store.deleteExpiredOpenverseJobs(iso(now))
}
