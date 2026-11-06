// Screen recordings are big, so unused ones go away like narration takes (screen-recording plan §9; README
// "Retention"): 30 days after upload when no video ever used one, or 30 days after the last video using it was
// deleted. The sweep starts that clock the first time it sees a recording whose videos are all deleted, then
// deletes it with the takes' two phases (tombstone under the row lock, then the bytes under `<id>/`, trace included).
// A create that uses a recording locks the same rows first (lockRecordings), so GC and a new use never both win.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { assertCan, type Principal } from './policy.js'
import { deleteTakeBytes, takePrefix, tombstoneUnusedTakes } from './takes.js'
import type { Repo } from '../store/types.js'
import type { CleanupRow, MediaRow } from './types.js'

export const RECORDING_RETAIN_MS = 30 * 24 * 3600_000
const GC_BATCH = 20
/** How long "Delete unused recordings" deletes bytes in the request; the rest is left to the sweep. */
const DELETE_NOW_MS = 10_000

/**
 * Locks the recordings a write is about to use, in media-id order (the take protocol), and refuses one GC has begun
 * deleting or that's gone: 410 gone. Call inside `store.tx`.
 */
export async function lockRecordings(repo: Repo, mediaIds: string[]): Promise<MediaRow[]> {
  const rows = await repo.lockMedia([...new Set(mediaIds)].sort())
  for (const id of mediaIds) {
    const m = rows.find((r) => r.id === id)
    if (!m || m.deletedAt || m.deletingAt)
      throw new ApiError('gone', 'A screen recording this uses was deleted.')
  }
  return rows
}

/** When an unused recording may be deleted: its clock if started, else upload + 30 days if it was never used. */
const dueAt = (m: MediaRow, everUsed: boolean) =>
  m.retainUntil ?? (everUsed ? null : new Date(Date.parse(m.createdAt) + RECORDING_RETAIN_MS).toISOString())

/**
 * GC's first phase for one recording, in one transaction: under the row lock, re-check that no undeleted video uses
 * it and that its clock wasn't moved later (the sweep found it due), then the tombstone and its deletion work item.
 * Null when it's kept.
 */
async function tombstoneRecording(deps: Deps, mediaId: string, reason: 'retention' | 'user') {
  return deps.store.tx(async (repo): Promise<CleanupRow | null> => {
    const [m] = await repo.lockMedia([mediaId])
    if (!m || m.role !== 'screen-recording' || m.deletingAt || m.deletedAt) return null
    // A create may have used it since the sweep looked, or moved its clock.
    if ((await repo.jobsUsingMedia(m.id)).length) return null
    const at = deps.clock.now().toISOString()
    if (reason === 'retention' && m.retainUntil !== null && m.retainUntil > at) return null
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
    deps.log.info('recording.gc_started', { mediaId: m.id, reason })
    return item
  })
}

/** Sweep step: start the clock on recordings whose videos were all deleted, and delete those that are due. */
export async function sweepRecordings(deps: Deps, budget: { deadline: number }, limit = GC_BATCH) {
  const now = deps.clock.now().toISOString()
  let deleted = 0
  for (const { row: m, everUsed } of await deps.store.listUnusedRecordings({ limit: 200 })) {
    if (Date.now() > budget.deadline || deleted >= limit) break
    const due = dueAt(m, everUsed)
    if (due === null) {
      const until = new Date(deps.clock.now().getTime() + RECORDING_RETAIN_MS).toISOString()
      await deps.store.updateMedia(m.id, { retainUntil: until })
      deps.log.info('recording.retention', {
        mediaId: m.id,
        role: m.role,
        retainUntil: until,
        action: 'clock_started',
      })
      continue
    }
    if (due > now) {
      deps.log.info('recording.retention', { mediaId: m.id, role: m.role, retainUntil: due, action: 'kept' })
      continue
    }
    const item = await tombstoneRecording(deps, m.id, 'retention')
    deps.log.info('recording.retention', {
      mediaId: m.id,
      role: m.role,
      retainUntil: due,
      action: item ? 'deleted' : 'skipped',
    })
    if (item && (await deleteTakeBytes(deps, item))) deleted++
  }
  return deleted
}

/**
 * "Delete unused recordings": the caller's unused narration takes and screen recordings go now, through the same two
 * phases as GC. Bytes that can't be deleted within the request are left to the sweep.
 */
export async function deleteUnusedRecordings(deps: Deps, p: Principal) {
  assertCan(p, 'video:read')
  const started = Date.now()
  const items = [...(await tombstoneUnusedTakes(deps, p.userId))]
  for (const { row } of await deps.store.listUnusedRecordings({ uploaderId: p.userId, limit: 500 })) {
    const item = await tombstoneRecording(deps, row.id, 'user')
    if (item) items.push(item)
  }
  for (const item of items) {
    if (Date.now() - started > DELETE_NOW_MS) break
    await deleteTakeBytes(deps, item)
  }
  return { deleted: items.length }
}
