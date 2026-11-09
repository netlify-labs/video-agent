// Spike B3 (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §7): one hand-made scoped run on a real video. Spends
// credits: one revision-kind run (about 100-120). Production doesn't accept `scope` yet, so this is an ordinary revision
// whose request is the draft scoped prompt (§4.8); afterwards the saved compositions are checked offline with the
// HyperFrames scope check (src/lib/scope.ts), which says what the agent changed outside the scene.
//
//   npx tsx docs/spikes/b3/b3.ts --dry      # checks the env, prints the steps and projected credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SOURCE_ID=vid_… [SCENE=<beat id>] [CHANGE="…"] \
//     NETLIFY_SITE_ID=<site id> [CREDIT_CEILING=150] npx tsx docs/spikes/b3/b3.ts
//
// SOURCE_ID is a ready contract-v1 video with 3-5 scenes and music; SCENE defaults to the middle one. The saved
// archives are read from the site's `sources` Blobs store with the Netlify CLI (the API doesn't serve them).
// Logs one JSON line per step; the summary (credits, wall time, in scope or not, what was outside) goes in docs/spikes.md.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, read } from '../../../app/server/lib/contract.js'
import { readTarGz } from '../../../app/server/lib/tar.js'
import { hyperframesScopeCheck } from '../../../app/server/lib/scope.js'
import { key, log, started } from '../../../scripts/e2e/lib.js'
import { call, dry, dryRun, sleep } from '../../../scripts/e2e/narration-lib.js'

const env = process.env
const sourceId = env.SOURCE_ID ?? ''
const site = env.NETLIFY_SITE_ID ?? ''
const change = env.CHANGE ?? "Make the headline say 'Ship on Friday' and slide it in from the left."
const ceiling = Number(env.CREDIT_CEILING ?? 150)
const PROJECTED = 120

if (dry)
  dryRun({
    script: 'docs/spikes/b3/b3.ts',
    required: {
      VIDEO_AGENT_URL: env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY,
      SOURCE_ID: sourceId,
      NETLIFY_SITE_ID: site,
    },
    optional: { SCENE: env.SCENE, CHANGE: env.CHANGE, CREDIT_CEILING: env.CREDIT_CEILING },
    steps: [
      "Read SOURCE_ID's newest ready version; check it's editable (contract v1) and has music.",
      'Fetch its saved archive from the sources store (netlify blobs:get) and read its scenes; pick SCENE (default: the middle one).',
      'Revise it once (POST /api/v1/videos/{id}/versions, fromVersion) with the draft scoped prompt naming that scene and CHANGE.',
      'Wait for the new version (poll every 10 s, at most 25 min); record credits (usage.totalCreditsCost) and wall time.',
      "Fetch the new version's archive; run hyperframesScopeCheck(parent, new, [SCENE]) offline: in scope or not, and what was outside.",
      'Print a summary for docs/spikes.md (B3). The new version is kept (it is the evidence).',
    ],
    credits: {
      runs: 1,
      projected: PROJECTED,
      ceiling,
      note: 'one revision-kind run; §1 measured 120.3 for a remix',
    },
  })

const k = key
const sources = (blobKey: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'va-b3-'))
  const out = join(dir, 'source.tar.gz')
  // Outside the repo: its npm workspaces make the CLI ask which project to use. The site comes from NETLIFY_SITE_ID.
  const r = spawnSync('netlify', ['blobs:get', 'sources', blobKey, '--output', out], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NETLIFY_SITE_ID: site },
  })
  if (r.status !== 0) throw new Error(`netlify blobs:get sources ${blobKey} failed: ${r.stderr.slice(-300)}`)
  return readTarGz(readFileSync(out), {
    maxEntries: 5000,
    maxTotalBytes: 160 * 1024 * 1024,
    maxFileBytes: 60 * 1024 * 1024,
  })
}
interface Version {
  n: number
  status: string
  editable: boolean
  usage: { totalCreditsCost?: number } | null
}

