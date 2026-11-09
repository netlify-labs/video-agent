// The logic of npm run seed:music (scripts/seed-music.ts): which tracks to import and how to wait for a slow Openverse,
// with the API calls and the clock passed in so tests can fake both. The real calls go through the SDK (sdkCall).
import { isVideoAgentError, type VideoAgent } from '../../packages/sdk/src/index.js'

/** A track from the site's Openverse search (the fields the seed uses). */
export interface SeedTrack {
  id: string
  title: string
  creator: string | null
  durationSec: number | null
  license: string
  genres: string[]
  importable: boolean
  /** The library item it already is, if any. */
  mediaId: string | null
}

/** One mood the starter set covers, and the Openverse search for it. */
export interface SeedMood {
  mood: string
  query: string
}

export const SEED_MOODS: SeedMood[] = [
  { mood: 'upbeat', query: 'upbeat electronic' },
  { mood: 'ambient', query: 'calm ambient' },
  { mood: 'corporate', query: 'corporate' },
  { mood: 'cinematic', query: 'cinematic' },
  { mood: 'acoustic', query: 'acoustic guitar' },
  { mood: 'playful', query: 'playful' },
  { mood: 'inspiring', query: 'inspiring piano' },
  { mood: 'lofi', query: 'lofi' },
]

/** Seeded tracks are 30 seconds to 4 minutes: long enough for a short video, short enough to download quickly. */
export const MIN_SECONDS = 30
export const MAX_SECONDS = 240
/** Search pages looked through per mood. */
const SEARCH_PAGES = 2

const VOCALS = /\b(vocals?|singing|singer|lyrics|a ?cappella|choir|rap)\b/i
const norm = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
/** Two listings of the same work (one artist often uploads a track more than once). */
export const workKey = (t: Pick<SeedTrack, 'title' | 'creator'>) => `${norm(t.title)}|${norm(t.creator)}`

export type Rejection = 'licence' | 'not_importable' | 'length' | 'vocals' | 'in_library' | 'duplicate'

/** CC0 and CC BY by default (CC BY tracks are credited automatically when a video uses them); `cc0` for no credits. */
export type SeedLicences = 'cc0' | 'cc0,by'

/** Why a track can't be seeded, or null when it can. */
export function rejection(
  t: SeedTrack,
  seen: { ids: Set<string>; works: Set<string>; librarySourceIds: Set<string> },
  licences: SeedLicences = 'cc0,by',
): Rejection | null {
  if (!licences.split(',').includes(t.license)) return 'licence'
  if (!t.importable) return 'not_importable'
  if (t.durationSec === null || t.durationSec < MIN_SECONDS || t.durationSec > MAX_SECONDS) return 'length'
  if (VOCALS.test([t.title, ...t.genres].join(' '))) return 'vocals'
  if (t.mediaId || seen.librarySourceIds.has(t.id)) return 'in_library'
  if (seen.ids.has(t.id) || seen.works.has(workKey(t))) return 'duplicate'
  return null
}

/** Up to `take` tracks to import from one search, in Openverse's order, and how many were already in the library. */
export function chooseSeedTracks(
  items: SeedTrack[],
  take: number,
  seen: { ids: Set<string>; works: Set<string>; librarySourceIds: Set<string> },
  licences: SeedLicences = 'cc0,by',
): { chosen: SeedTrack[]; inLibrary: SeedTrack[] } {
  const chosen: SeedTrack[] = []
  const inLibrary: SeedTrack[] = []
  // CC0 first (no credit needed), then CC BY, otherwise in Openverse's order.
  const ordered = [...items].sort((a, b) => Number(b.license === 'cc0') - Number(a.license === 'cc0'))
  for (const t of ordered) {
    const why = rejection(t, seen, licences)
    if (why === 'in_library') inLibrary.push(t)
    if (why || chosen.length >= take) continue
    chosen.push(t)
    seen.ids.add(t.id)
    seen.works.add(workKey(t))
  }
  return { chosen, inLibrary }
}

/** How many tracks each mood gets: `count` spread over the moods in order (the first ones get the remainder). */
export function quotas(count: number, moods: SeedMood[] = SEED_MOODS): { mood: SeedMood; take: number }[] {
  const n = Math.max(0, Math.trunc(count))
  return moods
    .map((mood, i) => ({ mood, take: Math.floor(n / moods.length) + (i < n % moods.length ? 1 : 0) }))
    .filter((q) => q.take > 0)
}

