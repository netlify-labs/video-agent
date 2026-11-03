// Recorded voice-over takes (plan 2026-11-02 §1 goal 5, §2.7, §8): who may read one. A take is a media row with a
// narration role; it's private to its uploader (and admins) until it's used on a video, and then any Creator who can
// read that video can read it too, so teammates can re-cut the narration. Reviewers and Viewers never get raw takes.
// And who holds one: media_refs rows, written only through the functions below, inside the writer's transaction and
// after lockTakes, so GC (which takes the same locks) never deletes bytes something still references.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { creatorOrUp, type Principal } from './policy.js'
import type { MediaRefOwnerKind, MediaRow } from './types.js'
import { canSee } from './videos.js'

/** How long a take's bytes are kept once nothing references it. */
export const TAKE_RETAIN_MS = 30 * 24 * 3600_000

export const isTake = (m: Pick<MediaRow, 'role'>) => m.role !== null

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
