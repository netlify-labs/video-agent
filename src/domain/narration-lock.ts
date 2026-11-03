// The narration soft lock (plan 2026-11-02 §2.7, §6.1 narration_locks): one Creator at a time edits a video's
// narration. Opening the Narration track acquires the video's lock, the editor heartbeats it every 30 s and releases
// it on close; a lock whose heartbeat is 2 min old is free. Anyone else sees who holds it and can Take over, which
// moves it unconditionally: the previous holder's draft is kept (drafts are per author), and their next heartbeat or
// narration save is refused with 409 narration_locked naming who took over, so their editor can say so. The lock
// covers narration ops only; other edits save as before.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
import { NARRATION_LOCK_STALE_MS } from './takes.js'
import type { EditRow, NarrationLockRow } from './types.js'
import { loadJob } from './videos.js'

export interface LockHolder {
  userId: string
  name: string
  /** When they took the lock. */
  since: string
}

/** GET and every acquire: who holds the lock (null when it's free) and, for its holder, until when. */
export interface NarrationLockDto {
  videoId: string
  holder: LockHolder | null
  /** The caller holds it. */
  mine: boolean
  /** The holder's draft; only shown to the holder. */
  draftId: string | null
  heartbeatAt: string | null
  /** Free from then on without another heartbeat. */
  expiresAt: string | null
}

const live = (deps: Pick<Deps, 'clock'>, l: NarrationLockRow | null): l is NarrationLockRow =>
  !!l && Date.parse(l.heartbeatAt) > deps.clock.now().getTime() - NARRATION_LOCK_STALE_MS
const staleBefore = (deps: Pick<Deps, 'clock'>) =>
  new Date(deps.clock.now().getTime() - NARRATION_LOCK_STALE_MS).toISOString()

async function holderOf(repo: Repo, l: NarrationLockRow): Promise<LockHolder> {
  const u = await repo.getUser(l.holderId)
  return { userId: l.holderId, name: u?.name ?? u?.email ?? 'Someone', since: l.acquiredAt }
}

async function lockDto(
  deps: Pick<Deps, 'clock'>,
  repo: Repo,
  p: Principal,
  jobId: string,
  l: NarrationLockRow | null,
): Promise<NarrationLockDto> {
  if (!live(deps, l))
    return { videoId: jobId, holder: null, mine: false, draftId: null, heartbeatAt: null, expiresAt: null }
  const mine = l.holderId === p.userId
  return {
    videoId: jobId,
    holder: await holderOf(repo, l),
    mine,
    draftId: mine ? l.draftId : null,
    heartbeatAt: l.heartbeatAt,
    expiresAt: new Date(Date.parse(l.heartbeatAt) + NARRATION_LOCK_STALE_MS).toISOString(),
  }
}

/**
 * 409 narration_locked with who holds it. `takenOver`: the caller had it (a heartbeat, or a narration save, which
 * needs it), so the details also say who took over and when, for "Sam took over the narration".
 */
async function locked(repo: Repo, l: NarrationLockRow | null, takenOver: boolean) {
  const holder = l ? await holderOf(repo, l) : null
  const message = holder
    ? takenOver
      ? `${holder.name} took over the narration. Your draft is saved; you can render it or discard it.`
      : `${holder.name} is editing the narration.`
    : 'Open the narration again to edit it: your hold on it lapsed.'
  return new ApiError('narration_locked', message, {
    holder,
    ...(holder && takenOver
      ? { takenOverBy: { userId: holder.userId, name: holder.name }, at: holder.since }
      : {}),
  })
}

/** Creator+ on a video the caller can read; the job id is the lock's key. */
async function lockable(repo: Repo, p: Principal, jobId: string) {
  assertCan(p, 'edit:create')
  await loadJob(repo, p, jobId)
}

/** The caller's own open draft of this video, or 404 (someone else's draft doesn't exist to them). */
async function ownDraft(deps: Pick<Deps, 'clock'>, repo: Repo, p: Principal, jobId: string, draftId: string) {
  const e = await repo.getEdit(draftId)
  if (!e || e.authorId !== p.userId || e.jobId !== jobId || e.expiresAt < deps.clock.now().toISOString())
    throw new ApiError('not_found', 'Draft not found.')
}

export async function getNarrationLock(deps: Deps, p: Principal, jobId: string) {
  await lockable(deps.store, p, jobId)
  return lockDto(deps, deps.store, p, jobId, await deps.store.getNarrationLock(jobId))
}

/**
 * Acquire or heartbeat: one conditional upsert (free, stale, or already mine). Otherwise 409 narration_locked; with
 * `heartbeat` (the editor believed it held the lock) the 409 says it was taken over.
 */
export async function acquireNarrationLock(
  deps: Deps,
  p: Principal,
  jobId: string,
  input: { draftId: string; heartbeat?: boolean | undefined },
) {
  await lockable(deps.store, p, jobId)
  await ownDraft(deps, deps.store, p, jobId, input.draftId)
  const now = deps.clock.now().toISOString()
  const row = { jobId, holderId: p.userId, draftId: input.draftId, acquiredAt: now, heartbeatAt: now }
  const ok = await deps.store.acquireNarrationLock(row, staleBefore(deps))
  const l = await deps.store.getNarrationLock(jobId)
  if (!ok) {
    deps.log.info('narration_lock.refused', { jobId, userId: p.userId, holderId: l?.holderId ?? null })
    throw await locked(deps.store, l, input.heartbeat === true)
  }
  if (!input.heartbeat || l?.acquiredAt === now)
    deps.log.info('narration_lock.acquired', { jobId, userId: p.userId, draftId: input.draftId })
  return lockDto(deps, deps.store, p, jobId, l)
}

/** Releases the caller's lock; someone else's is left alone. */
export async function releaseNarrationLock(deps: Deps, p: Principal, jobId: string) {
  await lockable(deps.store, p, jobId)
  if (await deps.store.releaseNarrationLock(jobId, p.userId))
    deps.log.info('narration_lock.released', { jobId, userId: p.userId })
}

/** Moves the lock to the caller unconditionally; returns it and the previous (live) holder, if someone else. */
export async function takeOverNarrationLock(
  deps: Deps,
  p: Principal,
  jobId: string,
  input: { draftId: string },
) {
  return deps.store.tx(async (repo) => {
    await lockable(repo, p, jobId)
    await ownDraft(deps, repo, p, jobId, input.draftId)
    const was = await repo.getNarrationLock(jobId, { lock: true })
    const now = deps.clock.now().toISOString()
    const mine = was?.holderId === p.userId && live(deps, was)
    const row = {
      jobId,
      holderId: p.userId,
      draftId: input.draftId,
      acquiredAt: mine ? was.acquiredAt : now,
      heartbeatAt: now,
    }
    await repo.upsertNarrationLock(row)
    const previous = live(deps, was) && !mine ? await holderOf(repo, was) : null
    deps.log.info('narration_lock.taken_over', {
      jobId,
      userId: p.userId,
      previous: previous?.userId ?? null,
    })
    return { lock: await lockDto(deps, repo, p, jobId, row), previous }
  })
}

/**
 * saveEdit's check for a narration op (inside its transaction): the saver must hold the video's unexpired lock, else
 * 409 narration_locked (saying who took over, when someone did).
 */
export async function assertNarrationLock(deps: Pick<Deps, 'clock'>, repo: Repo, p: Principal, e: EditRow) {
  const l = await repo.getNarrationLock(e.jobId)
  if (live(deps, l) && l.holderId === p.userId) return
  throw await locked(repo, live(deps, l) ? l : null, true)
}
