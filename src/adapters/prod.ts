// Production wiring for Netlify Functions.
import { drizzle } from 'drizzle-orm/netlify-db'
import { readConfig, type Deps } from '../deps.js'
import { getSettings } from '../domain/settings.js'
import { ids } from '../lib/ids.js'
import { createLogger } from '../lib/log.js'
import { createDrizzleStore } from '../store/drizzle.js'
import * as schema from '../../db/schema.js'
import { netlifyBlobs } from './blobs.js'
import { createGateway } from './gateway.js'
import { safeHttp } from './http.js'
import { netlifyIdentity } from './identity.js'
import { createPlatform } from './platform.js'
import { createRunner } from './runner.js'

let deps: Deps | null = null

export function prodDeps(): Deps {
  if (deps) return deps
  const env = process.env
  const config = readConfig(env)
  const store = createDrizzleStore(drizzle({ schema }))
  const token = env.RUNNER_API_TOKEN ?? null
  const partial = { store, ids, clock: { now: () => new Date() }, blobs: netlifyBlobs }
  deps = {
    config,
    ...partial,
    identity: netlifyIdentity,
    runner: createRunner({
      siteId: config.siteId ?? '',
      siteName: env.SITE_NAME ?? config.siteId ?? '',
      token: token ?? '',
    }),
    platform: createPlatform({
      siteId: config.siteId,
      siteUrl: config.siteUrl,
      token,
      signingSecret: async () => (await getSettings(partial)).fileSigningSecret,
    }),
    http: safeHttp,
    gateway: createGateway(env),
    log: createLogger({ service: 'video-agent' }),
  }
  return deps
}
