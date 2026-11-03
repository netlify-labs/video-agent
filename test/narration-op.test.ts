// The narration edit op (plan 2026-11-02 §6.1): one whole-track snapshot saved through the edits API, checked against
// its takes (bounds, counts, who may use them) and the output-duration limit, held by the draft's media_refs, and
// written into the draft bundle as the narration layer. A keep-visuals render freezes it (§6.1 Snapshots, §6.3): the
// audible op, its takes by key, the recipe and the bus length, held by the attempt and carried in the run manifest.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editRevPrefix } from '../src/domain/edits.js'
import { holdBeatOf, load, read as readComposition, validate } from '../src/lib/contract.js'
import { resetSettingsCache } from '../src/domain/settings.js'
import { NarrationOpSchema } from '../src/schemas.js'
import {
  RUN_MANIFEST_VERSION,
  runManifestKey,
  serializeRunManifest,
  sha256Hex,
  verifyRunManifest,
  type FrozenNarration,
  type RunManifest,
} from '../src/lib/run-manifest.js'
import { readTarGz } from '../src/lib/tar.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import { failedSnap, running } from './fakes.js'
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

describe('rendering narration with the visuals kept', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  const render = (h: Harness, editId: string, body?: object, key?: string) =>
    h.call('POST', `/api/v1/edits/${editId}/render`, {
      as: h.member,
      ...(body ? { body } : {}),
      ...(key ? { headers: { 'idempotency-key': key } } : {}),
    })
  const attemptRefs = async (h: Harness, jobId: string) => {
    const out: Record<string, string[]> = {}
    for (const a of await h.attempts(jobId)) {
      const ids = (await h.deps.store.listMediaRefsByOwner('frozen_attempt', a.id)).map((r) => r.mediaId)
      if (ids.length) out[a.id] = ids.sort()
    }
    return out
  }
  /** A draft whose narration is saved; returns the ids. */
  async function narrated(h: Harness, clips: (ids: string[]) => object[], n = 3) {
    const id = await editableVideo(h)
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push(await take(h, id))
    const e = await openDraft(h, id)
    const res = await save(h, e.id, { rev: 0, ops: [narration(clips(ids))] })
    expect(res.status).toBe(200)
    return { id, editId: e.id, ids }
  }

  it('freezes the audible op, its takes by key, the recipe and the target; the attempt holds the takes', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId, ids } = await narrated(h, ([a, b, c]) => [
      clip(a!, { srcEnd: 3 * S }),
      // Silent, and wholly under a later clip: neither plays.
      clip(b!, { id: 'c2', start: 5 * S, gainDb: null }),
      clip(c!, { id: 'c3', start: 2 * S, srcEnd: S }),
      clip(c!, { id: 'c4', start: 2 * S, srcEnd: S }),
    ])
    const [a, b, c] = ids as [string, string, string]
    // Library audio used as narration keeps its licence.
    await h.deps.store.updateMedia(a, { role: null, license: 'by' })
    const res = await render(h, editId)
    expect(res.status).toBe(202)
    const version = (await h.deps.store.getVersion(id, 2))!
    const frozen = version.frozen!.narration!
    const ma = (await h.deps.store.getMedia(a))!
    const mc = (await h.deps.store.getMedia(c))!
    expect(frozen.takes).toEqual([
      { mediaId: a, key: ma.cleanKey, sha256: ma.cleanSha256, bytes: ma.bytes, license: 'by' },
      { mediaId: c, key: mc.cleanKey, sha256: mc.cleanSha256, bytes: mc.bytes },
    ])
    expect(frozen.takes.map((t) => t.mediaId)).not.toContain(b)
    // Resolved: c4 replaces c3 and cuts a's clip in two around it.
    expect(frozen.op.clips.map((x) => [x.id, x.mediaId, x.start, x.srcStart, x.srcEnd])).toEqual([
      ['c1', a, S, 0, S],
      ['c4', c, 2 * S, 0, S],
      ['c1~2', a, 3 * S, 2 * S, 3 * S],
    ])
    expect(frozen).toMatchObject({
      recipe: { pipeline: 1, cleanup: 'light' },
      targetSamples: 9 * S,
      captions: 'sidecar',
    })
    expect(version.targetDurationSec).toBe(9)
    // Takes stay out of the version's media snapshot and the frozen archive; the attempt holds them.
    expect((await h.deps.store.listVersionMedia(id, 2)).map((m) => m.mediaId)).not.toContain(c)
    expect([...readTarGz((await h.deps.blobs.get('sources', version.frozen!.key))!).keys()]).not.toContain(
      'assets/narration/bus.wav',
    )
    expect(Object.values(await attemptRefs(h, id))).toEqual([[a, c].sort()])
  })

  it('holds the final frame for an overrun plus 0.5 s, in whole frames, within the output limit', async () => {
    const target = async (start: number, length: number, hold?: boolean) => {
      const h = harness({ MAX_ACTIVE_RUNS: '0' })
      const { id, editId } = await narrated(h, ([a]) => [clip(a!, { start, srcEnd: length })], 1)
      const res = await render(h, editId, hold === undefined ? undefined : { holdFinalFrame: hold })
      if (res.status !== 202) return (await error(res)).message
      return (await h.deps.store.getVersion(id, 2))!.frozen!.narration!.targetSamples
    }
    // 9 s of video; the narration ends at 10 s + 10 samples: + 0.5 s is 10.500417 s, so 316 frames.
    expect(await target(8 * S, 2 * S + 10, true)).toBe(316 * 800)
    expect(await target(8 * S, 2 * S + 10, false)).toBe(9 * S)
    expect(await target(8 * S, 2 * S + 10)).toBe(9 * S)
    // No overrun: nothing to hold.
    expect(await target(S, S, true)).toBe(9 * S)
    // Ending exactly at the 129 s limit saves, but holding past it doesn't render.
    expect(await target(127 * S, 2 * S, true)).toContain('129s at most')
  })

  it('freezes the held frame as the last beat of the composition, matching the bus length', async () => {
    const frozenHtml = async (hold: boolean) => {
      const h = harness({ MAX_ACTIVE_RUNS: '0' })
      const { id, editId } = await narrated(h, ([a]) => [clip(a!, { start: 8 * S, srcEnd: 2 * S + 10 })], 1)
      expect((await render(h, editId, { holdFinalFrame: hold })).status).toBe(202)
      const version = (await h.deps.store.getVersion(id, 2))!
      const files = readTarGz((await h.deps.blobs.get('sources', version.frozen!.key))!)
      const html = new TextDecoder().decode(files.get('index.html'))
      return { html, version }
    }
    const { html, version } = await frozenHtml(true)
    // 316 frames of bus: the 9 s of visuals and a 1.533333 s hold (46 frames) of the last frame.
    expect(holdBeatOf(load(html))).toEqual({ beat: 'va-hold', start: 9, duration: 1.533333 })
    expect(validate(html)).toEqual([])
    const c = readComposition(load(html))
    expect(c.duration * S).toBeCloseTo(version.frozen!.narration!.targetSamples, 0)
    expect(version.targetDurationSec).toBeCloseTo(316 / 30, 6)
    expect(html).toMatch(/<audio id="va-narration"[^>]*data-duration="10.533333"/)
    expect(holdBeatOf(load((await frozenHtml(false)).html))).toBeNull()
  })

  it('refuses more than 400 MB of takes', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { editId, ids } = await narrated(h, ([a, b]) => [clip(a!), clip(b!, { id: 'c2', start: 4 * S })], 2)
    for (const m of ids) await h.deps.store.updateMedia(m, { bytes: 201 * 1024 * 1024 })
    expect(await error(await render(h, editId))).toMatchObject({
      status: 400,
      message: expect.stringContaining('400 MB'),
    })
    expect(await h.deps.store.getVersion((await h.deps.store.getEdit(editId))!.jobId, 2)).toBeNull()
  })

  it('replays the same request once; another mode or settings under the key is a conflict', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await narrated(h, ([a]) => [clip(a!)], 1)
    expect(await error(await render(h, editId, { mode: 'fit_to_narration' }))).toMatchObject({
      status: 400,
      message: expect.stringContaining("isn't available yet"),
    })
    expect((await render(h, editId, { mode: 'sideways' })).status).toBe(400)
    expect((await render(h, editId, { holdFinalFrame: true }, 'k1')).status).toBe(202)
    expect((await render(h, editId, { holdFinalFrame: true }, 'k1')).status).toBe(202)
    expect((await render(h, editId, { holdFinalFrame: false }, 'k1')).status).toBe(409)
    expect((await render(h, editId, { holdFinalFrame: true, captions: 'burned' }, 'k1')).status).toBe(409)
    expect((await h.deps.store.listVersions(id)).map((v) => v.n).sort()).toEqual([1, 2])
    expect(Object.keys(await attemptRefs(h, id))).toHaveLength(1)
  })

  it('is refused while recorded voice-over is off', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { editId } = await narrated(h, ([a]) => [clip(a!)], 1)
    await h.deps.store.updateSettings({ narrationEnabled: false })
    resetSettingsCache()
    expect(await error(await render(h, editId))).toMatchObject({ status: 409, code: 'narration_disabled' })
  })

  it('carries frozen.narration in the run manifest, and a retry moves the takes to the new attempt', async () => {
    const h = harness()
    const { id, editId, ids } = await narrated(h, ([a]) => [clip(a!)], 1)
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    expect((await render(h, editId)).status).toBe(202)
    await h.drive(5)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('failed')
    const req = h.deps.runner.starts[1]!
    const sha = /--manifest ([0-9a-f]{64})/.exec(req.prompt)?.[1] ?? ''
    const raw = new TextDecoder().decode(await h.deps.blobs.get('sources', runManifestKey(id, req.requestId)))
    const m = verifyRunManifest(raw, { attemptId: req.requestId, sha256: sha })
    expect(m.bundle?.narration).toEqual((await h.deps.store.getVersion(id, 2))!.frozen!.narration)
    const before = await attemptRefs(h, id)
    expect(Object.keys(before)).toEqual([req.requestId])
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/retry`, { as: h.member })).status).toBe(202)
    const after = await attemptRefs(h, id)
    expect(Object.keys(after)).not.toContain(req.requestId)
    expect(Object.values(after)).toEqual([ids])
  })
})

describe('run manifest narration', () => {
  const H = (c: string) => c.repeat(64)
  const narr: FrozenNarration = {
    op: narration([clip('med_abcdef12', { gainDb: null })]) as FrozenNarration['op'],
    takes: [{ mediaId: 'med_abcdef12', key: 'med_abcdef12/original.wav', sha256: H('e'), bytes: 1000 }],
    recipe: { pipeline: 1, cleanup: 'light' },
    targetSamples: 9 * S,
    captions: 'sidecar',
  }
  const manifest = (n: unknown): RunManifest => ({
    v: RUN_MANIFEST_VERSION,
    jobId: 'vid_1',
    attemptId: 'att_1',
    versionN: 2,
    kind: 'render_unchanged',
    source: null,
    bundle: {
      key: 'vid_1/v2/frozen.tar.gz',
      sha256: H('b'),
      manifestHash: H('c'),
      narration: n as FrozenNarration,
    },
    media: null,
    feedback: null,
  })
  const verify = (n: unknown) => {
    const raw = serializeRunManifest(manifest(n))
    return verifyRunManifest(raw, { attemptId: 'att_1', sha256: sha256Hex(raw) })
  }

  it('round-trips, with stable bytes whatever order the stored keys come back in', () => {
    expect(verify(narr).bundle?.narration).toEqual(narr)
    const flip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).reverse()) as T
    const reorder = flip({
      ...narr,
      op: flip({ ...narr.op, clips: narr.op.clips.map(flip), tracks: flip(narr.op.tracks) }),
      takes: narr.takes.map(flip),
    })
    expect(Object.keys(reorder)[0]).toBe('captions')
    expect(serializeRunManifest(manifest(reorder))).toBe(serializeRunManifest(manifest(narr)))
    const without = manifest(narr)
    delete without.bundle!.narration
    expect(serializeRunManifest(without)).not.toContain('narration')
  })

  it('refuses takes outside their own prefix, over the caps, or clips of takes it does not carry', () => {
    const take = narr.takes[0]!
    const bad = [
      { ...narr, takes: [{ ...take, key: 'med_other123/original.wav' }] },
      { ...narr, takes: [{ ...take, key: 'vid_1/v1/source.tar.gz' }] },
      { ...narr, takes: [{ ...take, bytes: 401 * 1024 * 1024 }] },
      { ...narr, takes: [take, take] },
      {
        ...narr,
        takes: Array.from({ length: 33 }, (_, i) => ({
          ...take,
          mediaId: `med_t${String(i).padStart(8, '0')}`,
          key: `med_t${String(i).padStart(8, '0')}/original.wav`,
        })),
      },
      { ...narr, takes: [] },
      { ...narr, targetSamples: 0 },
      { ...narr, recipe: { pipeline: 1, cleanup: 'off' } },
      { ...narr, captions: 'open' },
      { ...narr, op: { ...narr.op, clips: [{ ...narr.op.clips[0], srcStart: 0.5 }] } },
    ]
    for (const n of bad) expect(() => verify(n), JSON.stringify(n).slice(0, 120)).toThrow(/bad narration/)
  })
})
