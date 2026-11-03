// The narration edit op (plan 2026-11-02 §6.1): one whole-track snapshot saved through the edits API, checked against
// its takes (bounds, counts, who may use them) and the output-duration limit, held by the draft's media_refs, and
// written into the draft bundle as the narration layer.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editRevPrefix } from '../src/domain/edits.js'
import { resetSettingsCache } from '../src/domain/settings.js'
import { NarrationOpSchema } from '../src/schemas.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import type { Store } from '../src/store/types.js'
import { harness, person, pgStore, PROMPT, upload, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const S = SAMPLE_RATE

/** A ready video whose v1 keeps contract v1 (9 s: intro, demo, outro). */
async function editableVideo(h: Harness) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

/** A recorded take of `seconds` for the video, uploaded by `as`. */
async function take(h: Harness, jobId: string, as = h.member, seconds = 20) {
  const m = await h.json<{ id: string }>(await upload(h, as, tone(), 'filename=take.mp3'))
  await h.deps.store.updateMedia(m.id, { role: 'narration-take', scopeJobId: jobId, durationSec: seconds })
  return m.id
}

const clip = (mediaId: string, over: Record<string, unknown> = {}) => ({
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
  ...over,
})
const narration = (clips: object[], over: Record<string, unknown> = {}) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
  ...over,
})

const openDraft = async (h: Harness, id: string, as = h.member) =>
  h.json<{ id: string; rev: number }>(await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as }))
const save = (h: Harness, editId: string, body: object, as = h.member) =>
  h.call('PUT', `/api/v1/edits/${editId}`, { as, body })
const draftRefs = async (h: Harness, editId: string) =>
  (await h.deps.store.listMediaRefsByOwner('draft', editId)).map((r) => r.mediaId).sort()
const error = async (res: Response) => {
  const body = (await res.json()) as { error: { code: string; message: string } }
  return { status: res.status, ...body.error }
}

describe('narration op schema', () => {
  const ok = narration([clip('med_abcdef12')])
  const bad = (over: object) => NarrationOpSchema.safeParse({ ...ok, ...over }).success
  const badClip = (over: Record<string, unknown>) =>
    NarrationOpSchema.safeParse(narration([clip('med_abcdef12', over)])).success

  it('takes a whole track and drops unknown fields', () => {
    const r = NarrationOpSchema.parse({ ...narration([clip('med_abcdef12', { extra: 1 })]), x: 1 })
    expect(r.clips[0]).not.toHaveProperty('extra')
    expect(r).not.toHaveProperty('x')
    expect(NarrationOpSchema.parse(narration([])).clips).toEqual([])
    expect(badClip({ gainDb: null })).toBe(true)
  })

  it('refuses other versions, rates and cleanups', () => {
    expect(bad({ schema: 2 })).toBe(false)
    expect(bad({ sampleRate: 48_000 })).toBe(false)
    expect(bad({ cleanup: 'heavy' })).toBe(false)
    expect(bad({ tracks: { ...ok.tracks, aiVoice: { mode: 'louder', volumeDb: 0 } } })).toBe(false)
    expect(bad({ clips: Array.from({ length: 201 }, (_, i) => clip('med_abcdef12', { id: `c${i}` })) })).toBe(
      false,
    )
  })

  it('needs integer, finite, in-range samples and levels', () => {
    expect(badClip({ srcStart: 0.5 })).toBe(false)
    expect(badClip({ start: -1 })).toBe(false)
    expect(badClip({ srcEnd: 0 })).toBe(false)
    expect(badClip({ srcStart: 100, srcEnd: 100 })).toBe(false)
    expect(badClip({ gainDb: 13 })).toBe(false)
    expect(badClip({ gainDb: Number.POSITIVE_INFINITY })).toBe(false)
    expect(badClip({ fit: { a: Number.NaN, b: 1 / S, residualMs: 0 } })).toBe(false)
    expect(badClip({ fit: { a: 0, b: 0, residualMs: 0 } })).toBe(false)
    expect(badClip({ mediaId: 'https://evil.example/x.wav' })).toBe(false)
  })

  it('keeps fades within half the clip and 2 s', () => {
    expect(badClip({ srcEnd: 1000, fadeInSamples: 500 })).toBe(true)
    expect(badClip({ srcEnd: 1000, fadeInSamples: 501 })).toBe(false)
    expect(badClip({ srcEnd: 10 * S, fadeOutSamples: 2 * S })).toBe(true)
    expect(badClip({ srcEnd: 10 * S, fadeOutSamples: 2 * S + 1 })).toBe(false)
  })
})

