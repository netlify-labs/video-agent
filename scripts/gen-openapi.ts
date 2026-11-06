// Writes ui/src/api/openapi.json from the routes (with in-memory fakes, no network). --check fails when stale.
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { repoRoot, writeOrCheck } from './lib/run-tools.js'
import { makeDeps } from '../test/fakes.js'

const deps = makeDeps({ URL: 'https://your-video-agent.netlify.app' })
const app = createApp(deps, { isLive: () => true, contextIsDefault: true })
const out = `${JSON.stringify(app.spec(), null, 2)}\n`
writeOrCheck(join(repoRoot, 'ui/src/api/openapi.json'), out, {
  check: process.argv.includes('--check'),
  label: 'ui/src/api/openapi.json',
  hint: 'Run `npm run openapi:gen` and commit the result.',
})
