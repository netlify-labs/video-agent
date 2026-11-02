// Music picked before a run starts. Openverse often takes 20 to 60 seconds to answer, too slow for a run to search it
// reliably, so when a version needs music and has no track (picked, inherited or the brand's), the attempt waits in
// finding_music while Openverse jobs search and import a track in the background. The track is snapshotted into the
// version's media like a picked one, so the run hydrates it, the prompt names it and its credit flows. Each step is
// persisted on the attempt; the reconciler advances it every tick and gives up after MUSIC_PICK_BUDGET_MS.
import type { Deps } from '../deps.js'
import { contextMeta } from '../generated/context.js'
import { ApiError } from '../lib/errors.js'
import { LIMITS } from '../lib/media/classify.js'
import type { OpenverseTrack } from '../lib/openverse-rules.js'
import type { Repo } from '../store/types.js'
import { FAST_MODEL } from './gateway-models.js'
import { snapshotMedia } from './media.js'
import { importedTrack, searchRequest, type SearchPage } from './openverse.js'
import { queueOpenverseJob } from './openverse-jobs.js'
import { DATA_RULE, dataBlock, parseJson, record } from './plans.js'
import type { AttemptRow, MusicPick, VersionRow } from './types.js'

/** How long a run waits for its music before it starts without (the run's own Openverse helper is the backup). */
export const MUSIC_PICK_BUDGET_MS = 5 * 60_000
/** How often a waiting pick looks at its job (the sweep runs every minute; a finished job also wakes it). */
export const MUSIC_POLL_MS = 15_000
const QUERY_TIMEOUT_MS = 8_000
/** The length a track should cover when the version asks for none. */
const DEFAULT_SECONDS = 30
const DEFAULT_QUERY = 'upbeat electronic'
const DEFAULT_FALLBACK = 'background instrumental'

/** The brand's music from context/ (built into the deploy). */
export const brandMusic = () => contextMeta.music

/** True when this attempt's version should get a track before its run: music on, no audio, no brand music. */
export async function needsMusicPick(deps: Deps, a: AttemptRow): Promise<boolean> {
  if (a.musicPick) return false
  const version = await deps.store.getVersion(a.jobId, a.versionN)
  if (!version || version.mode === 'render_unchanged') return false
  if ((version.sound ?? 'silent') === 'silent' || brandMusic()) return false
  // A revision of a version with music keeps the music its composition already has.
  if (version.parentN !== null) {
    const parent = await deps.store.getVersion(a.jobId, version.parentN)
    if ((parent?.sound ?? 'silent') !== 'silent') return false
  }
  const media = await deps.store.listVersionMedia(a.jobId, a.versionN)
  return !media.some((m) => m.kind === 'audio')
}

export function newMusicPick(now: Date): MusicPick {
  return {
    status: 'searching',
    startedAt: now.toISOString(),
    query: null,
    fallbackQuery: null,
    querySource: null,
    usedFallback: false,
    searchJobId: null,
    importJobId: null,
    openverseId: null,
    title: null,
    mediaId: null,
    reason: null,
    endedAt: null,
  }
}

const words = (s: unknown, max = 5) =>
  typeof s === 'string'
    ? s
        .toLowerCase()
        .replace(/[^a-z0-9 -]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w && w !== '-')
        .slice(0, max)
        .join(' ')
        .slice(0, 60)
    : ''

// Mood words in a request and the search they suggest, strongest first.
const MOODS: [RegExp, string][] = [
  [/\b(lo-?fi|chillhop)\b/, 'lofi hip hop'],
  [/\b(cinematic|epic|dramatic|trailer|heroic)\b/, 'cinematic epic'],
  [/\b(calm|relax\w*|peaceful|gentle|soft|chill|soothing|serene|meditat\w*)\b/, 'calm ambient'],
  [/\b(playful|fun|quirky|whimsical|cute|silly|kids?)\b/, 'playful quirky'],
  [/\b(inspir\w*|uplifting|motivat\w*|hopeful|emotional)\b/, 'uplifting inspiring'],
  [/\b(corporate|business|professional|enterprise|sales|b2b)\b/, 'corporate background'],
  [/\b(acoustic|warm|folk|friendly|cozy)\b/, 'acoustic warm'],
  [/\b(futuristic|sci-?fi|cyber\w*|synth\w*)\b/, 'futuristic synth'],
  [/\b(upbeat|energetic|exciting|hype|fast|dynamic|bold|punchy|launch)\b/, 'upbeat electronic'],
  [/\b(tech\w*|digital|developers?|code|software|ai)\b/, 'electronic technology'],
]

