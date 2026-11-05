// npm run seed:music -- --site <site id, name or https URL> [--count 12] [--cc0-only]
// Imports a starter set of music into the team media library across moods (upbeat, ambient, corporate, cinematic,
// acoustic, playful, inspiring, lofi) through the site's own Openverse endpoints: search, choose tracks of 30 s to
// 4 min the library can take (CC0 first, then CC BY, which videos credit automatically; --cc0-only for no credits),
// import. The server's music pick falls back to these when Openverse is slow or down. Patient: follows 202 jobs,
// waits out 429s and 5xx with backoff, skips tracks already in the library. Optional, never run by npm run setup.
// Needs VIDEO_AGENT_KEY: an API key of a Creator or admin (Settings → API keys). A site id or name is looked up with
// your Netlify CLI login (`npx netlify login`); an https URL is used as is. Never prints the key.
import { cliToken, getSite } from './lib/netlify-setup.js'
import { parseArgs } from './lib/run-tools.js'
import { VideoAgent } from '../packages/sdk/src/index.js'
import { sdkCall, seedMusic, summary } from './lib/seed-music.js'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const siteArg = args.site ?? process.env.VIDEO_AGENT_URL ?? process.env.NETLIFY_SITE_ID
  if (!siteArg) throw new Error('Pass --site <site id, name or https URL>.')
  const key = process.env.VIDEO_AGENT_KEY ?? ''
  if (!key) throw new Error('Set VIDEO_AGENT_KEY to an API key of a Creator or admin (Settings → API keys).')
  const count = Number(args.count ?? 12)
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('--count must be 1 to 60.')

  const base = /^https?:\/\//.test(siteArg)
    ? siteArg.replace(/\/+$/, '')
    : (await getSite(cliToken(), siteArg)).ssl_url.replace(/\/+$/, '')
  const licences = args['cc0-only'] === 'true' ? 'cc0' : 'cc0,by'
  console.log(
    `Seeding ${count} ${licences === 'cc0' ? 'CC0' : 'CC0 and CC BY'} tracks into the library of ${base}…`,
  )

  // seedMusic waits out 429s and 5xx itself, so the client doesn't retry on top.
  const call = sdkCall(new VideoAgent({ url: base, apiKey: key, retries: 0, userAgent: 'seed-music' }))
  const who = await call('GET', '/api/v1/me')
  if (who.status === 401) throw new Error('VIDEO_AGENT_KEY was refused by this site.')

  const rows = await seedMusic(call, count, undefined, licences)
  console.log(`\n${summary(rows)}`)
  if (!rows.some((r) => r.outcome !== 'failed')) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
