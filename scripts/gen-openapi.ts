// Writes app/web/src/api/openapi.json from the routes (with in-memory fakes, no network). --check fails when stale.
import { join } from 'node:path'
import { createApp } from '../app/server/app.js'
import { repoRoot, writeOrCheck } from './lib/run-tools.js'
import { makeDeps } from '../app/test/fakes.js'

const deps = makeDeps({ URL: 'https://your-video-agent.netlify.app' })
const app = createApp(deps, { isLive: () => true, contextIsDefault: true })
const out = `${JSON.stringify(app.spec(), null, 2)}\n`
writeOrCheck(join(repoRoot, 'app/web/src/api/openapi.json'), out, {
  check: process.argv.includes('--check'),
  label: 'app/web/src/api/openapi.json',
  hint: 'Run `npm run openapi:gen` and commit the result.',
})
