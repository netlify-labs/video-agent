// Openverse (https://api.openverse.org/v1/): search openly licensed audio and import a track into the media library.
// Every call is made here, on the server: keys stay server-side, results are normalized, and only CC0 and CC BY works
// are offered or imported (no NC, ND or SA: those limit commercial use or edits). An import re-reads the item by id
// and downloads its file with strict limits, never from a URL the browser sent; the bytes must classify as audio.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { classify, LIMITS, MediaError } from '../lib/media/classify.js'
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
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 200
const BUSY = 'Openverse is busy, try again in a minute.'

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
}

const now = (deps: Pick<Deps, 'clock'>) => deps.clock.now().getTime()

/** A bearer token for the registered app, cached until a minute before it expires; null for anonymous access. */
async function bearer(deps: Deps): Promise<string | null> {
  const app = deps.config.openverse
  if (!app) return null
  if (token && token.key === app.clientId && token.expiresAt > now(deps)) return token.value
  tokenPending ??= (async () => {
    try {
      const res = await deps.fetch(`${OPENVERSE_API}/auth_tokens/token/`, {
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

/** GET one Openverse API path as JSON, with the app's token when there is one. Maps rate limits and outages. */
async function apiGet(deps: Deps, path: string): Promise<unknown> {
  if (busyUntil > now(deps)) throw new ApiError('rate_limited', BUSY)
  const send = async (auth: string | null) => {
    try {
      return await deps.fetch(`${OPENVERSE_API}${path}`, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        redirect: 'manual',
      })
    } catch (e) {
      deps.log.warn('openverse.unreachable', { path: path.split('?')[0], error: e })
      throw new ApiError('upstream_error', "Openverse didn't answer. Try again shortly.")
    }
  }
  let auth = await bearer(deps)
  let res = await send(auth)
  // An expired or revoked token: get a new one once.
  if (res.status === 401 && auth) {
    token = null
    auth = await bearer(deps)
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
    throw new ApiError('upstream_error', "Openverse didn't answer. Try again shortly.")
  }
  const body: unknown = await res.json().catch(() => null)
  if (!body || typeof body !== 'object')
    throw new ApiError('upstream_error', 'Openverse sent something unexpected. Try again shortly.')
  return body
}

export async function searchOpenverse(
  deps: Deps,
  p: Principal,
  q: {
    q: string
    license?: LicenseFilter | undefined
    category?: AudioCategory | undefined
    page?: number | undefined
  },
) {
  assertCan(p, 'media:upload')
  const query = q.q.trim().slice(0, 200)
  if (!query) throw new ApiError('invalid_request', 'Type something to search for.')
  const license: LicenseFilter = q.license ?? 'cc0,by'
  const allowed = license.split(',')
  const category = q.category ?? 'music'
  const page = Math.min(Math.max(Math.trunc(q.page ?? 1), 1), 10)
  const params = new URLSearchParams({ q: query, license, page: String(page), page_size: String(PAGE_SIZE) })
  if (category !== 'all') params.set('category', category)
  const key = params.toString()
  // A short cache keeps repeated searches (and paging back) inside Openverse's rate limits.
  let hit = cache.get(key)
  if (!hit || hit.at + CACHE_TTL_MS < now(deps)) {
    hit = { at: now(deps), data: await apiGet(deps, `/audio/?${key}`) }
    cache.delete(key)
    cache.set(key, hit)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }
  const body = hit.data as { results?: RawAudio[]; result_count?: number; page_count?: number }
  // Filter again here: whatever Openverse sends, nothing outside the chosen licences is ever offered.
  const items = (Array.isArray(body.results) ? body.results : [])
    .map(normalizeTrack)
    .filter((t): t is OpenverseTrack => t !== null && allowed.includes(t.license))
  const imported = await deps.store.mediaBySource(
    'openverse',
    items.map((t) => t.id),
  )
  return {
    items: items.map((t) => ({
      ...t,
      mediaId: imported.find((m) => m.sourceId === t.id && m.status === 'ready')?.id ?? null,
    })),
    page,
    pageCount: Math.min(Number(body.page_count) || 1, 10),
    total: Number(body.result_count) || items.length,
  }
}

/** Downloads a file: https only, at most 3 redirects, a size cap and a deadline. */
async function download(deps: Deps, start: string): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
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
      throw new ApiError('upstream_error', "The track's file couldn't be downloaded. Try again shortly.")
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
      throw new ApiError('upstream_error', `The track's file couldn't be downloaded (HTTP ${res.status}).`)
    }
    const tooBig = () => new ApiError('invalid_request', 'The track is over 50 MB, the audio limit.')
    if (Number(res.headers.get('content-length') ?? 0) > LIMITS.audioBytes) {
      await res.body.cancel()
      throw tooBig()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > LIMITS.audioBytes) {
          await reader.cancel()
          throw tooBig()
        }
        chunks.push(value)
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError('upstream_error', "The track's file couldn't be downloaded. Try again shortly.")
    }
    const out = new Uint8Array(size)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.byteLength
    }
    return out
  }
}

/** Imports one Openverse track into the library, or returns the item already imported from it. */
export async function importOpenverse(
  deps: Deps,
  p: Principal,
  input: { id: string; caption?: string | undefined },
) {
  assertCan(p, 'media:upload')
  const id = input.id.trim().toLowerCase()
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError('invalid_request', 'id must be an Openverse audio id.')
  const existing = (await deps.store.mediaBySource('openverse', [id])).find((m) => m.status === 'ready')
  if (existing) return { created: false, media: await mediaDto(deps, p, existing) }
  // Re-read the item by id: its licence and file come from Openverse, never from the request.
  const raw = (await apiGet(deps, `/audio/${id}/`)) as RawAudio
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
  const bytes = await download(deps, file.url)
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