/** Search words from the request's own mood words; a broad default when it has none. */
export function heuristicQuery(text: string): { query: string; fallbackQuery: string } {
  const t = text.toLowerCase()
  const hits = MOODS.filter(([re]) => re.test(t)).map(([, q]) => q)
  const query = hits[0] ?? DEFAULT_QUERY
  const fallbackQuery =
    hits.find((q) => q !== query) ?? (query === DEFAULT_QUERY ? DEFAULT_FALLBACK : DEFAULT_QUERY)
  return { query, fallbackQuery }
}

/** The search: the fast model's words when the AI Gateway is available, else the heuristic. */
export async function musicQuery(
  deps: Deps,
  version: VersionRow,
  seconds: number,
): Promise<Pick<MusicPick, 'query' | 'fallbackQuery' | 'querySource'>> {
  const text = [version.prompt, version.plan?.brief.tone ?? ''].join('\n')
  if (deps.gateway.available()) {
    const started = Date.now()
    const system = [
      'You choose search words for Openverse, a library of openly licensed music, to find a background track for a short video.',
      DATA_RULE,
      'Answer with only JSON: {"query": "...", "fallback": "..."}. query is 2 to 5 plain words naming the mood, genre and tempo that fit the video (for example "upbeat electronic pop" or "calm ambient piano"). fallback is a broader 2 to 4 word search, or null. No artist or song names, no punctuation.',
    ].join('\n')
    const user = [
      dataBlock('request', version.prompt),
      ...(version.plan ? [dataBlock('tone', version.plan.brief.tone)] : []),
      dataBlock('length_seconds', seconds),
    ].join('\n')
    try {
      const r = await deps.gateway.messages(
        { model: FAST_MODEL, system, user, maxTokens: 100 },
        { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) },
      )
      await record(deps, { userId: version.authorId }, null, 'music_query', r.model, started, {
        usage: r.usage,
      })
      const out = parseJson(r.text) as { query?: unknown; fallback?: unknown }
      const query = words(out.query)
      if (query) {
        const fallback = words(out.fallback, 4)
        return {
          query,
          fallbackQuery: fallback && fallback !== query ? fallback : heuristicQuery(text).fallbackQuery,
          querySource: 'gateway',
        }
      }
      deps.log.warn('music.query_invalid', { jobId: version.jobId })
    } catch (e) {
      if (!(e instanceof SyntaxError))
        await record(deps, { userId: version.authorId }, null, 'music_query', FAST_MODEL, started, {
          error: e,
        })
      deps.log.warn('music.query_failed', { jobId: version.jobId, error: e })
    }
  }
  return { ...heuristicQuery(text), querySource: 'heuristic' }
}

const VOCALS = /\b(vocals?|singing|singer|lyrics|a ?cappella|choir|rap)\b/i

/**
 * The best track to import: one the library can take, without vocals when there's a choice; among those at least
 * `seconds` long, CC0 before CC BY, else the longest. Openverse's order breaks ties.
 */
export function chooseTrack(items: OpenverseTrack[], seconds: number): OpenverseTrack | null {
  const usable = items.filter(
    (t) => t.importable && (t.durationSec === null || t.durationSec <= LIMITS.audioSeconds),
  )
  const plain = usable.filter((t) => !VOCALS.test([t.title, ...t.genres].join(' ')))
  const pool = plain.length ? plain : usable
  const long = pool.filter((t) => (t.durationSec ?? 0) >= seconds)
  if (long.length) return long.find((t) => t.license === 'cc0') ?? long[0] ?? null
  const known = pool
    .filter((t) => t.durationSec !== null)
    .sort(
      (a, b) =>
        (b.durationSec ?? 0) - (a.durationSec ?? 0) ||
        Number(b.license === 'cc0') - Number(a.license === 'cc0'),
    )
  return known[0] ?? pool[0] ?? null
}

/** The length the track should cover: the version's target, else its plan's beats, else 30 s. */
export function targetSeconds(version: VersionRow): number {
  const planned = version.plan?.brief.beats.reduce((t, b) => t + b.seconds, 0) ?? 0
  return version.targetDurationSec ?? (planned > 0 ? Math.round(planned) : DEFAULT_SECONDS)
}

/**
 * One step of a pick: looks at its jobs and moves it on as far as it can now. Returns the pick to persist; picked and
 * skipped are final (start the run). Openverse is only reached through background jobs, so a step is quick.
 */
