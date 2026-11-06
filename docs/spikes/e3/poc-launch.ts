// Starts the ONE Remotion proof run (owner's request, 2026-11-05), or with --dry shows exactly what it would do and
// what it should cost, touching no network and spending nothing.
//
//   SITE_ID=<the deployment's site id> npx tsx docs/spikes/e3/poc-launch.ts --dry
//   SITE_ID=<the deployment's site id> npx tsx docs/spikes/e3/poc-launch.ts --yes     (only after the owner's OK)
//
// The run is a standalone Agent Runner run (docs/spikes/start-run.ts, land "none": nothing committed or deployed) on the
// internal deployment, from the branch below, like the S1 runs. The app is never involved: no ENGINES, no setting, no
// API call, so Remotion is on for nobody and for no other video. The MP4 goes to the private Blobs store
// spike-remotion for the owner to watch; nothing is published.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SITE = process.env.SITE_ID ?? '' // the Netlify site to run on
if (!SITE) throw new Error('Set SITE_ID to the Netlify site to run on.')
const BRANCH = 'spike/remotion-poc'
const PROMPT = 'docs/spikes/prompts/remotion-poc.md'
const DEADLINE_MIN = 25
// S1's launch brief from scratch was 206 credits (HyperFrames); Remotion adds the install, the browser download and
// more check rounds. The run's deadline is the hard stop: the runner can't be capped in credits mid-run.
const PROJECTED = { credits: 250, range: [150, 400] }

const root = join(import.meta.dirname, '..', '..', '..')
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const prompt = readFileSync(join(root, PROMPT), 'utf8')
const head = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain', '--', 'docs/spikes/e3', PROMPT, 'docs/spikes/start-run.ts')
// The SDK falls back to the Netlify CLI's login: its config file (never read here, only whether it exists).
const cliConfig = join(homedir(), process.platform === 'darwin' ? 'Library/Preferences/netlify/config.json' : '.config/netlify/config.json')
const hasRunnerAuth = !!process.env.RUNNER_API_TOKEN || existsSync(cliConfig)
const plan = {
  run: 'one standalone Agent Runner run (docs/spikes/start-run.ts), land "none": no commit, no deploy, no PR',
  site: `${SITE} (the internal deployment, as S1's spike runs); the app isn't used and Remotion is enabled nowhere`,
  branch: `${BRANCH} at ${head.slice(0, 12)} (pushed just before the run; spike branch only, never main)`,
  prompt: { file: PROMPT, sha256: createHash('sha256').update(prompt).digest('hex').slice(0, 16), bytes: prompt.length },
  steps: [
    'runner setup (npm install at the root: netlify-agent-kit, as every run)',
    'poc.ts setup: npm ci --ignore-scripts in docs/spikes/e3, Chrome Headless Shell, ldd for missing Linux libraries (E1)',
    'the agent writes props.json, beats, layers and summary.json for one ~15 s 16:9 video (the S1 launch brief)',
    'poc.ts check until ok: stills at each beat midpoint (development renders), the agent looks at them',
    'poc.ts render --upload: one MP4 (development render), probed, hashed, uploaded to Blobs store spike-remotion',
  ],
  license: 'every render: licenseKey "free-license", isProduction false (sends an anonymous usage event to remotion.pro); no envVariables',
  credits: { projected: PROJECTED.credits, likelyRange: PROJECTED.range, hardStop: `${DEADLINE_MIN} min deadline` },
  afterwards: 'download the MP4 for the owner, record the results in docs/spikes.md (E1, one-video E2); nothing else runs',
}
const problems = [
  ...(dirty ? ['docs/spikes/e3, the prompt or start-run.ts has uncommitted changes: commit them first'] : []),
  ...(hasRunnerAuth ? [] : ['no runner auth: set RUNNER_API_TOKEN or log in with the Netlify CLI']),
]

if (process.argv.includes('--dry')) {
  console.log(JSON.stringify({ step: 'dry_plan', ...plan }, null, 2))
  console.log(JSON.stringify({ step: problems.length ? 'DRY_INCOMPLETE' : 'DRY_OK', problems, network: 'none', spent: 0 }))
  process.exit(problems.length ? 2 : 0)
}
if (!process.argv.includes('--yes')) throw new Error('Pass --dry to see the plan, or --yes once the owner has approved it.')
if (problems.length) throw new Error(problems.join(' '))
git('push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BRANCH}`)
const r = spawnSync('npx', ['tsx', 'docs/spikes/start-run.ts', '--prompt-file', PROMPT, '--branch', BRANCH, '--site', SITE, '--deadline-min', String(DEADLINE_MIN)], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
