// The callback token is never in a prompt or a command the prompt tells the agent to run. Every way a run starts goes
// through the real reconciler (create, revise, remix, an editor render, a Quick demo, a demo with its recording) and
// its prompt is checked against the token the run actually gets: the run manifest's (no run secret) or the one derived
// from VIDEO_AGENT_RUN_SECRET. Every prompt builder variant (scoped, local, fit and the rest) is checked for --token.
import { describe, expect, it } from 'vitest'
import {
  buildFitPrompt,
  buildPrompt,
  buildQuickDemoPrompt,
  buildRenderUnchangedPrompt,
  PROMPT_TEMPLATE_VERSION,
} from '../src/domain/prompt.js'
import { runAttemptToken } from '../src/lib/run-auth.js'
import { harness, PROMPT, png, runToken, upload, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'
import { readFileSync } from 'node:fs'

const SECRET = 'r'.repeat(16) + 'S'.repeat(16) + 'x'.repeat(8)
const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/contract1-recording/${f}`, import.meta.url), 'utf8')

/** The newest run's prompt and the token that run gets. */
async function lastRun(h: Harness) {
  const req = h.deps.runner.starts.at(-1)
  if (!req) throw new Error('no run started')
  return { prompt: req.prompt, token: await runToken(h.deps, req.requestId), attemptId: req.requestId }
}
const assertClean = (prompt: string, token: string, kind: string) => {
  console.log(
    JSON.stringify({ test: 'prompt-token', kind, tokenLength: token.length, promptLength: prompt.length }),
  )
  expect(token.length, kind).toBeGreaterThanOrEqual(16)
  expect(prompt, kind).not.toContain(token)
  expect(prompt, kind).not.toMatch(/--token\b/)
  expect(prompt, kind).not.toMatch(/Bearer\s/)
}
async function recordingMedia(h: Harness) {
  const m = await h.json<{ id: string }>(await upload(h, h.member, png(300, 100), 'filename=screen.png'))
  await h.deps.store.updateMedia(m.id, {
    role: 'screen-recording',
    kind: 'video',
    ext: 'mp4',
    durationSec: 60,
  })
  return m.id
}

/** Starts each kind of run on one harness and checks each prompt against its run's token. */
async function everyRun(h: Harness) {
  const create = async (body: Record<string, unknown>) =>
    h.json<{ id: string }>(await h.call('POST', '/api/v1/videos', { as: h.member, body }))
  // Create: an authoring run.
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
    { name: 'video/assets/recording/redact.js', body: 'window.__vaRedact=[];' },
  ])
  const v = await create({ prompt: PROMPT })
  await h.drive(1)
  assertClean((await lastRun(h)).prompt, (await lastRun(h)).token, 'create')
  await h.drive(4)
  expect((await h.deps.store.getVersion(v.id, 1))?.status, 'create reaches ready').toBe('ready')
  // Revise.
  await h.call('POST', `/api/v1/videos/${v.id}/versions`, {
    as: h.member,
    body: { prompt: 'Shorter title', fromVersion: 1 },
  })
  await h.drive(1)
  const rev = await lastRun(h)
  assertClean(rev.prompt, rev.token, 'revise')
  await h.drive(4)
  // Remix.
  await h.call('POST', `/api/v1/videos/${v.id}/remix`, {
    as: h.member,
    body: { prompt: 'The same for billing' },
  })
  await h.drive(1)
  const remix = await lastRun(h)
  assertClean(remix.prompt, remix.token, 'remix')
  // An editor render (render unchanged).
  const e = await h.json<{ id: string }>(
    await h.call('POST', `/api/v1/videos/${v.id}/versions/1/edits`, { as: h.member }),
  )
  await h.call('PUT', `/api/v1/edits/${e.id}`, {
    as: h.member,
    body: { rev: 0, ops: [{ op: 'retime', beat: 'add-site', duration: 9 }] },
  })
  const r = await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: h.member })
  expect(r.status, await r.clone().text()).toBe(202)
  await h.drive(1)
  const edit = await lastRun(h)
  expect(edit.prompt).toContain('render')
  assertClean(edit.prompt, edit.token, 'render_unchanged')
  // A demo with its recording, and a Quick demo.
  const media = await recordingMedia(h)
  await create({ prompt: PROMPT, recording: { mediaId: media } })
  await h.drive(1)
  const demo = await lastRun(h)
  assertClean(demo.prompt, demo.token, 'demo')
  await create({ prompt: PROMPT, title: 'Add a site', agent: false, recording: { mediaId: media } })
  await h.drive(1)
  const quick = await lastRun(h)
  assertClean(quick.prompt, quick.token, 'quick')
}

describe('no callback token in any prompt', () => {
  it('without a run secret: the token rides in the run manifest, never the prompt', async () => {
    const h = harness()
    expect(h.deps.config.runSecret).toBeNull()
    await everyRun(h)
  })

  it('with VIDEO_AGENT_RUN_SECRET: the run derives its token, the manifest carries none, callbacks still work', async () => {
    const h = harness({ VIDEO_AGENT_RUN_SECRET: SECRET })
    expect(h.deps.config.runSecret).toBe(SECRET)
    await everyRun(h)
    const { attemptId } = await lastRun(h)
    const a = await h.deps.store.getAttempt(attemptId)
    const raw = await h.deps.blobs.get('sources', `${a?.jobId ?? ''}/runs/${attemptId}.json`)
    expect(new TextDecoder().decode(raw ?? new Uint8Array())).not.toContain('"callback"')
    expect(await runToken(h.deps, attemptId)).toBe(runAttemptToken(SECRET, attemptId))
  })

  it('every prompt builder variant has no --token', () => {
    const base = {
      jobId: 'vid_1',
      attemptId: '0b8a2c1e-0000-4000-8000-000000000000',
      versionN: 2,
      requesterName: 'Mia',
      userPrompt: 'A launch video',
      aspect: '16:9' as const,
      targetDurationSec: 30,
      callbackUrl: 'https://v.example.com/api/internal/runs/x/done',
      checkpointUrl: 'https://v.example.com/api/internal/runs/x/checkpoint',
      upload: { mode: 'blobs' as const },
      revision: null,
      runManifestSha256: 'b'.repeat(64),
    }
    const scope = {
      n: 1,
      beats: [{ id: 'step-2', label: 'Step 2', start: 10, duration: 10 }],
      stills: false,
      voiced: false,
      locked: false,
    }
    const prompts: Record<string, string> = {
      create: buildPrompt(base),
      revise: buildPrompt({ ...base, revision: { parentN: 1 } }),
      scoped: buildPrompt({ ...base, revision: { parentN: 1 }, scope }),
      local: buildPrompt({ ...base, upload: { mode: 'local' } }),
      look: buildPrompt({ ...base, look: { id: 'lk_1', name: 'Clean' } }),
      recording: buildPrompt({
        ...base,
        recording: {
          mediaId: 'med_r',
          file: 'assets/media/med_r.mp4',
          seconds: 60,
          trace: true,
          clicks: [],
          deadlineMin: 25,
        },
      }),
      quick: buildQuickDemoPrompt({ ...base, mediaId: 'med_r', title: 'Demo' }),
      renderUnchanged: buildRenderUnchangedPrompt({
        ...base,
        editedFromN: 1,
        revoice: ['a'],
        narration: true,
        recordingHolds: true,
      }),
      fit: buildFitPrompt({ ...base, editedFromN: 1, targetSamples: 24_000 * 10, revoice: ['a'] }),
    }
    expect(PROMPT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(26)
    for (const [kind, p] of Object.entries(prompts)) {
      expect(p, kind).not.toMatch(/--token\b/)
      expect(p, kind).toMatch(
        /scripts\/render-job\.ts --job \S+ --attempt \S+ --callback \S+ --upload (blobs|local)/,
      )
    }
  })
})
