// What a publisher does besides publishing (publish destinations §3.4, §3.5): list a destination's targets for a
// video, and reveal a one-time secret, once.
import type { Deps } from '../../deps.js'
import { decrypt } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { assertCan, type Principal } from '../policy.js'
import { getSettings } from '../settings.js'
import { loadJob } from '../videos.js'
import { fetchTargets } from './http-kind.js'
import { loadDestination } from './registry.js'

export async function listDestinationTargets(
  deps: Deps,
  principal: Principal,
  destId: string,
  videoId: string,
) {
  const job = await loadJob(deps.store, principal, videoId)
  assertCan(principal, 'video:publish', { ownerId: job.ownerId })
  const d = await loadDestination(deps, deps.store, destId)
  if (!d) throw new ApiError('not_found', 'Destination not found.')
  if (!d.row?.enabled || !d.row.capabilities.targets)
    return { targets: [], dropped: 0, noun: null, error: null }
  const me = await deps.store.getUser(principal.userId)
  const r = await fetchTargets(
    deps,
    d.row,
    { id: principal.userId, name: me?.name ?? null, email: me?.email ?? '' },
    { id: job.id, title: job.title },
  )
  deps.log.info('destination.targets', {
    id: d.id,
    count: r.targets.length,
    dropped: r.dropped,
    error: r.error,
  })
  return { ...r, noun: d.row.capabilities.targetNoun ?? null }
}

export async function revealDestinationSecret(deps: Deps, principal: Principal, id: string) {
  const p = await deps.store.getDestinationPublication(id)
  if (!p) throw new ApiError('not_found', 'Not found.')
  // Only the publisher, and only while they can still see the video.
  await loadJob(deps.store, principal, p.jobId)
  if (p.publishedBy !== principal.userId) throw new ApiError('not_found', 'Not found.')
  const got = await deps.store.consumeSecretOnce(id, principal.userId, deps.clock.now().toISOString())
  if (!got) throw new ApiError('gone', 'This secret was already shown, or it expired.')
  const { dataEncryptionKey } = await getSettings(deps)
  deps.log.info('destination.secret_revealed', { id })
  return { label: got.label, value: decrypt(dataEncryptionKey, got.valueEnc) }
}
