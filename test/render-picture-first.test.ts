// Render picture first (plan 2026-11-02 §2.1, §5.3): with timing edits pending, the editor renders the draft's other
// ops as a normal new version, without its narration op (excludeNarration), then moves the narration onto that
// version with rebase-narration, ready to record against the new picture.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import { harness, PROMPT, upload } from './helpers.js'
import { tarGz } from './tarball.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const S = SAMPLE_RATE

const narration = (mediaId: string) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [
    {
      id: 'c1',
      mediaId,
      srcStart: 0,
      srcEnd: 2 * S,
      fit: { a: 0, b: 1 / S, residualMs: 0 },
      offsetSamples: 0,
      start: S,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ],
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
})

describe('render picture first', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  const source = () =>
    tarGz([
      { name: 'video/index.html', body: fx('index.html') },
      { name: 'video/summary.json', body: fx('summary.json') },
    ])
  async function setup() {
    const h = harness()
    h.deps.nextSource = source()
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    const id = v.id as string
    const m = await h.json<{ id: string }>(await upload(h, h.member, tone(), 'filename=take.mp3'))
    await h.deps.store.updateMedia(m.id, { role: 'narration-take', scopeJobId: id, durationSec: 20 })
    const e = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }),
    )
    const lock = () =>
      h.call('POST', `/api/v1/videos/${id}/narration-lock/take-over`, {
        as: h.member,
        body: { draftId: e.id },
      })
    await lock()
    const ops = [{ op: 'retime', beat: 'intro', duration: 4 }, narration(m.id)]
    expect(
      (await h.call('PUT', `/api/v1/edits/${e.id}`, { as: h.member, body: { rev: 0, ops } })).status,
    ).toBe(200)
    const render = (body: object) =>
      h.call('POST', `/api/v1/edits/${e.id}/render`, {
        as: h.member,
        body: { mode: 'keep_visuals', ...body },
      })
    const rebase = (toN: number) =>
      h.call('POST', `/api/v1/edits/${e.id}/rebase-narration`, { as: h.member, body: { toN } })
    return { h, id, take: m.id, editId: e.id, render, rebase, lock }
  }

  it('freezes the timing edits without the narration, then moves the narration onto the new version', async () => {
    const { h, id, take, editId, render, rebase, lock } = await setup()
    const res = await render({ excludeNarration: true })
    expect(res.status).toBe(202)
    const v2 = await h.deps.store.getVersion(id, 2)
    // A normal new version of the picture: the retime's length, no frozen narration, no takes held by the attempt.
    expect(v2).toMatchObject({ mode: 'render_unchanged', editedFromN: 1, targetDurationSec: 10 })
    expect(v2?.frozen?.editId).toBe(editId)
    expect(v2?.frozen?.narration).toBeUndefined()
    expect(
      h.deps.logs.some((l) => l.includes('"edit.render"') && l.includes('"excludeNarration":true')),
    ).toBe(true)
    // The draft keeps its narration op; it can't move onto a version that isn't ready yet.
    const draft = await h.json<{ ops: { op: string }[]; renderedN: number }>(
      await h.call('GET', `/api/v1/edits/${editId}`, { as: h.member }),
    )
    expect(draft.renderedN).toBe(2)
    expect(draft.ops.map((o) => o.op)).toEqual(['retime', 'narration'])
    expect((await rebase(2)).status).toBe(409)
    h.deps.nextSource = source()
    await h.drive(6)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('ready')
    // Onto v2, the version it made (the editor's heartbeat keeps the lock meanwhile; here the clock ran past it):
    // only the narration moves, since the retime is v2's picture now.
    await lock()
    const moved = await rebase(2)
    expect(moved.status).toBe(201)
    expect(await h.json(moved)).toMatchObject({ baseN: 2, rev: 1, ops: [narration(take)] })
    // Never onto another version.
    expect((await rebase(1)).status).toBe(409)
  }, 60_000)

  it('a normal render of the same draft still freezes the narration, and then nothing rebases', async () => {
    const { h, id, render, rebase, lock } = await setup()
    expect((await render({})).status).toBe(202)
    expect((await h.deps.store.getVersion(id, 2))?.frozen?.narration).toBeDefined()
    h.deps.nextSource = source()
    await h.drive(6)
    await lock()
    expect((await rebase(2)).status).toBe(409)
  }, 60_000)

  it('refuses holding the last frame without the narration', async () => {
    const { render } = await setup()
    const res = await render({ excludeNarration: true, holdFinalFrame: true })
    expect(res.status).toBe(400)
  }, 60_000)
})
