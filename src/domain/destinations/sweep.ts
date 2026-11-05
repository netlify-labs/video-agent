// The sweep's part in publish destinations (§2.4): it never runs steps (it never moves bytes). It re-dispatches due
// rows whose lease has expired, at most once a minute each, fails rows past their deadline (including callback-only
// waiting rows), and clears one-time secrets nobody revealed in time.
import type { Deps } from '../../deps.js'
import { safeError } from './types.js'
import { emitTerminal } from './run.js'

const plus = (t: string, ms: number) => new Date(Date.parse(t) + ms).toISOString()

export async function duePublications(
  deps: Deps,
  budget: { deadline: number; maxItems: number },
): Promise<{ dispatched: number; expired: number; secretsCleared: number }> {
  const now = deps.clock.now().toISOString()
  const rows = await deps.store.listDueDestinationPublications(now, budget.maxItems)
  let dispatched = 0
  let expired = 0
  for (const r of rows) {
    if (Date.now() > budget.deadline) break
    if (r.deadlineAt <= now) {
      const done = await deps.store.tx(async (repo) => {
        const p = await repo.getDestinationPublication(r.id, { lock: true })
        if (!p || !['queued', 'running', 'waiting', 'removing'].includes(p.status) || p.deadlineAt > now)
          return false
        if (p.leaseUntil && p.leaseUntil > now) return false
        const msg =
          p.operation === 'remove'
            ? 'It could not be removed in time. Remove it there by hand.'
            : p.status === 'waiting'
              ? 'The destination never reported back.'
              : 'It could not be published in time.'
        const patch = {
          status: 'failed' as const,
          error: safeError('deadline', msg),
          nextRunAt: null,
          leaseUntil: null,
          updatedAt: now,
        }
        await repo.updateDestinationPublication(p.id, patch)
        await emitTerminal(repo, deps, { ...p, ...patch })
        return true
      })
      if (done) expired++
      continue
    }
    // Throttle: the row isn't due again for a minute unless the worker reschedules it sooner.
    await deps.store.updateDestinationPublication(r.id, { nextRunAt: plus(now, 60_000) })
    try {
      await deps.platform.dispatchPublish(r.id)
      dispatched++
    } catch (e) {
      deps.log.warn('destination.dispatch_failed', { id: r.id, error: e })
    }
  }
  let secretsCleared = 0
  for (const p of await deps.store.listExpiredSecrets(now, 50)) {
    await deps.store.updateDestinationPublication(p.id, { secretOnceEnc: null })
    secretsCleared++
  }
  return { dispatched, expired, secretsCleared }
}
