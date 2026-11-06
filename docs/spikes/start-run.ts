// Phase 0 spike helper: start one agent run from a prompt file and log its lifecycle as JSON lines.
// Usage: npx tsx docs/spikes/start-run.ts --prompt-file docs/spikes/prompts/hello.md [--branch spike/phase-0] [--deploy-id <id>]
//        [--model <id> --effort <level>] [--deadline-min 25] [--no-wait]
// Auth: RUNNER_API_TOKEN, else the SDK's Netlify CLI config discovery.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createAgentRunnerSdk } from 'nax-agent-runner-sdk'

const { values } = parseArgs({
  options: {
    'prompt-file': { type: 'string' },
    branch: { type: 'string' },
    'deploy-id': { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    agent: { type: 'string', default: 'claude' },
    'deadline-min': { type: 'string', default: '25' },
    'no-wait': { type: 'boolean', default: false },
    site: { type: 'string', default: process.env.NETLIFY_SITE_ID },
  },
})

const log = (step: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...data }))

const promptFile = values['prompt-file']
if (!promptFile) throw new Error('--prompt-file is required')
if (!values.site) throw new Error('--site or NETLIFY_SITE_ID is required')
const prompt = readFileSync(promptFile, 'utf8')
const token = process.env.RUNNER_API_TOKEN
const sdk = createAgentRunnerSdk(token ? { token } : {})

const started = Date.now()
const handle = await sdk.start({
  siteId: values.site,
  prompt,
  agent: values.agent,
  land: 'none',
  requestId: randomUUID(),
  deadlineMs: Number(values['deadline-min']) * 60_000,
  ...(values.branch ? { branch: values.branch } : {}),
  ...(values['deploy-id'] ? { deployId: values['deploy-id'] } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values.effort ? { effort: values.effort } : {}),
})
mkdirSync('docs/spikes/out', { recursive: true })
const handleFile = `docs/spikes/out/${handle.runnerId}.handle.json`
writeFileSync(handleFile, sdk.serializeHandle(handle))
log('started', {
  runnerId: handle.runnerId,
  sessionId: handle.currentSessionId,
  handleFile,
  ms: Date.now() - started,
})
if (values['no-wait']) process.exit(0)

let last = ''
for (;;) {
  const snap = await sdk.getSnapshot(handle)
  if (snap.kind === 'terminal') {
    const r = snap.result
    log('terminal', {
      status: r.status,
      ms: Date.now() - started,
      usage: r.usage,
      ...(r.status === 'succeeded'
        ? { resultText: r.resultText, deployUrl: r.deployUrl, links: r.links }
        : {}),
      ...(r.status === 'failed' ? { failure: r.failure } : {}),
    })
    break
  }
  const key = `${snap.state}|${snap.latestStep ?? ''}`
  if (key !== last)
    log('running', { state: snap.state, latestStep: snap.latestStep, ms: Date.now() - started })
  last = key
  if (Date.now() > handle.policy.deadlineAt) {
    await sdk.stop(handle)
    log('deadline-stop')
    break
  }
  await new Promise((r) => setTimeout(r, 10_000))
}
