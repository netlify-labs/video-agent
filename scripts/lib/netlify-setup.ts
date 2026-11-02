// Shared by the setup scripts: your Netlify CLI login, the Netlify API, site-scoped variables and prompts.
// Never prints secret values.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { createInterface } from 'node:readline/promises'

export const NETLIFY_API = 'https://api.netlify.com/api/v1'

export interface Site {
  id: string
  name: string
  account_id: string
  account_slug: string
  ssl_url: string
  admin_url: string
  build_settings?: { repo_url?: string; repo_branch?: string }
}

export interface SiteVar {
  key: string
  value: string
  secret?: boolean
  /** Defaults to functions only: runtime configuration, not build input. */
  scopes?: string[]
}

/** The token of your `netlify login` (or NETLIFY_AUTH_TOKEN). */
export function cliToken(): string {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN
  const paths = [
    join(homedir(), 'Library/Preferences/netlify/config.json'),
    join(homedir(), '.config/netlify/config.json'),
  ]
  for (const p of paths) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as {
        userId?: string
        users?: Record<string, { auth?: { token?: string } }>
      }
      const token = cfg.userId ? cfg.users?.[cfg.userId]?.auth?.token : undefined
      if (token) return token
    } catch {
      // try the next location
    }
  }
  throw new Error('Not logged in to Netlify. Run `npx netlify login` first.')
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
export async function netlifyApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; data: T }> {
  const res = await fetchImpl(`${NETLIFY_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
}

export async function getSite(
  token: string,
  idOrName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Site> {
  const r = await netlifyApi<Site>(
    token,
    'GET',
    `/sites/${encodeURIComponent(idOrName)}`,
    undefined,
    fetchImpl,
  )
  if (r.status !== 200) throw new Error(`Project ${idOrName} not found (HTTP ${r.status}).`)
  return r.data
}

/** The names of the site's own variables (values are never read). */
export async function siteVarNames(
  token: string,
  site: Site,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const r = await netlifyApi<{ key: string }[]>(
    token,
    'GET',
    `/accounts/${site.account_id}/env?site_id=${site.id}`,
    undefined,
    fetchImpl,
  )
  return r.status === 200 && Array.isArray(r.data) ? r.data.map((v) => v.key) : []
}

/**
 * Sets site-scoped variables, replacing any existing ones. Secrets go to the deployed contexts (production, deploy
 * previews, branch deploys), since Netlify doesn't give secret values to local dev; others apply everywhere.
 */
export async function setSiteVars(
  token: string,
  site: Site,
  vars: SiteVar[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const v of vars) {
    const body = {
      key: v.key,
      scopes: v.scopes ?? ['functions'],
      ...(v.secret ? { is_secret: true } : {}),
      values: v.secret
        ? ['production', 'deploy-preview', 'branch-deploy'].map((context) => ({ value: v.value, context }))
        : [{ value: v.value, context: 'all' }],
    }
    // Site-scoped: omitting site_id would create a team-wide variable.
    await netlifyApi(
      token,
      'DELETE',
      `/accounts/${site.account_id}/env/${v.key}?site_id=${site.id}`,
      undefined,
      fetchImpl,
    )
    const r = await netlifyApi(
      token,
      'POST',
      `/accounts/${site.account_id}/env?site_id=${site.id}`,
      [body],
      fetchImpl,
    )
    if (r.status >= 300) throw new Error(`Could not set ${v.key} (HTTP ${r.status}).`)
  }
}

/** Starts a production build from the connected repo and waits for it; variables only reach functions on a deploy. */
export async function buildAndWait(token: string, site: Site, log: (m: string) => void): Promise<void> {
  const build = await netlifyApi<{ deploy_id: string }>(token, 'POST', `/sites/${site.id}/builds`, {})
  if (build.status >= 300) throw new Error(`Could not start a build (HTTP ${build.status}).`)
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000))
    const d = await netlifyApi<{ state: string; error_message?: string }>(
      token,
      'GET',
      `/deploys/${build.data.deploy_id}`,
    )
    if (d.data.state === 'ready') return
    if (d.data.state === 'error')
      throw new Error(`The build failed: ${d.data.error_message ?? 'see the deploy log'}`)
    log(`  ${d.data.state}…`)
  }
}

/** A value from the environment, else asked for; `fallback` is offered and used on Enter. */
export async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  envName: string,
  fallback?: string,
): Promise<string> {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  const v = (await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `)).trim() || fallback || ''
  if (!v) throw new Error(`${envName} is required.`)
  return v
}
