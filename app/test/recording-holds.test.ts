// Holds in render-unchanged runs (screen-recording plan §5.3; va-rsk5.3.15): an editor retime of a recording scene
// past 0.5x needs a still the browser can't make. The frozen bundle lists it (recordingHolds), the manifest carries it
// (shape-checked, render-unchanged runs only), the prompt has the run make it with recording.ts emit --holds-only, and
// render-job leaves exactly those paths out of the bundle hash and compares each still with a fresh extraction.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  runManifestKey,
  serializeRunManifest,
  verifyRunManifest,
  type RunManifest,
} from '../server/lib/run-manifest.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'
import { makeFixture } from './fixtures/recording/make-fixture.js'
import { analyzeRecording } from '../../scripts/lib/recording-analyze.js'
import { emitStep, holdStillTo } from '../../scripts/lib/recording-emit.js'
import { planRecording } from '../../scripts/lib/recording-plan.js'

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/contract1-recording/${f}`, import.meta.url), 'utf8')
const STILL = 'assets/recording/add-site.hold.jpg'

async function heldEdit(h: Harness) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
    { name: 'video/assets/recording/redact.js', body: 'window.__vaRedact=[];' },
  ])
  const v = await h.json<{ id: string }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  await h.drive(4)
  const e = await h.json<{ id: string }>(
    await h.call('POST', `/api/v1/videos/${v.id}/versions/1/edits`, { as: h.member }),
  )
  const put = await h.call('PUT', `/api/v1/edits/${e.id}`, {
    as: h.member,
    body: { rev: 0, ops: [{ op: 'retime', beat: 'add-site', duration: 25 }] },
  })
  expect(put.status, await put.clone().text()).toBe(200)
  return { id: v.id, editId: e.id }
}

describe('hold stills in render-unchanged runs', () => {
  it('the frozen bundle, the manifest and the prompt carry the still the run makes', async () => {
    const h = harness()
    const { id, editId } = await heldEdit(h)
    const res = await h.call('POST', `/api/v1/edits/${editId}/render`, { as: h.member })
    expect(res.status).toBe(202)
    const v2 = await h.deps.store.getVersion(id, 2)
    console.log(JSON.stringify({ test: 'recording-holds', frozen: v2?.frozen?.recordingHolds }))
    expect(v2?.frozen?.recordingHolds).toEqual([STILL])
    await h.drive(1)
    const req = h.deps.runner.starts.at(-1)
    const sha = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
    const m = verifyRunManifest(
      new TextDecoder().decode(await h.deps.blobs.get('sources', runManifestKey(id, req?.requestId ?? ''))),
      { attemptId: req?.requestId ?? '', sha256: sha },
    )
    expect(m.kind).toBe('render_unchanged')
    expect(m.bundle?.recordingHolds).toEqual([STILL])
    expect(req?.prompt).toContain('npx tsx scripts/recording.ts emit --holds-only')
  })

  it('an edit with no held scene lists none and its prompt is unchanged', async () => {
    const h = harness()
    const { id, editId } = await heldEdit(h)
    await h.call('PUT', `/api/v1/edits/${editId}`, {
      as: h.member,
      body: { rev: 1, ops: [{ op: 'retime', beat: 'add-site', duration: 8 }] },
    })
    await h.call('POST', `/api/v1/edits/${editId}/render`, { as: h.member })
    expect((await h.deps.store.getVersion(id, 2))?.frozen?.recordingHolds).toBeUndefined()
    await h.drive(1)
    expect(h.deps.runner.starts.at(-1)?.prompt).not.toContain('--holds-only')
  })

  it('the manifest shape check: render-unchanged only, still paths only, at most 12', () => {
    const base: RunManifest = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_1',
      versionN: 2,
      kind: 'render_unchanged',
      source: null,
      bundle: {
        key: 'vid_1/v2/frozen.tar.gz',
        sha256: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        recordingHolds: [STILL],
      },
      media: null,
      feedback: null,
    }
    const verify = (m: unknown) => {
      const text = JSON.stringify(m)
      return verifyRunManifest(text, {
        attemptId: 'att_1',
        sha256: createHash('sha256').update(text).digest('hex'),
      })
    }
    expect(verify(base).bundle?.recordingHolds).toEqual([STILL])
    expect(JSON.parse(serializeRunManifest(base)).bundle.recordingHolds).toEqual([STILL])
    const bad: unknown[] = [
      {
        ...base,
        kind: 'revision',
        source: { key: 'vid_1/v1/source.tar.gz', sha256: 'a'.repeat(64), parentN: 1 },
      },
      { ...base, bundle: { ...base.bundle, recordingHolds: ['assets/recording/x.cursor.js'] } },
      { ...base, bundle: { ...base.bundle, recordingHolds: ['../escape.hold.jpg'] } },
      {
        ...base,
        bundle: {
          ...base.bundle,
          recordingHolds: Array.from({ length: 13 }, (_, i) => `assets/recording/s${String(i)}.hold.jpg`),
        },
      },
    ]
    for (const m of bad) expect(() => verify(m)).toThrow('bad recording holds entry')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
describe.runIf(hasFfmpeg)('hold stills: render-job can compare bytes', () => {
  it('extracting a held scene’s still twice gives the same bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-holds-'))
    try {
      const file = makeFixture(join(dir, 'fixture.mp4'))
      const analysis = await analyzeRecording(file)
      const { plan } = planRecording({ mediaId: 'med_fixture', analysis })
      mkdirSync(join(dir, 'video', 'assets', 'media'), { recursive: true })
      copyFileSync(file, join(dir, 'video', 'assets', 'media', 'med_fixture.mp4'))
      const step = plan.steps[0]
      if (!step) throw new Error('no step')
      const r = emitStep({
        videoDir: join(dir, 'video'),
        plan,
        step: step.id,
        analysis,
        trace: null,
        duration: (step.out - step.in) * 3,
      })
      const html = `<!doctype html><html><head></head><body><div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${String(r.duration)}">${r.markup}</div></body></html>`
      const rel = `assets/recording/${step.id}.hold.jpg`
      holdStillTo(join(dir, 'video'), html, rel, join(dir, 'a.jpg'))
      holdStillTo(join(dir, 'video'), html, rel, join(dir, 'b.jpg'))
      expect(readFileSync(join(dir, 'a.jpg')).equals(readFileSync(join(dir, 'b.jpg')))).toBe(true)
      expect(readFileSync(join(dir, 'a.jpg')).equals(readFileSync(join(dir, 'video', rel)))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
