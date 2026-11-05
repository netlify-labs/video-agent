// Removing a destination publication from any state (publish destinations §2.4): unpublish, delete the video,
// remove a destination everywhere. A removal writes its own minimal manifest first and never needs the video's bytes
// or a Video DTO, so deleteVideo can queue its byte cleanup in the same transaction.
import type { Deps } from '../../deps.js'
import { ApiError } from '../../lib/errors.js'
import type { Repo } from '../../store/types.js'
import { assertCan, type Principal } from '../policy.js'
import type { DestinationPublicationRow } from '../types.js'
import { loadJob } from '../videos.js'
import { buildRemoveManifest } from './manifest.js'
import { dispatch, publicationDtoById } from './publish.js'
import { emitTerminal } from './run.js'

export const REMOVE_DEADLINE_MS = 7 * 24 * 3600_000

/**
 * Turns a publication towards removed, in the caller's transaction. Returns true when a removal operation was
 * started (the caller dispatches it after commit); false when it was already removed or ended at once.
 */
export async function startRemoval(
  repo: Repo,
  deps: Deps,
  p: DestinationPublicationRow,
  options: Record<string, unknown> = {},
): Promise<boolean> {
  if (p.desired === 'removed') return false
  const now = deps.clock.now().toISOString()
  // Nothing has been sent yet (no worker ever claimed it): it ends here.
  const untouched =
    p.status === 'queued' &&
    p.leaseFence === 0 &&
    p.attempts === 0 &&
    p.generation === 1 &&
    !p.stateEnc &&
    !p.externalId
  if (untouched) {
    const patch = {
      desired: 'removed' as const,
      status: 'removed' as const,
      removedAt: now,
      updatedAt: now,
      nextRunAt: null,
      leaseUntil: null,
    }
    await repo.updateDestinationPublication(p.id, patch)
    await emitTerminal(repo, deps, { ...p, ...patch })
    return false
  }
  await repo.updateDestinationPublication(p.id, {
    desired: 'removed',
    generation: p.generation + 1,
    operation: 'remove',
    status: 'removing',
    manifest: buildRemoveManifest(p),
    options: { ...p.options, ...(Object.keys(options).length ? { remove: options } : {}) },
    attempts: 0,
    error: null,
    message: null,
    nextRunAt: now,
    deadlineAt: new Date(Date.parse(now) + REMOVE_DEADLINE_MS).toISOString(),
    // A running publish loses its fence at its next commit; a new worker can start the removal at once.
    leaseUntil: null,
    updatedAt: now,
  })
  deps.log.info('destination.remove', { id: p.id, kind: p.kind, from: p.status })
  return true
}

export async function unpublishFromDestination(
  deps: Deps,
  principal: Principal,
  id: string,
  options: Record<string, unknown> = {},
) {
  const started = await deps.store.tx(async (repo) => {
    const p = await repo.getDestinationPublication(id, { lock: true })
    if (!p) throw new ApiError('not_found', 'Not found.')
    const job = await loadJob(repo, principal, p.jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    return startRemoval(repo, deps, p, options)
  })
  if (started) await dispatch(deps, id)
  return publicationDtoById(deps, id)
}

/** Every active publication of a deleted video, inside deleteVideo's transaction (the sweep dispatches them). */
export async function removeAllForJob(repo: Repo, deps: Deps, jobId: string): Promise<string[]> {
  const out: string[] = []
  for (const p of await repo.listDestinationPublications(jobId)) {
    if (await startRemoval(repo, deps, p)) out.push(p.id)
  }
  return out
}

/** An admin's "Remove from everywhere" for one destination. */
export async function removeDestinationEverywhere(deps: Deps, principal: Principal, destinationId: string) {
  assertCan(principal, 'settings:manage')
  const ids = await deps.store.tx(async (repo) => {
    const out: string[] = []
    for (const p of await repo.listDestinationPublicationsFor(destinationId)) {
      const locked = await repo.getDestinationPublication(p.id, { lock: true })
      if (locked && (await startRemoval(repo, deps, locked))) out.push(p.id)
    }
    return out
  })
  for (const id of ids) await dispatch(deps, id)
  return { removing: ids.length }
}
