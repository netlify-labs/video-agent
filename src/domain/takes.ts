// Recorded voice-over takes (plan 2026-11-02 §1 goal 5, §2.7, §8): who may read one. A take is a media row with a
// narration role; it's private to its uploader (and admins) until it's used on a video, and then any Creator who can
// read that video can read it too, so teammates can re-cut the narration. Reviewers and Viewers never get raw takes.
// And who holds one: media_refs rows, written only through the functions below, inside the writer's transaction and
// after lockTakes, so GC (which takes the same locks) never deletes bytes something still references. And GC itself,
// in two phases: a tombstone and a deletion work item in one transaction, then the bytes outside it, with retries.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { isTakeRole } from './media-roles.js'
import { assertCan, creatorOrUp, type Principal } from './policy.js'
import type { CleanupRow, MediaRefOwnerKind, MediaRow } from './types.js'
import { canSee } from './videos.js'

/** How long a take's bytes are kept once nothing references it (or, if nothing ever did, after it was made). */
export const TAKE_RETAIN_MS = 30 * 24 * 3600_000
/** A narration lock is free once its heartbeat is this old (plan 2026-11-02 §2.7). */
export const NARRATION_LOCK_STALE_MS = 2 * 60_000

/**
 * Everything a take stores is under `<media id>/` in the media store, so one deletion work item covers it all: the
 * original and meta.json (storeMedia), peaks.bin, and cached transcripts under `<media id>/transcripts/`.
 */
export const takePrefix = (mediaId: string) => `${mediaId}/`
export const takePeaksKey = (mediaId: string) => `${mediaId}/peaks.bin`
export const takeTranscriptPrefix = (mediaId: string) => `${mediaId}/transcripts/`

/** A narration take (recorded or uploaded voice-over). Other roles, such as screen recordings, are not takes. */
export const isTake = (m: Pick<MediaRow, 'role'>) => isTakeRole(m.role)

/**
 * The one take-read predicate, used on every path that can expose a take: loadMedia and signed links (mediaDto),
 * library listing and search, the duplicate check and upload finalization. The narration op's resolution and the
 * render snapshot (later beads) must call it too for every new pick. Items that aren't takes keep the library's
 * rules and pass. Callers turn a false into not_found, never forbidden, so a take's existence doesn't leak.
 *
 * Used means a media_refs row puts the take in a version of a video the reader can see, or in a draft of that video
 * written by the take's uploader (someone else's draft doesn't share it). A frozen render attempt doesn't count: its
 * version will. "Can see" is the video's own rule, so private videos stay private.
 */
export async function canReadTake(repo: Repo, p: Principal, m: MediaRow): Promise<boolean> {
  // Only takes are private to their uploader; every other item reads like the library.
  if (!isTake(m) || m.uploaderId === p.userId || p.role === 'admin') return true
  if (!creatorOrUp(p.role)) return false
  for (const r of await repo.listMediaRefsByMedia([m.id])) {
    if (r.ownerKind === 'frozen_attempt') continue
    if (r.ownerKind === 'draft') {
      const e = await repo.getEdit(r.ownerId)
      if (!e || e.authorId !== m.uploaderId || e.jobId !== r.jobId) continue
    }
    const job = await repo.getJob(r.jobId)
    if (job && !job.deletedAt && canSee(p, job)) return true
  }
  return false
}

/** Where a take is used, as one reader may know it: a version of a video they can see, or a draft of their own. */
export type TakeUse =
  { kind: 'version'; videoId: string; n: number } | { kind: 'draft'; videoId: string; draftId: string }

/**
 * A take's recording facts for the library (plan 2026-11-02 §2.3, §6.1): its role, the video it was made for (when
 * the reader can see it), where the reader can see it used, and until when its bytes are kept (null while anything
 * references it, the reader's or not, since then nothing will delete it). Frozen attempts aren't listed: their
 * version will be. Call only for a take the reader may read.
 */