describe('saving a narration op', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  const stores: [string, () => Promise<Store | undefined>][] = [
    ['memory', async () => undefined],
    ['postgres', pgStore],
  ]
  it.each(stores)(
    'saves with rev checks, writes the layer and holds exactly its takes (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const id = await editableVideo(h)
      const [a, b] = [await take(h, id), await take(h, id)]
      const e = await openDraft(h, id)
      const op = narration([clip(a), clip(b, { id: 'c2', start: 4 * S })])
      const res = await save(h, e.id, { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4 }, op] })
      expect(res.status).toBe(200)
      const saved = await h.json(res)
      expect(saved.rev).toBe(1)
      expect(saved.ops[1]).toEqual(op)
      expect(saved.composition.duration).toBe(10)
      expect(saved.composition.audio.find((x: { role: string }) => x.role === 'narration')).toMatchObject({
        id: 'va-narration',
        src: 'assets/narration/bus.wav',
      })
      const html = new TextDecoder().decode(
        await h.deps.blobs.get('bundles', `${editRevPrefix(id, 1, e.id, 1)}f/index.html`),
      )
      // Each take counts as speech throughout until it has a summary: 1-3 s and 4-6 s, joined across the short gap.
      expect(html).toMatch(/id="va-narration"[^>]*data-va-speech="\[\[1,6\]\]"/)
      expect(await draftRefs(h, e.id)).toEqual([a, b].sort())
      // A stale rev changes nothing.
      const stale = await save(h, e.id, { rev: 0, ops: [narration([clip(a)])] })
      expect(stale.status).toBe(409)
      expect(await draftRefs(h, e.id)).toEqual([a, b].sort())
      // Dropping the narration releases its takes.
      expect((await save(h, e.id, { rev: 1, ops: [narration([clip(b)])] })).status).toBe(200)
      expect(await draftRefs(h, e.id)).toEqual([b])
      expect((await save(h, e.id, { rev: 2, ops: [] })).status).toBe(200)
      expect(await draftRefs(h, e.id)).toEqual([])
      expect((await h.deps.store.getMedia(b))?.retainUntil).not.toBeNull()
    },
    60_000,
  )

  it('uses the take summary in meta.json when there is one', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const a = await take(h, id)
    await h.deps.blobs.set(
      'media',
      `${a}/meta.json`,
      JSON.stringify({ samples: 3 * S, speech: [[S / 2, S]] }),
    )
    const e = await openDraft(h, id)
    expect((await save(h, e.id, { rev: 0, ops: [narration([clip(a, { srcEnd: 3 * S })])] })).status).toBe(200)
    const html = new TextDecoder().decode(
      await h.deps.blobs.get('bundles', `${editRevPrefix(id, 1, e.id, 1)}f/index.html`),
    )
    expect(html).toMatch(/data-va-speech="\[\[1\.5,2\]\]"/)
    // Its length is the summary's, not the row's.
    const past = await save(h, e.id, { rev: 1, ops: [narration([clip(a, { srcEnd: 3 * S + 1 })])] })
    expect(await error(past)).toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it('refuses ops past their takes, the output limit or the counts', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const a = await take(h, id, h.member, 20)
    const e = await openDraft(h, id)
    const attempt = async (ops: object[]) => error(await save(h, e.id, { rev: 0, ops }))
    expect(await attempt([narration([clip(a, { srcEnd: 20 * S + 1 })])])).toMatchObject({
      status: 400,
      message: expect.stringContaining('runs past the end of its recording'),
    })
    // 9 s of video: the narration may run to 129 s.
    expect(await attempt([narration([clip(a, { start: 127 * S + 1 })])])).toMatchObject({
      status: 400,
      message: expect.stringContaining('129s at most'),
    })
    expect(await attempt([narration([clip(a)]), narration([clip(a)])])).toMatchObject({ status: 400 })
    const many = Array.from({ length: 33 }, (_, i) =>
      clip(`med_fake${String(i).padStart(6, '0')}`, { id: `c${i}`, start: i * 3 * S }),
    )
    expect(await attempt([narration(many)])).toMatchObject({
      status: 400,
      message: 'A narration uses at most 32 recordings.',
    })
    expect(await attempt([narration([clip(a, { srcStart: 0.5 })])])).toMatchObject({ status: 400 })
    expect(await draftRefs(h, e.id)).toEqual([])
    // At the limit is fine.
    const end = await save(h, e.id, { rev: 0, ops: [narration([clip(a, { start: 127 * S })])] })
    expect(end.status).toBe(200)
  })

  it("only places takes the saver may use; the base version's stay usable through a soft delete", async () => {
    const h = harness()
    const id = await editableVideo(h)
    const cora = await person(h, 'u_cora', 'creator')
    const coras = await take(h, id, cora)
    const mine = await take(h, id)
    const e = await openDraft(h, id)
    const missing = await error(await save(h, e.id, { rev: 0, ops: [narration([clip('med_nothere00')])] }))
    const hidden = await error(await save(h, e.id, { rev: 0, ops: [narration([clip(coras)])] }))
    // An unused take of someone else's reads exactly like one that doesn't exist.
    expect(hidden).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(hidden.message.replace(coras, 'X')).toBe(missing.message.replace('med_nothere00', 'X'))
    // A take in v1's narration is inherited, even after Cora deletes it.
    await h.deps.store.insertMediaRefs([
      {
        mediaId: coras,
        ownerKind: 'version',
        ownerId: `${id}#1`,
        jobId: id,
        createdAt: '2026-11-01T00:00:00Z',
      },
    ])
    await h.call('DELETE', `/api/v1/media/${coras}`, { as: cora })
    expect((await h.deps.store.getMedia(coras))?.deletedAt).not.toBeNull()
    const inherited = await save(h, e.id, {
      rev: 0,
      ops: [narration([clip(coras), clip(mine, { id: 'c2', start: 4 * S })])],
    })
    expect(inherited.status).toBe(200)
    expect(await draftRefs(h, e.id)).toEqual([coras, mine].sort())
    // My own take, deleted and not in v1, can't be placed again.
    await h.call('DELETE', `/api/v1/media/${mine}`, { as: h.member })
    expect(
      (await error(await save(h, e.id, { rev: 1, ops: [narration([clip(mine, { start: 4 * S })])] }))).status,
    ).toBe(400)
    // A take GC has begun deleting is gone, inherited or not.
    await h.deps.store.updateMedia(coras, { deletingAt: '2026-11-02T00:00:00Z' })
    expect((await save(h, e.id, { rev: 1, ops: [narration([clip(coras)])] })).status).toBe(400)
  })

  it('is refused while recorded voice-over is off; other edits still save', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const a = await take(h, id)
    const e = await openDraft(h, id)
    await h.deps.store.updateSettings({ narrationEnabled: false })
    resetSettingsCache()
    expect(await error(await save(h, e.id, { rev: 0, ops: [narration([clip(a)])] }))).toMatchObject({
      status: 409,
      code: 'narration_disabled',
    })
    expect(
      (await save(h, e.id, { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4 }] })).status,
    ).toBe(200)
    await h.deps.store.updateSettings({ narrationEnabled: true })
    resetSettingsCache()
    expect((await save(h, e.id, { rev: 1, ops: [narration([clip(a)])] })).status).toBe(200)
  })
})