export async function advanceMusicPick(deps: Deps, a: AttemptRow): Promise<MusicPick> {
  const now = deps.clock.now()
  let pick = a.musicPick ?? newMusicPick(now)
  const skip = (reason: string): MusicPick => {
    deps.log.info('music.skipped', { attemptId: a.id, reason })
    return { ...pick, status: 'skipped', reason, endedAt: now.toISOString() }
  }
  if (pick.status === 'picked' || pick.status === 'skipped') return pick
  if (now.getTime() - new Date(pick.startedAt).getTime() > MUSIC_PICK_BUDGET_MS)
    return skip('Openverse took too long to answer.')
  const version = await deps.store.getVersion(a.jobId, a.versionN)
  if (!version) return skip('The version is gone.')
  const seconds = targetSeconds(version)
  // Each pass either waits on a job, finishes, or moves to the next job; a few passes cover a whole pick.
  for (let pass = 0; pass < 6; pass++) {
    if (pick.status === 'searching') {
      if (!pick.query) pick = { ...pick, ...(await musicQuery(deps, version, seconds)) }
      const q = pick.query ?? DEFAULT_QUERY
      if (!pick.searchJobId) {
        const req = searchRequest({ q, license: 'cc0,by', category: 'music' })
        const params = { q, license: 'cc0,by', category: 'music', page: 1, attemptId: a.id }
        const job = await queueOpenverseJob(deps, version.authorId, 'search', req.key, params)
        pick = { ...pick, searchJobId: job.id }
      }
      const job = await deps.store.getOpenverseJob(pick.searchJobId ?? '')
      if (job && (job.status === 'queued' || job.status === 'running')) return pick
      const track =
        job?.status === 'done' ? chooseTrack((job.result as SearchPage | null)?.items ?? [], seconds) : null
      if (!track) {
        if (pick.usedFallback || !pick.fallbackQuery)
          return skip(
            job?.status === 'done'
              ? 'Openverse had no track that fits.'
              : (job?.error?.message ?? 'The music search was lost.'),
          )
        pick = { ...pick, query: pick.fallbackQuery, usedFallback: true, searchJobId: null }
        continue
      }
      pick = { ...pick, openverseId: track.id, title: track.title }
      const existing = await importedTrack(deps, track.id)
      if (existing) return picked(pick, existing.id, now)
      const importJob = await queueOpenverseJob(deps, version.authorId, 'import', track.id, {
        id: track.id,
        attemptId: a.id,
      })
      pick = { ...pick, status: 'importing', importJobId: importJob.id }
      continue
    }
    if (pick.status === 'importing') {
      const job = await deps.store.getOpenverseJob(pick.importJobId ?? '')
      if (job && (job.status === 'queued' || job.status === 'running')) return pick
      if (job?.status !== 'done') return skip(job?.error?.message ?? 'The music import was lost.')
      const mediaId = (job.result as { mediaId?: string } | null)?.mediaId
      const m = mediaId ? await deps.store.getMedia(mediaId) : null
      if (!m || m.deletedAt || m.status !== 'ready') return skip('The imported track is gone.')
      return picked(pick, m.id, now)
    }
    return pick
  }
  return pick
}

function picked(pick: MusicPick, mediaId: string, now: Date): MusicPick {
  return { ...pick, status: 'picked', mediaId, reason: null, endedAt: now.toISOString() }
}

/**
 * Adds the picked track to the version's media, after what it already has, inside the caller's transaction. False when
 * it can't be added (the version's media limits); a version that has gained audio meanwhile keeps that instead.
 */
export async function attachTrack(repo: Repo, a: AttemptRow, mediaId: string): Promise<boolean> {
  const existing = await repo.listVersionMedia(a.jobId, a.versionN)
  if (existing.some((m) => m.kind === 'audio')) return existing.some((m) => m.mediaId === mediaId)
  try {
    const rows = await snapshotMedia(repo, a.jobId, a.versionN, [mediaId], existing)
    await repo.insertVersionMedia(rows.filter((r) => !existing.some((e) => e.mediaId === r.mediaId)))
    return true
  } catch (e) {
    if (e instanceof ApiError) return false
    throw e
  }
}

/** What the API shows of a pick. */
export function musicPickDto(p: MusicPick | null | undefined) {
  if (!p) return null
  return { status: p.status, query: p.query, title: p.title, mediaId: p.mediaId, reason: p.reason }
}
