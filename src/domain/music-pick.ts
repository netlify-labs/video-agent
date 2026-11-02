// Music picked before a run starts. Openverse often takes 20 to 60 seconds to answer, too slow for a run to search it
// reliably, so when a version needs music and has no track (picked, inherited or the brand's), the attempt waits in
// finding_music while Openverse jobs search and import a track in the background. The track is snapshotted into the
// version's media like a picked one, so the run hydrates it, the prompt names it and its credit flows. Each step is
// persisted on the attempt; the reconciler advances it every tick. A search that fails or finds nothing importable
// moves on to the next words (the request's, then broad ones that fit its mood); when no Openverse track is chosen
// within MUSIC_PICK_BUDGET_MS, or Openverse keeps failing, the best audio already in the team's library is used.
import type { Deps } from '../deps.js'
import { contextMeta } from '../generated/context.js'
import { ApiError } from '../lib/errors.js'
import { LIMITS } from '../lib/media/classify.js'
import type { OpenverseTrack } from '../lib/openverse-rules.js'
import type { Repo } from '../store/types.js'
import { can, type Principal } from './policy.js'
import { FAST_MODEL } from './gateway-models.js'
import { snapshotMedia } from './media.js'
import { importedTrack, searchRequest, type SearchPage } from './openverse.js'
import { queueOpenverseJob } from './openverse-jobs.js'
import { DATA_RULE, dataBlock, parseJson, record } from './plans.js'
import type { AttemptRow, MediaRow, MusicPick, MusicPickTry, VersionRow } from './types.js'

/** How long a run waits for its music before it starts without (the run's own Openverse helper is the backup). */
export const MUSIC_PICK_BUDGET_MS = 5 * 60_000
/** How often a waiting pick looks at its job (the sweep runs every minute; a finished job also wakes it). */
export const MUSIC_POLL_MS = 15_000
const QUERY_TIMEOUT_MS = 8_000
/** The length a track should cover when the version asks for none. */
const DEFAULT_SECONDS = 30
const DEFAULT_QUERY = 'upbeat electronic'
const DEFAULT_FALLBACK = 'background instrumental'
/** Broad searches that almost always find something, tried after the request's own words. */
export const GENERIC_QUERIES = ['upbeat electronic', 'ambient', 'corporate', 'acoustic', 'cinematic']
/** The most searches one pick tries (the request's two plus the broad ones). */
const MAX_QUERIES = 7
/** Searches failing in a row (errors, not empty answers) that mean Openverse is down: use the library now. */
const DOWN_AFTER_FAILURES = 3
/** Pick searches don't retry: the next words are the retry (a query Openverse times out on usually keeps timing out). */
const PICK_SEARCH_RETRIES = 0

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
    tried: [],
    source: null,
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

