// Bounded cleanup in the sweep: delete every copy of tombstoned videos and reap abandoned uploads.
import type { Deps } from '../deps.js'

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
  return done
}
