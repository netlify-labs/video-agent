// Production wiring for Netlify Functions.
import { drizzle } from 'drizzle-orm/netlify-db'
import { readConfig, type Deps } from '../deps.js'
import { getSettings } from '../domain/settings.js'
import { ids } from '../lib/ids.js'
import { createLogger, verboseFromEnv } from '../lib/log.js'
import { boundedJson, netlifyUpstream } from '../auth/upstream.js'
import { createDrizzleStore } from '../store/drizzle.js'
import * as schema from '../../db/schema.js'
import { netlifyBlobs } from './blobs.js'
import { createGateway } from './gateway.js'
import { createPublicFetch, safeHttp } from './http.js'
import { netlifyIdentity } from './identity.js'
import { createPlatform } from './platform.js'
import { createRunner } from './runner.js'

let deps: Deps | null = null

export function prodDeps(): Deps {
  if (deps) return deps
  const log = createLogger({ service: 'video-agent' }, undefined, { verbose: verboseFromEnv() })
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
    fetch: createPublicFetch(),
    gateway: createGateway(env),
    oauth:
      config.netlifyOAuth && (config.mcpOAuth || config.authProvider === 'netlify')
        ? {
            upstream: netlifyUpstream(config.netlifyOAuth),
            fetchClientMetadata: (url) =>
              boundedJson(
                'client_metadata',
                url,
                { headers: { accept: 'application/json' } },
                { timeoutMs: 5_000, maxBytes: 16_384 },
              ).catch((e: unknown) => {
                // The client is then refused as unknown: say why in the logs.
                log.warn('oauth.client_metadata_unavailable', { url, error: e })
                return null
              }),
          }
        : null,
    log,
  }
  return deps
}
