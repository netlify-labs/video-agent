// Bounded cleanup in the sweep: delete every copy of tombstoned videos, reap abandoned uploads and old Openverse jobs,
// delete unused narration takes (two-phase GC, takes.ts) and retry caption revisions' mirror updates (captions.ts).
import { CLIENT_IDLE_MS } from '../auth/oauth.js'
import type { Deps } from '../deps.js'
import { runCaptionsSync } from './captions.js'
import { deleteExpiredEdits } from './edits.js'
import { sweepUploads } from './media-uploads.js'
import { sweepOpenverseJobs } from './openverse-jobs.js'
import { deleteTakeBytes, sweepTakes } from './takes.js'

export async function runCleanup(
  deps: Deps,
  budget: { deadline: number; maxItems: number },
): Promise<number> {
  const now = deps.clock.now()
  let done = 0
  for (const c of await deps.store.listDueCleanup(now.toISOString(), budget.maxItems)) {
    if (Date.now() > budget.deadline) break
    // A take's bytes also mark its row deleted, and retry with their own backoff.
    if (c.kind === 'delete_take') {
      if (await deleteTakeBytes(deps, c)) done++
      continue
    }
    // A caption revision's publication mirror update (captions.ts), retried until it's applied or moot.
    if (c.kind === 'sync_captions') {
      if (await runCaptionsSync(deps, c)) done++
      continue
    }
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
  await sweepOpenverseJobs(deps)
  await sweepTakes(deps, budget)
  return done
}