/** The library caption: the track, its creator and the mood words the server's music fallback matches on. */
export function seedCaption(t: SeedTrack, mood: SeedMood): string {
  const words = [...new Set([mood.mood, ...mood.query.split(' '), ...t.genres.map((g) => g.toLowerCase())])]
  return `${t.title}${t.creator ? ` by ${t.creator}` : ''} (${words.join(', ')})`.slice(0, 500)
}

export type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown; retryAfterSec?: number | null }>

/**
 * A Call through the SDK: its auth, User-Agent and error mapping, answering errors as statuses the way seedMusic
 * expects. seedMusic waits out 429s and 5xx itself, so give the client retries: 0.
 */
export function sdkCall(va: Pick<VideoAgent, 'send'>): Call {
  return async (method, path, body) => {
    try {
      const res = await va.send({
        method,
        url: path,
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      })
      const text = await res.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = { error: { message: `not JSON (HTTP ${res.status})` } }
      }
      return { status: res.status, json, retryAfterSec: Number(res.headers.get('retry-after')) || null }
    } catch (e) {
      if (!isVideoAgentError(e) || e.status === 0) throw e
      return {
        status: e.status,
        json: { error: { code: e.code, message: e.message } },
        retryAfterSec: e.retryAfterSec ?? null,
      }
    }
  }
}

export interface Patience {
  sleep: (ms: number) => Promise<void>
  /** How often a job is polled, and for how long. */
  pollMs: number
  jobTimeoutMs: number
  /** Waits before each retry of a 5xx or a refused (429) call. */
  backoffMs: number[]
  log: (msg: string) => void
}

export const PATIENCE: Patience = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs: 5_000,
  jobTimeoutMs: 15 * 60_000,
  backoffMs: [10_000, 30_000, 60_000, 60_000, 120_000],
  log: (m) => {
    console.log(m)
  },
}

interface Job {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  search: { items: SeedTrack[] } | null
  media: { id: string } | null
  error: { code: string; message: string } | null
}

// A job (app/server/domain/openverse-jobs.ts), told apart from a media item by its expiry.
const isJob = (x: unknown): x is Job =>
  typeof x === 'object' && x !== null && typeof (x as Job).id === 'string' && 'expiresAt' in x
const errorOf = (x: unknown) =>
  (x as { error?: { message?: string } } | null)?.error?.message ?? 'unexpected answer'

/**
 * A call that waits out a slow or busy Openverse: retries 5xx and 429 with backoff (honouring Retry-After), and
 * follows a 202 job to its end. Returns the finished answer (200/201 body, or the done job), or throws.
 */
export async function patient(call: Call, method: string, path: string, body: unknown, p: Patience) {
  for (let attempt = 0; ; attempt++) {
    const r = await call(method, path, body)
    if (r.status === 202 && isJob(r.json)) return waitForJob(call, r.json, p)
    if (r.status === 200 || r.status === 201) return r.json
    const retryable = r.status === 429 || r.status >= 500
    const wait = Math.max(p.backoffMs[attempt] ?? -1, (r.retryAfterSec ?? 0) * 1000)
    if (!retryable || attempt >= p.backoffMs.length)
      throw new Error(`${method} ${path.split('?')[0] ?? path}: HTTP ${r.status}: ${errorOf(r.json)}`)
    p.log(`  Openverse is slow or busy (HTTP ${r.status}); trying again in ${Math.round(wait / 1000)} s…`)
    await p.sleep(wait)
  }
}

async function waitForJob(call: Call, job: Job, p: Patience): Promise<Job> {
  let waited = 0
  let j = job
  while (j.status === 'queued' || j.status === 'running') {
    if (waited >= p.jobTimeoutMs) throw new Error(`Job ${j.id} didn't finish in time.`)
    await p.sleep(p.pollMs)
    waited += p.pollMs
    const r = await call('GET', `/api/v1/media/openverse/jobs/${j.id}`)
    if (r.status === 200 && isJob(r.json)) j = r.json
    else if (r.status !== 429 && r.status < 500)
      throw new Error(`Job ${j.id}: HTTP ${r.status}: ${errorOf(r.json)}`)
  }
  if (j.status === 'failed') throw new Error(j.error?.message ?? `Job ${j.id} failed.`)
  return j
}

export interface SeedRow {
  mood: string
  title: string
  creator: string | null
  license: string
  seconds: number | null
  outcome: 'imported' | 'in_library' | 'failed'
  note?: string
}

