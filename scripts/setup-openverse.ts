// npm run setup:openverse -- --site <site id or name> [--email you@example.com] [--name "App name"] [--force] [--deploy]
// The email defaults to your Netlify CLI login's (override with --email or OPENVERSE_EMAIL).
// Registers an Openverse API application for this deployment's music search and sets OPENVERSE_CLIENT_ID and
// OPENVERSE_CLIENT_SECRET on the site (the secret is never printed). Openverse then emails a verification link:
// click it, or the app keeps anonymous rate limits. Variables reach the functions on the next deploy (--deploy
// starts one). Uses your Netlify CLI login (`npx netlify login`).
import { createInterface } from 'node:readline/promises'
import { exitOnError, parseArgs } from './lib/run-tools.js'
import { ask, buildAndWait, cliEmail, cliToken, getSite, siteVarNames } from './lib/netlify-setup.js'
import { defaultAppName, defaultDescription, registerOpenverse } from './lib/openverse-setup.js'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const siteArg = args.site ?? process.env.NETLIFY_SITE_ID
  if (!siteArg) throw new Error('Pass --site <site id or name> (or set NETLIFY_SITE_ID).')
  const token = cliToken()
  const site = await getSite(token, siteArg)
  console.log(`Project: ${site.name} (${site.ssl_url})`)

  if ((await siteVarNames(token, site)).includes('OPENVERSE_CLIENT_ID') && args.force !== 'true') {
    console.log(
      'This project already has an Openverse app (OPENVERSE_CLIENT_ID is set). Pass --force to register a new one.',
    )
    return
  }

  // Your Netlify login's email unless you say otherwise; asked for only when the CLI doesn't know it.
  let email = args.email ?? process.env.OPENVERSE_EMAIL ?? cliEmail()
  if (!email) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    email = await ask(rl, 'Email for Openverse to verify and contact (OPENVERSE_EMAIL)', 'OPENVERSE_EMAIL')
    rl.close()
  }
  const name = args.name ?? defaultAppName(site)
  console.log(`Registering "${name}" with Openverse for ${email}…`)

  const app = await registerOpenverse({
    netlifyToken: token,
    site,
    name,
    description: defaultDescription(site),
    email,
  })
  console.log(
    `Registered the Openverse app "${app.name}" and set OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET.`,
  )
  console.log(
    `Next: open the email Openverse sent to ${email} and click the verification link. Until then, music search has anonymous rate limits.`,
  )

  if (args.deploy === 'true') {
    console.log('Deploying so the functions get the new variables…')
    await buildAndWait(token, site, (m) => {
      console.log(m)
    })
    console.log('Deployed.')
  } else {
    console.log(
      `The variables apply from the next deploy (pass --deploy, or redeploy at ${site.admin_url}/deploys).`,
    )
  }
}

main().catch(exitOnError())
