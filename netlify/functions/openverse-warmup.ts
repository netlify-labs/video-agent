// Scheduled daily on the published production deploy: queue the warm-up that refreshes common and popular music
// searches in openverse-background, so Find music answers them at once. Quick: it only plans and dispatches.
import type { Config } from '@netlify/functions'
import { prodDeps } from '../../src/adapters/prod.js'
import { startWarmup } from '../../src/domain/openverse-jobs.js'

export default async () => {
  const deps = prodDeps()
  try {
    deps.log.info('openverse.warmup_started', await startWarmup(deps))
  } catch (e) {
    deps.log.error('openverse.warmup_failed', { error: e })
  }
}

// 05:17 UTC: off the hour, when few people search.
export const config: Config = { schedule: '17 5 * * *' }
