// npm run setup: set up a deployment of this template from a clone.
//   npm run setup -- --site <site id or name>   (use an existing project)
//   npm run setup -- --team <team slug>          (create a project in that team)
// Asks for RUNNER_API_TOKEN, ALLOWED_EMAIL_DOMAINS and ADMIN_EMAILS (or reads them from the environment),
// sets them as site-scoped variables, enables Identity, offers to register an Openverse app for music search
// (npm run setup:openverse does just that step), starts a production build from the project's connected
// GitHub repo, and runs the /setup checks. It builds from Git rather than uploading from this machine: Agent
// Runners need a Git-connected project, and Netlify Database applies migrations only on Git builds.
// Uses your Netlify CLI login (`npx netlify login`). Never prints secret values.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { exitOnError, parseArgs } from './lib/run-tools.js'
import {
  ask,
  buildAndWait,
  cliEmail,
  cliToken,
  getSite,
  netlifyApi as api,
  setSiteVars,
  siteVarNames,
  type Site,
} from './lib/netlify-setup.js'
import { defaultAppName, defaultDescription, registerOpenverse } from './lib/openverse-setup.js'

const log = (msg: string) => {
  console.log(msg)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = cliToken()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let site: Site
  if (args.site) {
    site = await getSite(token, args.site)
  } else {
    const team = args.team ?? (await rl.question('Team slug to create the project in: ')).trim()
    const name = args.name ?? `video-agent-${Math.random().toString(36).slice(2, 7)}`
    const r = await api<Site>(token, 'POST', `/${encodeURIComponent(team)}/sites`, { name })
    if (r.status >= 300)
      throw new Error(
        `Could not create the project (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`,
      )
    site = r.data
    log(`Created project ${site.name}.`)
  }
  log(`Project: ${site.name} (${site.ssl_url})`)

  const runnerToken = await ask(
    rl,
    'Personal access token for starting runs (RUNNER_API_TOKEN)',
    'RUNNER_API_TOKEN',
  )
  const domains = await ask(
    rl,
    'Allowed email domains, comma-separated, or invite-only (ALLOWED_EMAIL_DOMAINS)',
    'ALLOWED_EMAIL_DOMAINS',
  )
  const admins = await ask(rl, 'First admin emails, comma-separated (ADMIN_EMAILS)', 'ADMIN_EMAILS')

  await setSiteVars(token, site, [
    { key: 'RUNNER_API_TOKEN', value: runnerToken, secret: true },
    { key: 'ALLOWED_EMAIL_DOMAINS', value: domains, scopes: ['functions', 'builds'] },
    { key: 'ADMIN_EMAILS', value: admins },
  ])
  log('Set RUNNER_API_TOKEN, ALLOWED_EMAIL_DOMAINS and ADMIN_EMAILS.')

  // Runs derive their callback token from it, so no token is ever in a prompt. Builds scope: runs read it; secret: the
  // platform hides its value. Kept when it's already set, so running setup again never breaks runs in flight.
  if (!(await siteVarNames(token, site)).includes('VIDEO_AGENT_RUN_SECRET')) {
    await setSiteVars(token, site, [
      {
        key: 'VIDEO_AGENT_RUN_SECRET',
        value: randomBytes(32).toString('base64url'),
        secret: true,
        scopes: ['builds', 'functions'],
      },
    ])
    log('Set VIDEO_AGENT_RUN_SECRET.')
  }

  // Optional: a registered Openverse app for music search (anonymous limits are shared by outbound address).
  if (
    !(await siteVarNames(token, site)).includes('OPENVERSE_CLIENT_ID') &&
    process.env.OPENVERSE_SETUP !== 'no'
  ) {
    const want = process.env.OPENVERSE_EMAIL
      ? 'y'
      : (
          await rl.question(
            'Register an Openverse app for music search? It needs an email to verify. [Y/n]: ',
          )
        )
          .trim()
          .toLowerCase()
    if (want === '' || want.startsWith('y')) {
      const email = await ask(
        rl,
        'Email for Openverse',
        'OPENVERSE_EMAIL',
        cliEmail() ?? admins.split(',')[0]?.trim(),
      )
      try {
        const app = await registerOpenverse({
          netlifyToken: token,
          site,
          name: defaultAppName(site),
          description: defaultDescription(site),
          email,
        })
        log(
          `Registered the Openverse app "${app.name}". Click the link Openverse emailed to ${email} to verify it.`,
        )
      } catch (e) {
        // Music search still works anonymously; this is never a reason to stop setup.
        log(
          `Skipped Openverse: ${e instanceof Error ? e.message : String(e)} (run npm run setup:openverse later).`,
        )
      }
    }
  }
  rl.close()

  const identity = await api<{ id?: string }>(token, 'GET', `/sites/${site.id}/identity`)
  if (identity.status === 404) {
    const r = await api(token, 'POST', `/sites/${site.id}/identity`, {})
    log(
      r.status < 300
        ? 'Enabled Identity.'
        : `Could not enable Identity (HTTP ${r.status}); enable it in the Netlify UI.`,
    )
  } else {
    log('Identity is already enabled.')
  }
  if (domains.trim() === 'invite-only') {
    log('Invite-only: set Identity registration to "Invite only" in Project configuration → Identity.')
  }

  const repo = site.build_settings?.repo_url
  if (!repo) {
    log(`
Last step: connect this project to your GitHub copy of the template.
  1. Push this clone to a repo of your own on GitHub.
  2. Open ${site.admin_url}/configuration/deploys and choose "Link repository".
  3. Run \`npm run setup -- --site ${site.id}\` again (the values you entered are already saved).`)
    return
  }

  log(`Building ${repo} (${site.build_settings?.repo_branch ?? 'default branch'}) for production…`)
  await buildAndWait(token, site, log)
  log('Deployed.')

  const health = await fetch(`${site.ssl_url}/api/health?fresh=1`)
  const body = (await health.json()) as {
    ready: boolean
    checks: { label: string; status: string; detail: string; fix?: string }[]
  }
  for (const c of body.checks) {
    const mark = { ok: '✓', fail: '✗', warn: '!', unknown: '?' }[c.status] ?? '?'
    log(`${mark} ${c.label}: ${c.detail}${c.status !== 'ok' && c.fix ? `\n    ${c.fix}` : ''}`)
  }
  log(
    body.ready
      ? `\nReady: ${site.ssl_url}`
      : `\nAlmost there. Fix the items above, then open ${site.ssl_url}/setup.`,
  )
  // Optional: music the pre-run pick falls back to when Openverse is slow or down.
  log(
    `\nOptional: seed the media library with CC0 music (with an API key from Settings → API keys):\n  VIDEO_AGENT_KEY=… npm run seed:music -- --site ${site.ssl_url}`,
  )
}

main().catch(exitOnError())
