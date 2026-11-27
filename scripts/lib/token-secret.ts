// Marks RUNNER_API_TOKEN as a secret on the project, once. The Deploy to Netlify button saves every variable it asks
// for as a plain one, so anyone who can open the project's settings could read the token. The production build fixes
// that with the token itself. `npm run setup` already saves it as a secret.
import { netlifyApi } from './netlify-setup.js'

const KEY = 'RUNNER_API_TOKEN'
// A secret can't be read by post-processing, and Netlify doesn't give secret values to local dev. Builds keep it, so
// the build's own setup steps (this one, and turning on Identity) still work on later deploys.
const SECRET_SCOPES = ['builds', 'functions']
const SECRET_CONTEXTS = ['production', 'deploy-preview', 'branch-deploy']

export type TokenSecretResult =
  | { state: 'already' | 'marked' }
  /** Not attempted. `not_project_variable`: the token comes from somewhere else, such as a team variable. */
  | {
      state: 'skipped'
      reason: 'not_production' | 'agent_run' | 'no_token' | 'no_site' | 'not_project_variable'
    }
  | { state: 'failed'; status: number | null; error?: string }

interface EnvVar {
  key: string
  is_secret?: boolean
  scopes?: string[]
}

/** Makes the project's own RUNNER_API_TOKEN a secret, keeping its value. One request replaces the variable. */
export async function ensureTokenSecret(
  token: string,
  siteId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSecretResult> {
  const site = await netlifyApi<{ account_id?: string }>(
    token,
    'GET',
    `/sites/${encodeURIComponent(siteId)}`,
    undefined,
    fetchImpl,
  )
  if (site.status !== 200 || !site.data.account_id) return { state: 'failed', status: site.status }
  const path = `/accounts/${encodeURIComponent(site.data.account_id)}/env/${KEY}?site_id=${encodeURIComponent(siteId)}`
  const current = await netlifyApi<EnvVar>(token, 'GET', path, undefined, fetchImpl)
  if (current.status === 404) return { state: 'skipped', reason: 'not_project_variable' }
  if (current.status !== 200) return { state: 'failed', status: current.status }
  if (current.data.is_secret) return { state: 'already' }
  const put = await netlifyApi(
    token,
    'PUT',
    path,
    {
      key: KEY,
      scopes: SECRET_SCOPES,
      is_secret: true,
      values: SECRET_CONTEXTS.map((context) => ({ value: token, context })),
    },
    fetchImpl,
  )
  return put.status < 300 ? { state: 'marked' } : { state: 'failed', status: put.status }
}

/** The build's step: production builds only. Never throws and never fails the build. */
export async function ensureTokenSecretAtBuild(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSecretResult> {
  if (env.CONTEXT !== 'production') return { state: 'skipped', reason: 'not_production' }
  if (Object.keys(env).some((k) => k.startsWith('NETLIFY_AGENT_RUNNER_')))
    return { state: 'skipped', reason: 'agent_run' }
  if (!env.RUNNER_API_TOKEN) return { state: 'skipped', reason: 'no_token' }
  if (!env.SITE_ID) return { state: 'skipped', reason: 'no_site' }
  try {
    const timed: typeof fetch = (input, init) =>
      fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) })
    return await ensureTokenSecret(env.RUNNER_API_TOKEN, env.SITE_ID, timed)
  } catch (e) {
    // The name only: the request carries the token, and it must never reach the log.
    return { state: 'failed', status: null, error: e instanceof Error ? e.name : 'error' }
  }
}
