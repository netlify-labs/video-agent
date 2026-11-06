// Live progress for the latest version (plan v2 §6 A1, §14 rules 3, 28). A pure read: it never changes attempt
// rows (the reconciler owns those). While a run is going, the runner snapshot is read at most every 5 s per run,
// through a cache entry in the internal Blobs store that every function instance shares. When the runner can't be
// reached, the last known value comes back marked stale.
import type { Deps } from '../deps.js'
import { decrypt } from '../lib/crypto.js'
import { redactSecrets, stepText } from '../lib/run-text.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import type { AttemptRow, Stage } from './types.js'
import { loadJob } from './videos.js'
import { musicPickDto } from './music-pick.js'

export const SNAPSHOT_EVERY_MS = 5_000
/** One instance fetches while the others keep serving the cache. */
const FETCH_LEASE_MS = 5_000

export interface Progress {
  attemptId: string | null
  versionN: number | null
  stage: Stage | null
  /** The agent's own step text, e.g. "Writing the end card". */
  step: string | null
  steps: number | null
  credits: number | null
  /** The music the server is picking before the run (src/domain/music-pick.ts). */
  music: ReturnType<typeof musicPickDto>
  /** When the runner was last read for this value (null when it comes from stored rows). */
  observedAt: string | null
  stale: boolean
  /** The latest milestone the run posted itself (plan v2 §6 A2). */
  checkpoint: {
    seq: number
    message: string | null
    renderPercent: number | null
    at: string
    hasBundle: boolean
  } | null
}

interface CacheEntry {
  observedAt: number
  fetchingUntil: number
  step: string | null
  steps: number | null
  credits: number | null
}

export const progressKey = (attemptId: string) => `progress/${attemptId}.json`

function fromRow(a: AttemptRow, stale: boolean): Progress {
  return {
    attemptId: a.id,
    versionN: a.versionN,
    stage: a.stage,
    step: stepText(a.latestStep),
    steps: a.usage?.stepsCount ?? null,
    credits: a.usage?.totalCreditsCost ?? null,
    music: musicPickDto(a.musicPick),
    observedAt: null,
    stale,
    checkpoint: null,
  }
}

function fromCache(a: AttemptRow, c: CacheEntry, stale: boolean): Progress {
  return {
    attemptId: a.id,
    versionN: a.versionN,
    stage: a.stage,
    step: stepText(c.step ?? a.latestStep),
    steps: c.steps ?? a.usage?.stepsCount ?? null,
    credits: c.credits ?? a.usage?.totalCreditsCost ?? null,
    music: musicPickDto(a.musicPick),
    observedAt: new Date(c.observedAt).toISOString(),
    stale,
    checkpoint: null,
  }
}

async function readCache(deps: Deps, attemptId: string): Promise<CacheEntry | null> {
  try {
    const raw = await deps.blobs.get('internal', progressKey(attemptId))
    return raw ? (JSON.parse(new TextDecoder().decode(raw)) as CacheEntry) : null
  } catch (e) {
    // The live snapshot stands in; a failing store shows up here.
    deps.log.warn('progress.cache_unreadable', { attemptId, error: e })
    return null
  }
}

export async function getProgress(deps: Deps, p: Principal, jobId: string): Promise<Progress> {
  const base = await snapshotProgress(deps, p, jobId)
  if (!base.attemptId) return base
  const c = await deps.store.getCheckpoint(base.attemptId)
  return {
    ...base,
    checkpoint: c
      ? {
          seq: c.seq,
          message: c.message === null ? null : redactSecrets(c.message),
          renderPercent: c.renderPercent,
          at: c.createdAt,
          hasBundle: c.bundleKey !== null,
        }
      : null,
  }
}

async function snapshotProgress(deps: Deps, p: Principal, jobId: string): Promise<Progress> {
  const job = await loadJob(deps.store, p, jobId)
  assertCan(p, 'video:read')
  // The newest attempt of the latest version: a retry is a new attempt with its own cache entry.
  const a = (await deps.store.listAttempts(jobId))
    .filter((x) => x.versionN === job.latestVersion)
    .sort((x, y) => y.queuedAt.localeCompare(x.queuedAt))[0]
  if (!a)
    return {
      attemptId: null,
      versionN: null,
      stage: null,
      step: null,
      steps: null,
      credits: null,
      music: null,
      observedAt: null,
      stale: false,
      checkpoint: null,
    }
  // Queued, starting, finishing and finished runs: the stored rows are the truth.
  if (a.stage !== 'running' || !a.handleEnc) return fromRow(a, false)

  const now = deps.clock.now().getTime()
  const cached = await readCache(deps, a.id)
  if (cached && now - cached.observedAt < SNAPSHOT_EVERY_MS) return fromCache(a, cached, false)
  // Another instance is fetching: serve what's cached (stale once it's a few rounds old, e.g. after a failure).
  if (cached && cached.fetchingUntil > now)
    return cached.observedAt > 0
      ? fromCache(a, cached, now - cached.observedAt > 3 * SNAPSHOT_EVERY_MS)
      : fromRow(a, false)

  const lease: CacheEntry = {
    observedAt: cached?.observedAt ?? 0,
    fetchingUntil: now + FETCH_LEASE_MS,
    step: cached?.step ?? a.latestStep,
    steps: cached?.steps ?? null,
    credits: cached?.credits ?? null,
  }
  try {
    await deps.blobs.set('internal', progressKey(a.id), JSON.stringify(lease))
    const handle = decrypt((await getSettings(deps)).dataEncryptionKey, a.handleEnc)
    const snap = await deps.runner.snapshot(handle)
    const entry: CacheEntry = {
      observedAt: deps.clock.now().getTime(),
      fetchingUntil: 0,
      step: snap.kind === 'running' ? (stepText(snap.latestStep) ?? lease.step) : lease.step,
      steps: snap.usage?.stepsCount ?? lease.steps,
      credits: snap.usage?.totalCreditsCost ?? lease.credits,
    }
    await deps.blobs.set('internal', progressKey(a.id), JSON.stringify(entry))
    return fromCache(a, entry, false)
  } catch (e) {
    deps.log.warn('progress.snapshot_failed', { attemptId: a.id, error: e })
    return cached && cached.observedAt > 0 ? fromCache(a, cached, true) : fromRow(a, true)
  }
}