export async function recordingDto(repo: Repo, p: Principal, m: MediaRow) {
  const refs = await repo.listMediaRefsByMedia([m.id])
  const visible = new Map<string, boolean>()
  const sees = async (jobId: string) => {
    if (!visible.has(jobId)) {
      const job = await repo.getJob(jobId)
      visible.set(jobId, !!job && !job.deletedAt && canSee(p, job))
    }
    return visible.get(jobId) ?? false
  }
  const usedIn: TakeUse[] = []
  for (const r of refs) {
    if (r.ownerKind === 'frozen_attempt' || !(await sees(r.jobId))) continue
    if (r.ownerKind === 'version') {
      const n = Number(r.ownerId.slice(r.ownerId.lastIndexOf('#') + 1))
      if (Number.isInteger(n) && n > 0) usedIn.push({ kind: 'version', videoId: r.jobId, n })
    } else {
      const e = await repo.getEdit(r.ownerId)
      if (e && e.authorId === p.userId && e.jobId === r.jobId)
        usedIn.push({ kind: 'draft', videoId: r.jobId, draftId: e.id })
    }
  }
  const retainUntil = refs.length
    ? null
    : (m.retainUntil ?? new Date(new Date(m.createdAt).getTime() + TAKE_RETAIN_MS).toISOString())
  return {
    role: m.role ?? 'narration-take',
    videoId: m.scopeJobId && (await sees(m.scopeJobId)) ? m.scopeJobId : null,
    usedIn,
    retainUntil,
  }
}

/** The rows the principal may read, in order (takes they can't read are dropped). */
export async function readableMedia(repo: Repo, p: Principal, rows: MediaRow[]) {
  const ok = await Promise.all(rows.map((m) => canReadTake(repo, p, m)))
  return rows.filter((_, i) => ok[i])
}

/**
 * The take-row lock protocol (plan 2026-11-02 §8): every reference writer and GC lock the media rows involved with
 * SELECT … FOR UPDATE, in media-id order (so two writers can't deadlock), inside their transaction. A row GC has
 * begun deleting (or that's gone) can't be referenced again: 409 take_deleted. Call inside `store.tx`.
 */
export async function lockTakes(repo: Repo, mediaIds: string[], live: string[] = mediaIds) {
  const rows = await repo.lockMedia([...new Set(mediaIds)].sort())
  const gone = [...new Set(live)].filter((id) => !rows.some((m) => m.id === id && !m.deletingAt))
  if (gone.length)
    throw new ApiError('take_deleted', 'A recording this uses was deleted. Record or pick another take.', {
      mediaIds: gone,
    })
  return rows
}

/** Bumps retain_until on the (locked) takes no reference holds any more: their 30 days start now. */
async function retainReleased(repo: Repo, deps: Pick<Deps, 'clock'>, locked: MediaRow[]) {
  if (!locked.length) return
  const held = new Set((await repo.listMediaRefsByMedia(locked.map((m) => m.id))).map((r) => r.mediaId))
  const until = new Date(deps.clock.now().getTime() + TAKE_RETAIN_MS).toISOString()
  for (const m of locked)
    // Take retention only; other roles keep their own rules.
    if (isTake(m) && !held.has(m.id)) await repo.updateMedia(m.id, { retainUntil: until })
}

const refRows = (
  deps: Pick<Deps, 'clock'>,
  mediaIds: string[],
  ownerKind: MediaRefOwnerKind,
  ownerId: string,
  jobId: string,
) => {
  const createdAt = deps.clock.now().toISOString()
  return [...new Set(mediaIds)].map((mediaId) => ({ mediaId, ownerKind, ownerId, jobId, createdAt }))
}

