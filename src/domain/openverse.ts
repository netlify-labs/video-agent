// Openverse (https://api.openverse.org/v1/): search openly licensed audio and import a track into the media library.
// Every call is made here, on the server: keys stay server-side, results are normalized, and only CC0 and CC BY works
// are offered or imported (no NC, ND or SA: those limit commercial use or edits). An import re-reads the item by id
// and downloads its file with strict limits, never from a URL the browser sent; the bytes must classify as audio.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { classify, LIMITS, MediaError } from '../lib/media/classify.js'
import { readCapped } from '../lib/media/range.js'
import {
  isImportLicense,
  licenseLabel,
  normalizeTrack,
  pickFile,
  type OpenverseTrack,
  type RawAudio,
} from '../lib/openverse-rules.js'
import { mediaDto, storeMedia } from './media.js'
import { assertCan, type Principal } from './policy.js'
import type { MediaProvenance } from './types.js'

// The licence and normalization rules live in src/lib/openverse-rules.ts, shared with the run's scripts/openverse.ts.
export { normalizeTrack, type OpenverseTrack }

export const OPENVERSE_API = 'https://api.openverse.org/v1'
const USER_AGENT = 'VideoAgent/1.0 (Netlify video agent template; media library music search)'
const API_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 25_000
const MAX_REDIRECTS = 3
const PAGE_SIZE = 20
export const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 200
/** A stored search is served as is for a day, then served stale (and refreshed in the background) for two weeks. */
export const SEARCH_FRESH_MS = 24 * 60 * 60_000
export const SEARCH_USABLE_MS = 14 * 24 * 60 * 60_000
const BUSY = 'Openverse is busy, try again in a minute.'
const NO_ANSWER = "Openverse didn't answer. Try again shortly."

/**
 * How long one call may take and what to do when Openverse is slow. A request in the API function has seconds, so it
 * makes one short try; openverse-background has minutes, so it waits longer, retries timeouts and 5xx with backoff,
 * and waits out a 429's Retry-After. `deadline` bounds the whole operation (every call and download in it).
 */
export interface CallOpts {
  timeoutMs: number
  downloadMs: number
  retries: number
  /** The longest Retry-After (or remaining back-off) worth waiting for; longer ones fail as busy. */
  maxWaitMs: number
  deadline?: AbortSignal | undefined
}
export const SYNC_CALL: CallOpts = {
  timeoutMs: API_TIMEOUT_MS,
  downloadMs: DOWNLOAD_TIMEOUT_MS,
  retries: 0,
  maxWaitMs: 0,
}

/** Timings for the background path; tests shorten them and replace `sleep` to keep time fake. */
export const openverseTiming = {
  /** How long an API request tries Openverse itself before handing the work to a job. */
  inlineMs: 6_000,
  job: { timeoutMs: 60_000, downloadMs: 180_000, retries: 3, maxWaitMs: 120_000 } as CallOpts,
  /** Waits before each retry of a timeout or 5xx. */
  backoffMs: [2_000, 5_000, 15_000],
  /** The daily warm-up: at least this long between the starts of its searches, and at most this many at once. */
  warmGapMs: 4_000,
  warmConcurrency: 3,
  /** How long an MCP tool waits for a job (requests must answer within ~10 s), and how often it looks. */
  mcpWaitMs: 8_000,
  pollMs: 1_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}
const DEFAULT_TIMING = structuredClone({ ...openverseTiming, sleep: undefined })
const defaultSleep = openverseTiming.sleep

/** Openverse (or a file host) was slow or down: worth trying again later, unlike a refusal or a missing track. */
export class OpenverseUnavailable extends ApiError {
  constructor(message = NO_ANSWER) {
    super('upstream_error', message)
  }
}

const signalFor = (ms: number, deadline?: AbortSignal) =>
  deadline ? AbortSignal.any([AbortSignal.timeout(ms), deadline]) : AbortSignal.timeout(ms)

export const LICENSE_FILTERS = ['cc0', 'cc0,by'] as const
export type LicenseFilter = (typeof LICENSE_FILTERS)[number]
export const AUDIO_CATEGORIES = ['music', 'sound_effect', 'all'] as const
export type AudioCategory = (typeof AUDIO_CATEGORIES)[number]

