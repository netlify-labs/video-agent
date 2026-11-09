// Netlify API facts (production deploy, token, Agent Runners) and background function dispatch.
import type { PlatformPort } from '../deps.js'
import { hmacHex } from '../lib/crypto.js'

const API = 'https://api.netlify.com/api/v1'

export function createPlatform(opts: {
  siteId: string | null
  siteUrl: string
  token: string | null
  signingSecret: () => Promise<string>
}): PlatformPort {
  const api = async (path: string) => {
    if (!opts.token) throw new Error('RUNNER_API_TOKEN is not set')
    return fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(8000),
    })
  }
  /** POSTs `{ [key]: id }` to `<fn>-background`, signed over `<kind>:<id>`; the function answers 202. */
  const dispatch = async (fn: string, kind: string, key: string, id: string, what: string, ms = 8000) => {
    const sig = hmacHex(await opts.signingSecret(), `${kind}:${id}`)
    const res = await fetch(`${opts.siteUrl}/.netlify/functions/${fn}-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [`x-${kind}-signature`]: sig },
      body: JSON.stringify({ [key]: id }),
      signal: AbortSignal.timeout(ms),
    })
    if (res.status !== 202) throw new Error(`${what} dispatch returned ${res.status}`)
  }
  return {
    async productionDeployId() {
      if (!opts.siteId) return null
      const res = await api(`/sites/${opts.siteId}`)
      if (!res.ok) return null
      const site = (await res.json()) as { published_deploy?: { id?: string } }
      return site.published_deploy?.id ?? null
    },
    dispatchFinalize: (attemptId) => dispatch('finalize', 'finalize', 'attemptId', attemptId, 'finalize'),
    dispatchMediaAssembly: (uploadId) =>
      dispatch('media-assemble', 'assemble', 'uploadId', uploadId, 'assembly'),
    // Short: the API request that dispatches has already spent seconds trying Openverse itself.
    dispatchOpenverseJob: (jobId) => dispatch('openverse', 'openverse', 'jobId', jobId, 'openverse', 3000),
    dispatchPublish: (publicationId) =>
      dispatch('publish', 'publish', 'publicationId', publicationId, 'publish'),
    async setupFacts() {
      const out = {
        tokenValid: null as boolean | null,
        tokenError: null as string | null,
        agentRunnersAvailable: null as boolean | null,
        identityEnabled: false,
      }
      if (!opts.token) return out
      try {
        const me = await api('/user')
        out.tokenValid = me.ok
        if (!me.ok)
          out.tokenError =
            me.status === 401
              ? 'The token was rejected (expired or revoked).'
              : `Netlify API returned ${me.status}.`
        if (me.ok && opts.siteId) {
          const site = await api(`/sites/${opts.siteId}`)
          if (site.status === 404 || site.status === 403) {
            out.tokenValid = false
            out.tokenError = "The token's account can't access this project. Use a member of this team."
          }
          const runners = await api(`/agent_runners?site_id=${opts.siteId}&per_page=1`)
          out.agentRunnersAvailable = runners.ok
            ? true
            : runners.status === 403 || runners.status === 402
              ? false
              : null
        }
      } catch (e) {
        out.tokenError = e instanceof Error ? e.message : String(e)
      }
      return out
    },
  }
}
