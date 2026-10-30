// npm run setup: set up a deployment of this template from a clone.
//   npm run setup -- --site <site id or name>   (use an existing project)
//   npm run setup -- --team <team slug>          (create a project in that team)
// Asks for RUNNER_API_TOKEN, ALLOWED_EMAIL_DOMAINS and ADMIN_EMAILS (or reads them from the environment),
// sets them as site-scoped variables, enables Identity, deploys to production, and runs the /setup checks.
// Uses your Netlify CLI login (`npx netlify login`). Never prints secret values.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs, repoRoot } from './lib/run-tools.js'

const API = 'https://api.netlify.com/api/v1'
const log = (msg: string) => {
  console.log(msg)
}

function cliToken(): string {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN
  const paths = [join(homedir(), 'Library/Preferences/netlify/config.json'), join(homedir(), '.config/netlify/config.json')]
  for (const p of paths) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as { userId?: string; users?: Record<string, { auth?: { token?: string } }> }
      const token = cfg.userId ? cfg.users?.[cfg.userId]?.auth?.token : undefined
      if (token) return token
    } catch {
      // try the next location
    }
  }
  throw new Error('Not logged in to Netlify. Run `npx netlify login` first.')
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, envName: string): Promise<string> {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  const v = (await rl.question(`${label}: `)).trim()
  if (!v) throw new Error(`${envName} is required.`)
  return v
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = cliToken()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  type Site = { id: string; name: string; account_id: string; account_slug: string; ssl_url: string }
  let site: Site
  if (args.site) {
    const r = await api<Site>(token, 'GET', `/sites/${encodeURIComponent(args.site)}`)
    if (r.status !== 200) throw new Error(`Project ${args.site} not found (HTTP ${r.status}).`)
    site = r.data
  } else {
    const team = args.team ?? (await rl.question('Team slug to create the project in: ')).trim()
    const name = args.name ?? `video-agent-${Math.random().toString(36).slice(2, 7)}`
    const r = await api<Site>(token, 'POST', `/${encodeURIComponent(team)}/sites`, { name })
    if (r.status >= 300) throw new Error(`Could not create the project (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`)
    site = r.data
    log(`Created project ${site.name}.`)
  }
  log(`Project: ${site.name} (${site.ssl_url})`)

  const runnerToken = await ask(rl, 'Personal access token for starting runs (RUNNER_API_TOKEN)', 'RUNNER_API_TOKEN')
  const domains = await ask(rl, 'Allowed email domains, comma-separated, or invite-only (ALLOWED_EMAIL_DOMAINS)', 'ALLOWED_EMAIL_DOMAINS')
  const admins = await ask(rl, 'First admin emails, comma-separated (ADMIN_EMAILS)', 'ADMIN_EMAILS')
  rl.close()

  const vars = [
    { key: 'RUNNER_API_TOKEN', scopes: ['functions'], is_secret: true, values: [{ value: runnerToken, context: 'production' }] },
    { key: 'ALLOWED_EMAIL_DOMAINS', scopes: ['functions', 'builds'], values: [{ value: domains, context: 'all' }] },
    { key: 'ADMIN_EMAILS', scopes: ['functions'], values: [{ value: admins, context: 'all' }] },
  ]
  for (const v of vars) {
    // Site-scoped: omitting site_id would create a team-wide variable.
    await api(token, 'DELETE', `/accounts/${site.account_id}/env/${v.key}?site_id=${site.id}`)
    const r = await api(token, 'POST', `/accounts/${site.account_id}/env?site_id=${site.id}`, [v])
    if (r.status >= 300) throw new Error(`Could not set ${v.key} (HTTP ${r.status}).`)
    log(`Set ${v.key}.`)
  }

  const identity = await api<{ id?: string }>(token, 'GET', `/sites/${site.id}/identity`)
  if (identity.status === 404) {
    const r = await api(token, 'POST', `/sites/${site.id}/identity`, {})
    log(r.status < 300 ? 'Enabled Identity.' : `Could not enable Identity (HTTP ${r.status}); enable it in the Netlify UI.`)
  } else {
    log('Identity is already enabled.')
  }
  if (domains.trim() === 'invite-only') {
    log('Invite-only: set Identity registration to "Invite only" in Project configuration → Identity.')
  }

  log('Deploying to production (this builds the project)…')
  execFileSync('npx', ['-y', 'netlify-cli', 'deploy', '--build', '--prod', '--site', site.id], { stdio: 'inherit', cwd: repoRoot, env: { ...process.env, NETLIFY_AUTH_TOKEN: token } })

  const health = await fetch(`${site.ssl_url}/api/health?fresh=1`)
  const body = (await health.json()) as { ready: boolean; checks: { label: string; status: string; detail: string; fix?: string }[] }
  for (const c of body.checks) {
    const mark = { ok: '✓', fail: '✗', warn: '!', unknown: '?' }[c.status] ?? '?'
    log(`${mark} ${c.label}: ${c.detail}${c.status !== 'ok' && c.fix ? `\n    ${c.fix}` : ''}`)
  }
  log(body.ready ? `\nReady: ${site.ssl_url}` : `\nAlmost there. Fix the items above, then open ${site.ssl_url}/setup.`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
