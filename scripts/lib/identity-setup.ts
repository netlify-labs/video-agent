// Turns Netlify Identity on for a project, once. The setup script does it with your CLI login; the build does it with
// RUNNER_API_TOKEN, so a project made with the Deploy to Netlify button needs no trip to the Netlify UI.
import { netlifyApi } from './netlify-setup.js'

export type IdentityResult =
  | { state: 'already' | 'enabled' }
  /** Not attempted: this build isn't the one to do it. */
  | { state: 'skipped'; reason: 'not_production' | 'agent_run' | 'other_sign_in' | 'no_token' | 'no_site' }
  | { state: 'failed'; status: number | null; error?: string }

/** Enables Identity when the project has none. A 404 from the read means "not enabled". */
export async function ensureIdentity(
  token: string,
  siteId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityResult> {
  const path = `/sites/${encodeURIComponent(siteId)}/identity`
  const read = await netlifyApi(token, 'GET', path, undefined, fetchImpl)
  if (read.status === 200) return { state: 'already' }
  if (read.status !== 404) return { state: 'failed', status: read.status }
  const made = await netlifyApi(token, 'POST', path, {}, fetchImpl)
  return made.status < 300 ? { state: 'enabled' } : { state: 'failed', status: made.status }
}

/**
 * The build's step: production builds only (a preview or an agent run never changes the project), and only when the
 * app signs people in with Identity. Never throws and never fails the build: /setup still says how to do it by hand.
 */
export async function ensureIdentityAtBuild(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityResult> {
  if (env.CONTEXT !== 'production') return { state: 'skipped', reason: 'not_production' }
  if (Object.keys(env).some((k) => k.startsWith('NETLIFY_AGENT_RUNNER_')))
    return { state: 'skipped', reason: 'agent_run' }
  if (env.AUTH_PROVIDER?.trim().toLowerCase() === 'netlify')
    return { state: 'skipped', reason: 'other_sign_in' }
  if (!env.RUNNER_API_TOKEN) return { state: 'skipped', reason: 'no_token' }
  if (!env.SITE_ID) return { state: 'skipped', reason: 'no_site' }
  try {
    const timed: typeof fetch = (input, init) =>
      fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) })
    return await ensureIdentity(env.RUNNER_API_TOKEN, env.SITE_ID, timed)
  } catch (e) {
    // The name only: a fetch error's message can carry the request, and the token must never reach the log.
    return { state: 'failed', status: null, error: e instanceof Error ? e.name : 'error' }
  }
}
