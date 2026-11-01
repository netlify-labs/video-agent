// Bounded cleanup in the sweep: delete every copy of tombstoned videos and reap abandoned uploads.
import { CLIENT_IDLE_MS } from '../auth/oauth.js'
import type { Deps } from '../deps.js'
import { deleteExpiredEdits } from './edits.js'
import { sweepUploads } from './media-uploads.js'

export async function runCleanup(
  deps: Deps,
  budget: { deadline: number; maxItems: number },
): Promise<number> {
  const now = deps.clock.now()
  let done = 0
  for (const c of await deps.store.listDueCleanup(now.toISOString(), budget.maxItems)) {
    if (Date.now() > budget.deadline) break
    try {
      const keys = await deps.blobs.list(c.store, c.prefix)
      for (const k of keys) await deps.blobs.delete(c.store, k)
      await deps.store.updateCleanup(c.id, { doneAt: deps.clock.now().toISOString() })
      done++
    } catch (e) {
      deps.log.warn('cleanup.failed', { id: c.id, error: e })
      await deps.store.updateCleanup(c.id, {
        nextActionAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      })
    }
  }
  await deps.store.deleteExpiredIdempotency(now.toISOString())
  await deps.store.deleteExpiredPlans(now.toISOString())
  await deps.store.deleteExpiredOAuth(
    now.toISOString(),
    new Date(now.getTime() - CLIENT_IDLE_MS).toISOString(),
  )
  await deps.store.deleteExpiredSessions(now.toISOString())
  await deleteExpiredEdits(deps)
  await sweepUploads(deps)
  return done
}