// ───────── module state: token, response cache, back-off (per function instance) ─────────

let token: { value: string; expiresAt: number; key: string } | null = null
let tokenPending: Promise<string | null> | null = null
const cache = new Map<string, { at: number; data: unknown }>()
let busyUntil = 0

/** Tests start clean. */
export function resetOpenverseCache() {
  token = null
  tokenPending = null
  cache.clear()
  busyUntil = 0
  Object.assign(openverseTiming, structuredClone(DEFAULT_TIMING), { sleep: defaultSleep })
}

const now = (deps: Pick<Deps, 'clock'>) => deps.clock.now().getTime()

/** A bearer token for the registered app, cached until a minute before it expires; null for anonymous access. */
async function bearer(deps: Deps): Promise<string | null> {
  const app = deps.config.openverse
  if (!app) return null
  if (token && token.key === app.clientId && token.expiresAt > now(deps)) return token.value
  tokenPending ??= (async () => {
    try {
      const res = await deps
        .fetch(`${OPENVERSE_API}/auth_tokens/token/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: app.clientId,
            client_secret: app.clientSecret,
          }).toString(),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
          redirect: 'manual',
        })
        .catch((e: unknown) => {
          deps.log.warn('openverse.unreachable', { path: '/auth_tokens/token/', error: e })
          throw new OpenverseUnavailable()
        })
      if (res.status === 429) throw new ApiError('rate_limited', BUSY)
      const body = (await res.json().catch(() => null)) as {
        access_token?: string
        expires_in?: number
      } | null
      if (!res.ok || !body?.access_token) {
        // Bad credentials shouldn't take search down: say so in the logs and search anonymously.
        deps.log.error('openverse.token_failed', { status: res.status })
        return null
      }
      const ttl = Math.max(60, Number(body.expires_in) || 3600)
      token = { value: body.access_token, expiresAt: now(deps) + (ttl - 60) * 1000, key: app.clientId }
      return token.value
    } finally {
      tokenPending = null
    }
  })()
  return tokenPending
}

/** For the setup page: whether music search runs as a registered app (a token is issued) or anonymously. */
export async function openverseStatus(
  deps: Deps,
): Promise<'anonymous' | 'registered' | 'rejected' | 'unknown'> {
  if (!deps.config.openverse) return 'anonymous'
  try {
    return (await bearer(deps)) ? 'registered' : 'rejected'
  } catch {
    return 'unknown'
  }
}

/** Waits `ms`, unless the operation's deadline passes first. */
async function pause(ms: number, deadline?: AbortSignal) {
  if (deadline?.aborted) throw new OpenverseUnavailable()
  if (!deadline) return openverseTiming.sleep(ms)
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new OpenverseUnavailable())
    }
    deadline.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([openverseTiming.sleep(ms), aborted])
  } finally {
    deadline.removeEventListener('abort', onAbort)
  }
}

/** Runs fn, retrying timeouts and outages with backoff and waiting out rate limits, as far as `opts` allows. */
async function retrying<T>(deps: Deps, opts: CallOpts, what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const busy = e instanceof ApiError && e.code === 'rate_limited'
      if (attempt >= opts.retries || !(e instanceof OpenverseUnavailable || busy)) throw e
      const { backoffMs } = openverseTiming
      const backoff = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000
      const wait = busy ? Math.max(busyUntil - now(deps), backoff) : backoff
      if (wait > opts.maxWaitMs) throw e
      deps.log.info('openverse.retry', { what, attempt: attempt + 1, waitMs: wait, busy })
      await pause(wait, opts.deadline)
    }
  }
}

/** The token, but no later than the operation's deadline (the token request is shared, so it isn't aborted). */
async function bearerBy(deps: Deps, deadline?: AbortSignal): Promise<string | null> {
  if (!deadline) return bearer(deps)
  if (deadline.aborted) throw new OpenverseUnavailable()
  let onAbort = () => {}
  try {
    return await Promise.race([
      bearer(deps),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(new OpenverseUnavailable())
        }
        deadline.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    deadline.removeEventListener('abort', onAbort)
  }
}

/** GET one Openverse API path as JSON, with the app's token when there is one. Maps rate limits and outages. */
async function apiGet(deps: Deps, path: string, opts: CallOpts = SYNC_CALL): Promise<unknown> {
  return retrying(deps, opts, path.split('?')[0] ?? path, () => apiGetOnce(deps, path, opts))
}

async function apiGetOnce(deps: Deps, path: string, opts: CallOpts): Promise<unknown> {
  if (busyUntil > now(deps)) throw new ApiError('rate_limited', BUSY)
  const send = async (auth: string | null) => {
    try {
      return await deps.fetch(`${OPENVERSE_API}${path}`, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        signal: signalFor(opts.timeoutMs, opts.deadline),
        redirect: 'manual',
      })
    } catch (e) {
      deps.log.warn('openverse.unreachable', { path: path.split('?')[0], error: e })
      throw new OpenverseUnavailable()
    }
  }
  let auth = await bearerBy(deps, opts.deadline)
  let res = await send(auth)
  // An expired or revoked token: get a new one once.
  if (res.status === 401 && auth) {
    token = null
    auth = await bearerBy(deps, opts.deadline)
    res = await send(auth)
  }
  if (res.status === 429) {
    const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 60, 5), 300)
    busyUntil = now(deps) + wait * 1000
    deps.log.warn('openverse.rate_limited', { retryAfterSec: wait, registered: Boolean(auth) })
    throw new ApiError('rate_limited', BUSY)
  }
  if (res.status === 404) throw new ApiError('not_found', "That track isn't on Openverse (any more).")
  if (!res.ok) {
    deps.log.warn('openverse.error', { path: path.split('?')[0], status: res.status })
    // A 5xx (or a gateway timeout) is worth another try; anything else means the request itself is wrong.
    if (res.status >= 500) throw new OpenverseUnavailable()
    throw new ApiError('upstream_error', NO_ANSWER)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object')
    throw new OpenverseUnavailable('Openverse sent something unexpected. Try again shortly.')
  return body
}

export interface SearchQuery {
  q: string
  license?: LicenseFilter | undefined
  category?: AudioCategory | undefined
  page?: number | undefined
}

/** A search page, normalized and filtered, before it's checked against the library. */
export interface SearchPage {
  items: OpenverseTrack[]
  page: number
  pageCount: number
  total: number
}

/** The normalized search: Openverse's query string (also the cache and job key), the page and the licences kept. */
export function searchRequest(q: SearchQuery) {
  // Openverse ignores case and extra spaces, so the key (shared by everyone's searches) does too.
  const query = q.q.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200)
  if (!query) throw new ApiError('invalid_request', 'Type something to search for.')
  const license: LicenseFilter = q.license ?? 'cc0,by'
  const category = q.category ?? 'music'
  const page = Math.min(Math.max(Math.trunc(q.page ?? 1), 1), 10)
  const params = new URLSearchParams({ q: query, license, page: String(page), page_size: String(PAGE_SIZE) })
  if (category !== 'all') params.set('category', category)
  return { key: params.toString(), page, allowed: license.split(',') }
}
export type SearchRequest = ReturnType<typeof searchRequest>

function toPage(req: SearchRequest, data: unknown): SearchPage {
  const body = data as { results?: RawAudio[]; result_count?: number; page_count?: number }
  // Filter again here: whatever Openverse sends, nothing outside the chosen licences is ever offered.
  const items = (Array.isArray(body.results) ? body.results : [])
    .map(normalizeTrack)
    .filter((t): t is OpenverseTrack => t !== null && req.allowed.includes(t.license))
  return {
    items,
    page: req.page,
    pageCount: Math.min(Number(body.page_count) || 1, 10),
    total: Number(body.result_count) || items.length,
  }
}

/** The request a stored key stands for (the key is the request's own query string), or null for one that can't be. */
export function requestFromKey(key: string): SearchRequest | null {
  const p = new URLSearchParams(key)
  const license = p.get('license')
  const category = p.get('category') ?? 'all'
  if (!(LICENSE_FILTERS as readonly string[]).includes(license ?? '')) return null
  if (!(AUDIO_CATEGORIES as readonly string[]).includes(category)) return null
  try {
    const req = searchRequest({
      q: p.get('q') ?? '',
      license: license as LicenseFilter,
      category: category as AudioCategory,
      page: Number(p.get('page')) || 1,
    })
    return req.key === key ? req : null
  } catch {
    return null
  }
}

/** A page with when it was fetched from Openverse. */
export interface FetchedPage {
  page: SearchPage
  fetchedAt: string
}

/** The page from this instance's short cache, or null. */
export function cachedSearch(deps: Deps, req: SearchRequest): FetchedPage | null {
  const hit = cache.get(req.key)
  return hit && hit.at + CACHE_TTL_MS >= now(deps)
    ? { page: toPage(req, hit.data), fetchedAt: new Date(hit.at).toISOString() }
    : null
}

/** The stored search every instance shares, when it's young enough to serve (fresh or stale), else null. */
export async function storedSearch(deps: Deps, req: SearchRequest): Promise<FetchedPage | null> {
  const row = await deps.store.getOpenverseSearch(req.key).catch((e: unknown) => {
    deps.log.warn('openverse.cache_read_failed', { error: e })
    return null
  })
  if (!row || Date.parse(row.fetchedAt) < now(deps) - SEARCH_USABLE_MS) return null
  const r = row.result as Partial<SearchPage> | null
  // Filter again on the way out, like toPage: nothing outside the chosen licences is ever offered.
  const items = (Array.isArray(r?.items) ? r.items : []).filter(
    (t) => isImportLicense(t.license) && req.allowed.includes(t.license),
  )
  return {
    page: {
      items,
      page: req.page,
      pageCount: Number(r?.pageCount) || 1,
      total: Number(r?.total) || items.length,
    },
    fetchedAt: row.fetchedAt,
  }
}

/** True when a page fetched at `fetchedAt` is past the fresh window. */
export const isStale = (deps: Pick<Deps, 'clock'>, fetchedAt: string) =>
  Date.parse(fetchedAt) < now(deps) - SEARCH_FRESH_MS

/**
 * One search page from Openverse and when it was fetched, through a short cache that keeps repeats (and paging back)
 * inside its rate limits. Every answer from Openverse is also stored for every instance.
 */
export async function fetchSearchAt(
  deps: Deps,
  req: SearchRequest,
  opts: CallOpts = SYNC_CALL,
): Promise<FetchedPage> {
  const cached = cachedSearch(deps, req)
  if (cached) return cached
  const hit = { at: now(deps), data: await apiGet(deps, `/audio/?${req.key}`, opts) }
  cache.delete(req.key)
  cache.set(req.key, hit)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  const page = toPage(req, hit.data)
  const fetchedAt = new Date(hit.at).toISOString()
  // Only the tracks: whether one is in the library is looked up for each request.
  await deps.store.putOpenverseSearch({ key: req.key, result: page, fetchedAt }).catch((e: unknown) => {
    deps.log.warn('openverse.cache_write_failed', { error: e })
  })
  return { page, fetchedAt }
}

/** Marks the tracks already in the library with their media id, and says how old the page is. */
export async function withLibrary(
  deps: Deps,
  r: SearchPage,
  meta: { fetchedAt: string | null; stale: boolean } = { fetchedAt: null, stale: false },
) {
  const imported = await deps.store.mediaBySource(
    'openverse',
    r.items.map((t) => t.id),
  )
  return {
    items: r.items.map((t) => ({
      ...t,
      mediaId: imported.find((m) => m.sourceId === t.id && m.status === 'ready')?.id ?? null,
    })),
    page: r.page,
    pageCount: r.pageCount,
    total: r.total,
    fetchedAt: meta.fetchedAt,
    stale: meta.stale,
  }
}

/** Downloads a file: https only, at most 3 redirects, a size cap and a deadline. */
async function download(deps: Deps, start: string, opts: CallOpts): Promise<Uint8Array> {
  const deadline = signalFor(opts.downloadMs, opts.deadline)
  let url = start
  for (let hop = 0; ; hop++) {
    if (!url.startsWith('https://'))
      throw new ApiError('upstream_error', "The track's file isn't served over HTTPS.")
    let res: Response
    try {
      res = await deps.fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*;q=0.5' },
        signal: deadline,
        redirect: 'manual',
      })
    } catch (e) {
      deps.log.warn('openverse.download_failed', { host: new URL(url).host, error: e })
      throw new OpenverseUnavailable("The track's file couldn't be downloaded. Try again shortly.")
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      const next = res.headers.get('location')
      if (!next || hop >= MAX_REDIRECTS)
        throw new ApiError('upstream_error', "The track's file redirects too many times.")
      url = new URL(next, url).toString()
      continue
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      if (res.status === 429 || res.status >= 500)
        throw new OpenverseUnavailable(`The track's file couldn't be downloaded (HTTP ${res.status}).`)
      throw new ApiError('upstream_error', `The track's file couldn't be downloaded (HTTP ${res.status}).`)
    }
    const tooBig = () => new ApiError('invalid_request', 'The track is over 50 MB, the audio limit.')
    if (Number(res.headers.get('content-length') ?? 0) > LIMITS.audioBytes) {
      await res.body.cancel()
      throw tooBig()
    }
    try {
      return await readCapped(res.body as ReadableStream<Uint8Array>, LIMITS.audioBytes, tooBig)
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new OpenverseUnavailable("The track's file couldn't be downloaded. Try again shortly.")
    }
  }
}

/** Imports one Openverse track into the library, or returns the item already imported from it. */
/** The normalized Openverse audio id from a request. */
export function trackId(raw: string) {
  const id = raw.trim().toLowerCase()
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError('invalid_request', 'id must be an Openverse audio id.')
  return id
}

/** The library item already imported from this track, if any. */
export async function importedTrack(deps: Deps, id: string) {
  return (await deps.store.mediaBySource('openverse', [id])).find((m) => m.status === 'ready') ?? null
}

export async function importOpenverse(
  deps: Deps,
  p: Principal,
  input: { id: string; caption?: string | undefined },
  opts: CallOpts = SYNC_CALL,
) {
  assertCan(p, 'media:upload')
  const id = trackId(input.id)
  const existing = await importedTrack(deps, id)
  if (existing) return { created: false, media: await mediaDto(deps, p, existing) }
  // Re-read the item by id: its licence and file come from Openverse, never from the request.
  const raw = (await apiGet(deps, `/audio/${id}/`, opts)) as RawAudio
  const license = raw.license?.toLowerCase()
  if (!isImportLicense(license))
    throw new ApiError(
      'invalid_request',
      `Only CC0 and CC BY tracks can be imported (this one is ${licenseLabel(license ?? null, raw.license_version ?? null) || 'unlicensed'}).`,
    )
  const track = normalizeTrack(raw)
  if (!track || track.id !== id) throw new ApiError('invalid_request', "This track can't be imported.")
  if (track.durationSec !== null && track.durationSec > LIMITS.audioSeconds + 0.5)
    throw new ApiError('invalid_request', 'Audio files must be 10 minutes or shorter.')
  const file = pickFile(raw)
  if (!file)
    throw new ApiError(
      'invalid_request',
      'This track has no file the library can take (MP3, M4A, WAV or Ogg up to 50 MB).',
    )
  const bytes = await retrying(deps, opts, 'download', () => download(deps, file.url, opts))
  let c
  try {
    c = classify(bytes)
  } catch (e) {
    throw new ApiError(
      'invalid_request',
      e instanceof MediaError ? e.message : "The track's file couldn't be read as audio.",
    )
  }
  if (c.kind !== 'audio')
    throw new ApiError(
      'invalid_request',
      "The track's file isn't audio (the library takes MP3, M4A, WAV or Ogg).",
    )
  // A slow download can overlap another import of the same track: the first one stays.
  const raced = await importedTrack(deps, id)
  if (raced) return { created: false, media: await mediaDto(deps, p, raced) }
  const provenance: MediaProvenance = {
    source: 'openverse',
    sourceId: id,
    sourceUrl: track.landingUrl,
    sourceTitle: track.title,
    license: track.license,
    licenseVersion: track.licenseVersion,
    licenseUrl: track.licenseUrl,
    creator: track.creator,
    creatorUrl: track.creatorUrl,
    attribution: track.attribution,
  }
  const row = await storeMedia(deps, p, bytes, c, {
    filename: track.creator ? `${track.title} - ${track.creator}` : track.title,
    caption: input.caption?.trim() || (track.creator ? `${track.title} by ${track.creator}` : track.title),
    provenance,
  })
  await deps.store.insertMedia(row)
  deps.log.info('media.imported', { id: row.id, source: 'openverse', sourceId: id, bytes: row.bytes })
  return { created: true, media: await mediaDto(deps, p, row) }
}