// Mood words in a request, the search they suggest (strongest first) and the broad searches that suit them.
const MOODS: [RegExp, string, string[]][] = [
  [/\b(lo-?fi|chillhop)\b/, 'lofi hip hop', ['ambient', 'acoustic']],
  [/\b(cinematic|epic|dramatic|trailer|heroic)\b/, 'cinematic epic', ['cinematic']],
  [
    /\b(calm|relax\w*|peaceful|gentle|soft|chill|soothing|serene|meditat\w*|ambient)\b/,
    'calm ambient',
    ['ambient', 'acoustic'],
  ],
  [
    /\b(playful|fun|quirky|whimsical|cute|silly|kids?)\b/,
    'playful quirky',
    ['acoustic', 'upbeat electronic'],
  ],
  [
    /\b(inspir\w*|uplifting|motivat\w*|hopeful|emotional)\b/,
    'uplifting inspiring',
    ['cinematic', 'corporate'],
  ],
  [/\b(corporate|business|professional|enterprise|sales|b2b)\b/, 'corporate background', ['corporate']],
  [/\b(acoustic|warm|folk|friendly|cozy|guitar)\b/, 'acoustic warm', ['acoustic']],
  [/\b(futuristic|sci-?fi|cyber\w*|synth\w*)\b/, 'futuristic synth', ['upbeat electronic', 'ambient']],
  [
    /\b(upbeat|energetic|exciting|hype|fast|dynamic|bold|punchy|launch|pop|dance)\b/,
    'upbeat electronic',
    ['upbeat electronic'],
  ],
  [
    /\b(tech\w*|digital|developers?|code|software|ai|electronic)\b/,
    'electronic technology',
    ['upbeat electronic', 'corporate'],
  ],
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

/** The request's words for mood matching: its prompt and the plan's tone. */
const requestText = (version: VersionRow) => [version.prompt, version.plan?.brief.tone ?? ''].join('\n')

/**
 * The searches a pick tries, in order: the first words, the fallback, then the broad searches, those that suit the
 * request's mood (or the first words') first. At most MAX_QUERIES, no repeats.
 */
export function queryPlan(first: string, fallback: string | null, text: string): string[] {
  const t = [text, first, fallback ?? ''].join('\n').toLowerCase()
  const suited = MOODS.filter(([re]) => re.test(t)).flatMap(([, , generic]) => generic)
  return [...new Set([first, fallback ?? '', ...suited, ...GENERIC_QUERIES].filter(Boolean))].slice(
    0,
    MAX_QUERIES,
  )
}

// Words too common in music searches and titles to say anything about mood.
const STOP_WORDS = new Set(
  'and the with for music track song background instrumental modern loop version mix by of a'.split(' '),
)

/** Mood words to match library items against: the searches' words and the mood searches the request suggests. */
export function moodWords(queries: string[], text: string): string[] {
  const t = text.toLowerCase()
  const fromRequest = MOODS.filter(([re]) => re.test(t)).map(([, q]) => q)
  return [
    ...new Set(
      [...queries, ...fromRequest]
        .flatMap((q) => q.toLowerCase().split(/[^a-z0-9]+/))
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ]
}

const moodScore = (m: MediaRow, mood: string[]) => {
  const text = [m.filename, m.caption ?? '', m.sourceTitle ?? ''].join(' ').toLowerCase()
  return mood.filter((w) => new RegExp(`\\b${w}`).test(text)).length
}

/** How many library items a fallback looks through. */
const LIBRARY_SCAN = 500

/**
 * The best audio already in the team library, for when Openverse found nothing in time: ready, undeleted audio the
 * author can see (the library list's own rules). Openverse imports (licensed and creditable) first, then the best
 * mood match, then at least `seconds` long, then the most recently used or added. Null when there's none.
 */
export async function libraryTrack(
  deps: Deps,
  version: VersionRow,
  mood: string[],
  seconds: number,
): Promise<MediaRow | null> {
  const author = await deps.store.getUser(version.authorId)
  if (!author || author.disabledAt) return null
  const p: Principal = {
    kind: 'user',
    userId: author.id,
    email: author.email,
    name: author.name,
    role: author.role,
    apiKeyId: null,
  }
  if (!can(p, 'video:read')) return null
  const items: MediaRow[] = []
  let before: { createdAt: string; id: string } | undefined
  while (items.length < LIBRARY_SCAN) {
    // No includePendingOf: only ready items, the ones anyone in the team sees and a version can use.
    const page = await deps.store.listMedia({ kind: 'audio', before, limit: 100 })
    items.push(
      ...page.filter(
        (m) =>
          m.kind === 'audio' &&
          m.status === 'ready' &&
          !m.deletedAt &&
          (m.durationSec === null || m.durationSec <= LIMITS.audioSeconds),
      ),
    )
    const last = page.at(-1)
    if (page.length < 100 || !last) break
    before = { createdAt: last.createdAt, id: last.id }
  }
  if (!items.length) return null
  // One number per item: licensed import, then mood words matched, then long enough.
  const rank = (m: MediaRow) =>
    Number(m.source === 'openverse' && (m.license === 'cc0' || m.license === 'by')) * 10_000 +
    Math.min(moodScore(m, mood), 99) * 10 +
    Number((m.durationSec ?? 0) >= seconds)
  const ranked = items.map((m) => ({ m, r: rank(m) })).sort((a, b) => b.r - a.r)
  // Among the best equals, the most recently used (in any video) or added.
  const top = ranked.filter((x) => x.r === ranked[0]?.r).slice(0, 20)
  const usage = await deps.store.mediaUsage(top.map((x) => x.m.id))
  let best: { m: MediaRow; at: string } | null = null
  for (const { m } of top) {
    let at = m.createdAt
    for (const jobId of usage[m.id] ?? []) {
      const job = await deps.store.getJob(jobId)
      if (job && !job.deletedAt && job.updatedAt > at) at = job.updatedAt
    }
    if (!best || at > best.at) best = { m, at }
  }
  return best?.m ?? null
}

/** The pick with the fields added since it was first stored. */
const normalized = (p: MusicPick): MusicPick => ({ ...p, tried: p.tried ?? [], source: p.source ?? null })

/** The pick with its latest search marked `outcome` (added when a pick from before `tried` existed has none). */
function settle(pick: MusicPick, outcome: MusicPickTry['outcome']): MusicPick {
  const tried = [...(pick.tried ?? [])]
  const last = tried.at(-1)
  if (last && (last.outcome === 'searching' || (outcome === 'import_failed' && last.outcome === 'chosen')))
    tried[tried.length - 1] = { ...last, outcome }
  else tried.push({ query: pick.query ?? DEFAULT_QUERY, outcome })
  return { ...pick, tried: tried.slice(-MAX_QUERIES) }
}

/** Searches that failed in a row at the end of the list. */
const failedInARow = (tried: MusicPickTry[]) => {
  let n = 0
  for (let i = tried.length - 1; i >= 0 && tried[i]?.outcome === 'failed'; i--) n++
  return n
}

/**
 * One step of a pick: looks at its jobs and moves it on as far as it can now. Returns the pick to persist; picked and
 * skipped are final (start the run). Openverse is only reached through background jobs, so a step is quick.
 */
export async function advanceMusicPick(deps: Deps, a: AttemptRow): Promise<MusicPick> {
  const now = deps.clock.now()
  let pick = normalized(a.musicPick ?? newMusicPick(now))
  if (pick.status === 'picked' || pick.status === 'skipped') return pick
  const skip = (reason: string): MusicPick => {
    deps.log.info('music.skipped', { attemptId: a.id, reason, tried: pick.tried?.length ?? 0 })
    return { ...pick, status: 'skipped', reason, endedAt: deps.clock.now().toISOString() }
  }
  const overBudget = () =>
    deps.clock.now().getTime() - new Date(pick.startedAt).getTime() > MUSIC_PICK_BUDGET_MS
  const version = await deps.store.getVersion(a.jobId, a.versionN)
  if (!version) return skip('The version is gone.')
  const seconds = targetSeconds(version)
  const text = requestText(version)
  // No Openverse track in time: the best audio already in the library, else none.
  const fromLibrary = async (why: string): Promise<MusicPick> => {
    const queries = (pick.tried ?? []).map((t) => t.query)
    const m = await libraryTrack(deps, version, moodWords(queries, text), seconds)
    if (!m) return skip(`${why} The library has no audio to use instead.`)
    deps.log.info('music.from_library', { attemptId: a.id, mediaId: m.id, why })
    const title = m.sourceTitle ?? m.caption ?? m.filename
    return {
      ...picked(pick, m.id, deps.clock.now()),
      source: 'library',
      title,
      openverseId: m.sourceId,
    }
  }
  if (overBudget()) return fromLibrary('Openverse found no track in time.')
  // Each pass either waits on a job, finishes, or moves to the next job or search.
  for (let pass = 0; pass < 3 * MAX_QUERIES; pass++) {
    if (pick.status === 'searching') {
      if (!pick.query) pick = { ...pick, ...(await musicQuery(deps, version, seconds)) }
      if (!pick.searchJobId) {
        const tried = pick.tried ?? []
        const plan = queryPlan(tried[0]?.query ?? pick.query ?? DEFAULT_QUERY, pick.fallbackQuery, text)
        const q = plan[tried.length]
        if (!q) return fromLibrary('Openverse had no track that fits.')
        if (overBudget()) return fromLibrary('Openverse found no track in time.')
        const req = searchRequest({ q, license: 'cc0,by', category: 'music' })
        const params = {
          q,
          license: 'cc0,by',
          category: 'music',
          page: 1,
          attemptId: a.id,
          retries: PICK_SEARCH_RETRIES,
        }
        const job = await queueOpenverseJob(deps, version.authorId, 'search', req.key, params)
        deps.log.info('music.search', { attemptId: a.id, query: q, n: tried.length + 1 })
        pick = {
          ...pick,
          query: q,
          usedFallback: tried.length > 0,
          searchJobId: job.id,
          tried: [...tried, { query: q, outcome: 'searching' as const }],
        }
      }
      const job = await deps.store.getOpenverseJob(pick.searchJobId ?? '')
      if (job && (job.status === 'queued' || job.status === 'running')) return pick
      const track =
        job?.status === 'done' ? chooseTrack((job.result as SearchPage | null)?.items ?? [], seconds) : null
      if (!track) {
        pick = { ...settle(pick, job?.status === 'done' ? 'empty' : 'failed'), searchJobId: null }
        deps.log.info('music.search_missed', {
          attemptId: a.id,
          query: pick.query,
          error: job?.status === 'done' ? null : (job?.error?.message ?? 'lost'),
        })
        if (failedInARow(pick.tried ?? []) >= DOWN_AFTER_FAILURES)
          return fromLibrary("Openverse isn't answering.")
        continue
      }
      pick = { ...settle(pick, 'chosen'), openverseId: track.id, title: track.title }
      const existing = await importedTrack(deps, track.id)
      if (existing) return picked(pick, existing.id, deps.clock.now())
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
      const mediaId = job?.status === 'done' ? (job.result as { mediaId?: string } | null)?.mediaId : null
      const m = mediaId ? await deps.store.getMedia(mediaId) : null
      if (m && !m.deletedAt && m.status === 'ready') return picked(pick, m.id, deps.clock.now())
      // The track couldn't be imported: search on with the next words.
      deps.log.info('music.import_failed', { attemptId: a.id, error: job?.error?.message ?? 'gone' })
      pick = {
        ...settle(pick, 'import_failed'),
        status: 'searching',
        searchJobId: null,
        importJobId: null,
        openverseId: null,
        title: null,
      }
      continue
    }
    return pick
  }
  return pick
}

function picked(pick: MusicPick, mediaId: string, now: Date): MusicPick {
  return {
    ...pick,
    status: 'picked',
    source: pick.source ?? 'openverse',
    mediaId,
    reason: null,
    endedAt: now.toISOString(),
  }
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
  return {
    status: p.status,
    query: p.query,
    title: p.title,
    mediaId: p.mediaId,
    reason: p.reason,
    source: p.status === 'picked' ? (p.source ?? 'openverse') : null,
    tried: (p.tried ?? []).map((t) => ({ query: t.query, outcome: t.outcome })),
  }
}