/** A draft's references become exactly these takes (each narration save sends the whole track). */
export async function replaceDraftRefs(
  repo: Repo,
  deps: Pick<Deps, 'clock'>,
  editId: string,
  jobId: string,
  mediaIds: string[],
) {
  const next = new Set(mediaIds)
  const before = (await repo.listMediaRefsByOwner('draft', editId)).map((r) => r.mediaId)
  const dropped = before.filter((id) => !next.has(id))
  // One lock call for both sets keeps the media-id order across all of them; only the kept ones must be live.
  const rows = await lockTakes(repo, [...next, ...dropped], [...next])
  await repo.deleteMediaRefs('draft', editId, dropped)
  await repo.insertMediaRefs(
    refRows(
      deps,
      [...next].filter((id) => !before.includes(id)),
      'draft',
      editId,
      jobId,
    ),
  )
  await retainReleased(
    repo,
    deps,
    rows.filter((m) => dropped.includes(m.id)),
  )
}

/** A render freezes its takes: the attempt holds them until its version does (or it's released). */
export async function addAttemptRefs(
  repo: Repo,
  deps: Pick<Deps, 'clock'>,
  attemptId: string,
  jobId: string,
  mediaIds: string[],
) {
  await lockTakes(repo, mediaIds)
  await repo.insertMediaRefs(refRows(deps, mediaIds, 'frozen_attempt', attemptId, jobId))
}

/** On finalize, a frozen attempt's references become its version's (`<job>#<n>`). */
export async function promoteAttemptRefs(
  repo: Repo,
  deps: Pick<Deps, 'clock'>,
  attemptId: string,
  versionOwnerId: string,
) {
  const refs = await repo.listMediaRefsByOwner('frozen_attempt', attemptId)
  if (!refs.length) return
  // Held by the attempt, so GC can't have started on them; the lock still orders this against it.
  await repo.lockMedia(refs.map((r) => r.mediaId).sort())
  const createdAt = deps.clock.now().toISOString()
  await repo.insertMediaRefs(
    refs.map((r) => ({
      mediaId: r.mediaId,
      ownerKind: 'version',
      ownerId: versionOwnerId,
      jobId: r.jobId,
      createdAt,
    })),
  )
  await repo.deleteMediaRefs('frozen_attempt', attemptId)
}

/** Drops every reference an owner holds (a discarded or expired draft, a deleted version); returns the media ids. */
export async function releaseOwnerRefs(
  repo: Repo,
  deps: Pick<Deps, 'clock'>,
  ownerKind: MediaRefOwnerKind,
  ownerId: string,
) {
  const ids = (await repo.listMediaRefsByOwner(ownerKind, ownerId)).map((r) => r.mediaId)
  if (!ids.length) return []
  const locked = await repo.lockMedia([...ids].sort())
  await repo.deleteMediaRefs(ownerKind, ownerId)
  await retainReleased(repo, deps, locked)
  return ids
}

const GC_BATCH = 20
// A failed byte deletion is retried after as long as it has been failing (so the waits double), within these bounds.
const RETRY_MIN_MS = 60_000
const RETRY_MAX_MS = 6 * 3600_000
/** How long "Delete unused recordings" deletes bytes before leaving the rest to the sweep. */
const DELETE_NOW_MS = 10_000

type GcReason = 'retention' | 'user'

/** Unreferenced takes whose retention passed, as of `now`. */
const due = (now: Date) => ({
  now: now.toISOString(),
  createdBefore: new Date(now.getTime() - TAKE_RETAIN_MS).toISOString(),
})

/**
 * GC's first phase, in one transaction: under the take's row lock, re-check that nothing references it (and, for
 * retention, that its time passed: a release may have just bumped it), then the tombstone and its deletion work
 * item. Returns the work item, or null when the take is kept.
 */