const video = await call<{ id: string; versions: Version[] }>(k, 'GET', `/api/v1/videos/${sourceId}`)
const parent = video.json.versions.find((v) => v.status === 'ready')
if (!parent?.editable) throw new Error(`${sourceId} has no ready, editable version.`)
const parentFiles = sources(`${sourceId}/v${parent.n}.tar.gz`)
const html = new TextDecoder().decode(parentFiles.get('index.html'))
const beats = read(load(html)).beats.filter((b) => b.id !== 'va-hold')
const scene = env.SCENE ?? beats[Math.floor(beats.length / 2)]?.id ?? ''
const b = beats.find((x) => x.id === scene)
if (!b) throw new Error(`No scene "${scene}". Scenes: ${beats.map((x) => x.id).join(', ')}`)
log('parent', {
  videoId: sourceId,
  n: parent.n,
  scenes: beats.map((x) => x.id),
  scene,
  hasMusic: /data-va-layer="music"/.test(html),
})

const prompt = `${change}

This is a scoped revision of version ${parent.n}: change only this scene, as JSON (start and duration in seconds of version ${parent.n}):
<<<
${JSON.stringify([{ id: b.id, label: b.label, start: b.start, duration: b.duration }])}
>>>
- Everything else is frozen exactly as version ${parent.n} has it: the other scenes (their HTML and scripts), <head>, the root and its styles and scripts, every layer, and every file already in video/.
- Inside the scene you may rewrite anything: its elements, text, media slots, script and sound effects. Keep its data-va-beat and data-composition-id, its place in the order, and text ids that start with "${b.id}-".
- Styles it needs go in one <style> directly inside the scene, holding one @scope { … } block (no selector after @scope). Use only the --va-color-… roles the root declares and fonts the composition already loads. Put new files in video/assets/beats/${b.id}/. Its script selects only inside its own element: use el.querySelector(All) and pass elements to the timeline, never selector strings, and never its parents or siblings.
- Keep its length unless the request asks for a change or the new content needs more or less time; later scenes move with it.
- In summary.json, change only this scene's cues.`
if (PROJECTED > ceiling) throw new Error(`Projected ${PROJECTED} credits is over CREDIT_CEILING ${ceiling}.`)
const revised = await call<{ id: string; version: number }>(
  k,
  'POST',
  `/api/v1/videos/${sourceId}/versions`,
  {
    prompt,
    fromVersion: parent.n,
  },
)
if (revised.status !== 202)
  throw new Error(`Revise answered ${revised.status}: ${revised.text.slice(0, 300)}`)
const n = parent.n + 1
log('revise', { videoId: sourceId, n })

let done: Version | undefined
for (let i = 0; i < 150; i++) {
  const v = (await call<{ versions: Version[] }>(k, 'GET', `/api/v1/videos/${sourceId}`)).json.versions.find(
    (x) => x.n === n,
  )
  if (v && ['ready', 'failed', 'cancelled'].includes(v.status)) {
    done = v
    break
  }
  await sleep(10_000)
}
const ms = Date.now() - started
log('run', {
  status: done?.status ?? 'timeout',
  credits: done?.usage?.totalCreditsCost ?? null,
  minutes: +(ms / 60000).toFixed(1),
})
if (done?.status !== 'ready') throw new Error(`Version ${n} ended ${done?.status ?? 'unfinished'}.`)

const r = hyperframesScopeCheck(parentFiles, sources(`${sourceId}/v${n}.tar.gz`), [scene])
log('scope', {
  inScope: r.problems.length === 0,
  putBack: r.putBack,
  problems: r.problems,
  lengthDelta: r.lengthDelta,
})
log('summary', {
  credits: done.usage?.totalCreditsCost ?? null,
  minutes: +(ms / 60000).toFixed(1),
  inScope: r.problems.length === 0,
  outside: r.problems,
})
