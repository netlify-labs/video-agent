// Scheduled every minute on the published production deploy. Bounded: stops taking work ~20 s in
// and never moves bytes (finalize-background does that).
import type { Config } from '@netlify/functions'
import { prodDeps } from '../../app/server/adapters/prod.js'
import { runCleanup } from '../../app/server/domain/cleanup.js'
import { tick } from '../../app/server/domain/reconciler.js'
import { deliverWebhooks } from '../../app/server/domain/webhooks.js'
import { duePublications } from '../../app/server/domain/destinations/sweep.js'

export default async () => {
  const deps = prodDeps()
  const started = Date.now()
  const budget = { deadline: started + 20_000, maxItems: 20 }
  try {
    const r = await tick(deps, budget)
    const delivered = await deliverWebhooks(deps, budget)
    const destinations = await duePublications(deps, budget)
    const cleaned = await runCleanup(deps, { ...budget, maxItems: 5 })
    deps.log.info('sweep.done', { ...r, delivered, destinations, cleaned, ms: Date.now() - started })
  } catch (e) {
    deps.log.error('sweep.failed', { error: e, ms: Date.now() - started })
  }
}

export const config: Config = { schedule: '* * * * *' }