async function tombstoneTake(deps: Deps, mediaId: string, reason: GcReason): Promise<CleanupRow | null> {
  return deps.store.tx(async (repo) => {
    const [m] = await repo.lockMedia([mediaId])
    // Takes GC only removes takes.
    if (!m || !isTake(m) || m.deletingAt) return null
    if ((await repo.listMediaRefsByMedia([m.id])).length) return null
    const now = deps.clock.now()
    const d = due(now)
    if (reason === 'retention' && !(m.retainUntil ? m.retainUntil <= d.now : m.createdAt <= d.createdBefore))
      return null
    const at = now.toISOString()
    const item: CleanupRow = {
      id: deps.ids.uuid(),
      kind: 'delete_take',
      store: 'media',
      prefix: takePrefix(m.id),
      nextActionAt: at,
      doneAt: null,
    }
    await repo.updateMedia(m.id, { deletingAt: at, updatedAt: at })
    await repo.insertCleanup(item)
    deps.log.info('take.gc_started', { mediaId: m.id, reason })
    return item
  })
}

/**
 * GC's second phase, outside any transaction: the take's bytes go, then the row is marked deleted and the work item
 * done. A failure leaves the item due again later (the sweep retries it); returns whether it finished.
 */
export async function deleteTakeBytes(deps: Deps, c: CleanupRow): Promise<boolean> {
  const mediaId = c.prefix.slice(0, -1)
  const started = Date.now()
  try {
    for (const k of await deps.blobs.list(c.store, c.prefix)) await deps.blobs.delete(c.store, k)
  } catch (e) {
    const now = deps.clock.now().getTime()
    const since = Date.parse((await deps.store.getMedia(mediaId))?.deletingAt ?? '') || now
    const wait = Math.min(Math.max(now - since, RETRY_MIN_MS), RETRY_MAX_MS)
    deps.log.warn('take.delete_failed', { mediaId, retryInMs: wait, error: e })
    await deps.store.updateCleanup(c.id, { nextActionAt: new Date(now + wait).toISOString() })
    return false
  }
  await deps.store.tx(async (repo) => {
    const at = deps.clock.now().toISOString()
    const m = await repo.getMedia(mediaId)
    if (m) await repo.updateMedia(mediaId, { deletedAt: m.deletedAt ?? at, updatedAt: at })
    await repo.updateCleanup(c.id, { doneAt: at })
  })
  deps.log.info('take.deleted', { mediaId, ms: Date.now() - started })
  return true
}

/**
 * Sweep step, bounded per tick: unreferenced takes past their retention are deleted (both phases), and narration
 * locks without a heartbeat for two minutes are reaped. Retries of failed deletions run with the cleanup items.
 */
export async function sweepTakes(deps: Deps, budget: { deadline: number }, limit = GC_BATCH) {
  const now = deps.clock.now()
  let deleted = 0
  for (const m of await deps.store.listUnreferencedTakes({ due: due(now), limit })) {
    if (Date.now() > budget.deadline) break
    const item = await tombstoneTake(deps, m.id, 'retention')
    if (item && (await deleteTakeBytes(deps, item))) deleted++
  }
  const locks = await deps.store.deleteStaleNarrationLocks(
    new Date(now.getTime() - NARRATION_LOCK_STALE_MS).toISOString(),
  )
  if (locks) deps.log.info('narration.locks_reaped', { count: locks })
  return deleted
}

/**
 * "Delete unused recordings": the caller's own takes that nothing references go now, through the same two phases
 * as GC (not by shortening their retention), so they're gone from the list at once. Bytes that can't be deleted
 * within the request are left to the sweep. Anyone may clear their own recordings, whatever their role now.
 */
export async function deleteUnusedRecordings(deps: Deps, p: Principal) {
  assertCan(p, 'video:read')
  const started = Date.now()
  const items: CleanupRow[] = []
  for (const m of await deps.store.listUnreferencedTakes({ uploaderId: p.userId, limit: 500 })) {
    const item = await tombstoneTake(deps, m.id, 'user')
    if (item) items.push(item)
  }
  for (const item of items) {
    if (Date.now() - started > DELETE_NOW_MS) break
    await deleteTakeBytes(deps, item)
  }
  return { deleted: items.length }
}
