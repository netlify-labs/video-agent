// Writes ui/src/api/openapi.json from the routes (with in-memory fakes, no network). --check fails when stale.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { repoRoot } from './lib/run-tools.js'
import { makeDeps } from '../test/fakes.js'

const deps = makeDeps({ URL: 'https://your-video-agent.netlify.app' })
const app = createApp(deps, { isLive: () => true, contextIsDefault: true })
const out = `${JSON.stringify(app.spec(), null, 2)}\n`
const path = join(repoRoot, 'ui/src/api/openapi.json')
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // missing counts as stale
  }
  if (current !== out) {
    console.error('ui/src/api/openapi.json is stale. Run `npm run openapi:gen` and commit the result.')
    process.exit(1)
  }
  console.log('ui/src/api/openapi.json is up to date.')
} else {
  writeFileSync(path, out)
  console.log(`Wrote ${path}`)
}