/** The Openverse ids already in the library (its audio items' sources). */
export async function librarySourceIds(call: Call): Promise<Set<string>> {
  const ids = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ kind: 'audio', limit: '100', ...(cursor ? { cursor } : {}) })
    const r = await call('GET', `/api/v1/media?${q.toString()}`)
    if (r.status !== 200) throw new Error(`GET /api/v1/media: HTTP ${r.status}: ${errorOf(r.json)}`)
    const body = r.json as {
      items: { source: { name: string; id: string } | null }[]
      nextCursor: string | null
    }
    for (const m of body.items) if (m.source?.name === 'openverse') ids.add(m.source.id)
    cursor = body.nextCursor
    if (!cursor) break
  }
  return ids
}

/** Searches each mood and imports its share of tracks (CC0 first), one call at a time. Never throws for one track. */
export async function seedMusic(
  call: Call,
  count: number,
  p: Patience = PATIENCE,
  licences: SeedLicences = 'cc0,by',
): Promise<SeedRow[]> {
  const seen = {
    ids: new Set<string>(),
    works: new Set<string>(),
    librarySourceIds: await librarySourceIds(call),
  }
  const rows: SeedRow[] = []
  const row = (mood: SeedMood, t: SeedTrack, outcome: SeedRow['outcome'], note?: string): SeedRow => ({
    mood: mood.mood,
    title: t.title,
    creator: t.creator,
    license: t.license,
    seconds: t.durationSec,
    outcome,
    ...(note ? { note } : {}),
  })
  for (const { mood, take } of quotas(count)) {
    p.log(`Searching for ${mood.mood} music ("${mood.query}")…`)
    const chosen: SeedTrack[] = []
    // A second page when the first hasn't enough new tracks.
    for (let page = 1; page <= SEARCH_PAGES && chosen.length < take; page++) {
      let items: SeedTrack[]
      try {
        const q = new URLSearchParams({
          q: mood.query,
          license: licences,
          category: 'music',
          page: String(page),
        })
        const answer = await patient(
          call,
          'GET',
          `/api/v1/media/openverse/search?${q.toString()}`,
          undefined,
          p,
        )
        items = (isJob(answer) ? answer.search?.items : (answer as { items?: SeedTrack[] }).items) ?? []
      } catch (e) {
        p.log(`  Skipped ${mood.mood}: ${e instanceof Error ? e.message : String(e)}`)
        break
      }
      const found = chooseSeedTracks(items, take - chosen.length, seen, licences)
      chosen.push(...found.chosen)
      for (const t of found.inLibrary) {
        if (rows.some((r) => r.outcome === 'in_library' && r.title === t.title && r.creator === t.creator))
          continue
        rows.push(row(mood, t, 'in_library'))
      }
      if (items.length < 20) break
    }
    if (!chosen.length)
      p.log(
        `  No new ${licences === 'cc0' ? 'CC0' : 'CC0 or CC BY'} ${mood.mood} tracks of 30 s to 4 min found.`,
      )
    for (const t of chosen) {
      p.log(`  Importing "${t.title}"${t.creator ? ` by ${t.creator}` : ''}…`)
      try {
        await patient(
          call,
          'POST',
          '/api/v1/media/openverse/import',
          { id: t.id, caption: seedCaption(t, mood) },
          p,
        )
        rows.push(row(mood, t, 'imported'))
      } catch (e) {
        rows.push(row(mood, t, 'failed', e instanceof Error ? e.message : String(e)))
      }
    }
  }
  return rows
}

/** The summary printed at the end. */
export function summary(rows: SeedRow[]): string {
  const n = (o: SeedRow['outcome']) => rows.filter((r) => r.outcome === o).length
  const lines = rows.map((r) => {
    const sec = r.seconds === null ? null : Math.round(r.seconds)
    const len = sec === null ? '?' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
    const what =
      r.outcome === 'imported' ? 'imported' : r.outcome === 'in_library' ? 'already in library' : 'failed'
    return `  ${what.padEnd(18)} ${r.mood.padEnd(10)} "${r.title}" by ${r.creator ?? 'unknown'}, ${r.license.toUpperCase()}, ${len}${r.note ? ` (${r.note})` : ''}`
  })
  return [
    `Imported ${n('imported')}, already in the library ${n('in_library')}, failed ${n('failed')}.`,
    ...lines,
    rows.some((r) => r.outcome === 'imported' && r.license === 'by')
      ? 'CC BY tracks are credited automatically on videos that use them; CC0 tracks need no credit.'
      : 'Imported tracks are CC0: no credit is needed when a video uses them.',
  ].join('\n')
}
