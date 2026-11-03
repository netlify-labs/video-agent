// Finalizing a render of recorded narration (plan 2026-11-02 §6.1 Version fields, §6.6, bead va-2qq.3.18): the
// version records what was mixed (the frozen op, the recipe with ffmpeg's version from the run's receipt, the bus as
// stored) and its captions (transcription status, policy, rev 0); the attempt's take references become the version's.
// A failed or cancelled attempt lets go of its references instead (their 30 days start), and a retry takes them again.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { narrationReportOf, wavSamples } from '../src/domain/finalize.js'
import { TAKE_RETAIN_MS } from '../src/domain/takes.js'
import type { NarrationReport } from '../src/domain/types.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'
import type { Store } from '../src/store/types.js'
import { failedSnap, running } from './fakes.js'
import { harness, pgStore, PROMPT, upload, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const S = SAMPLE_RATE
const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
/** The processed bus the fake run uploads: 9 s of 24 kHz mono PCM16. */
const BUS = wav(new Uint8Array(9 * S * 2).map((_, i) => i % 7))

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]

const report = (over: Partial<NarrationReport> = {}): NarrationReport => ({
  pipeline: 1,
  cleanup: 'light',
  ffmpeg: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
  bus: { sha256: sha256Hex(BUS), samples: 9 * S },
  stt: { status: 'ok', provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3', words: 12 },
  ...over,
})

/** A ready, editable v1, n takes for it and a draft whose narration plays them. */
async function narratedDraft(h: Harness, n = 2) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const id = v.id as string
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const m = await h.json<{ id: string }>(await upload(h, h.member, tone(), 'filename=take.mp3'))
    await h.deps.store.updateMedia(m.id, { role: 'narration-take', scopeJobId: id, durationSec: 20 })
    ids.push(m.id)
  }
  const e = await h.json<{ id: string }>(
    await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }),
  )
  const clips = ids.map((mediaId, i) => ({
    id: `c${i}`,
    mediaId,
    srcStart: 0,
    srcEnd: S,
    fit: { a: 0, b: 1 / S, residualMs: 0 },
    offsetSamples: 0,
    start: (1 + 2 * i) * S,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
  }))
  const op = {
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
  }
  expect(
    (await h.call('PUT', `/api/v1/edits/${e.id}`, { as: h.member, body: { rev: 0, ops: [op] } })).status,
  ).toBe(200)
  return { id, editId: e.id, ids: ids.sort() }
}

const render = (h: Harness, editId: string) =>
  h.call('POST', `/api/v1/edits/${editId}/render`, { as: h.member })
/** The draft lets go of its takes, so only the attempt holds them (and a release starts their 30 days). */
const dropDraftRefs = (h: Harness, editId: string) => h.deps.store.deleteMediaRefs('draft', editId)
const refs = async (h: Harness, kind: 'frozen_attempt' | 'version', owner: string) =>
  (await h.deps.store.listMediaRefsByOwner(kind, owner)).map((r) => r.mediaId).sort()
const attemptRefs = async (h: Harness, jobId: string) => {
  const out: Record<string, string[]> = {}
  for (const a of await h.attempts(jobId)) {
    const ids = await refs(h, 'frozen_attempt', a.id)
    if (ids.length) out[a.id] = ids
  }
  return out
}
const logged = (h: Harness, event: string) =>
  h.deps.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event)

describe('finalizing recorded narration', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  it.each(stores)(
    'records the narration and captions, and the takes become the version’s (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const { id, editId, ids } = await narratedDraft(h)
      h.deps.nextBus = BUS
      h.deps.nextExtra = { manifest: { narration: report() } }
      expect((await render(h, editId)).status).toBe(202)
      await h.drive(4)
      const v = (await h.deps.store.getVersion(id, 2))!
      expect(v.status).toBe('ready')
      const out = (await h.deps.store.getOutput(id, 2))!
      expect(v.narration).toEqual({
        op: v.frozen!.narration!.op,
        recipe: {
          pipeline: 1,
          ffmpegVersion: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
          settings: { cleanup: 'light' },
        },
        bus: { key: `${id}/v2/narration-bus.wav`, sha256: sha256Hex(BUS), samples: 9 * S },
      })
      expect(v.captions).toEqual({
        status: 'ok',
        policy: 'sidecar',
        rev: 0,
        files: { vtt: 'captions.vtt', transcript: null },
        sha256: { vtt: out.sha256['captions.vtt'], transcript: null },
        generation: 0,
      })
      expect(await refs(h, 'version', `${id}#2`)).toEqual(ids)
      expect(await attemptRefs(h, id)).toEqual({})
      // Held by the version, so no retention clock runs on them.
      for (const m of ids) expect((await h.deps.store.getMedia(m))?.retainUntil).toBeNull()
      expect(logged(h, 'finalize.narration')[0]).toMatchObject({ jobId: id, versionN: 2, captions: 'ok' })
      // A version without recorded narration has neither.
      const v1 = (await h.deps.store.getVersion(id, 1))!
      expect(v1.narration ?? null).toBeNull()
      expect(v1.captions ?? null).toBeNull()
    },
    60_000,
  )

  it('keeps the transcription status, and the verified bus over what the run reported', async () => {
    const h = harness()
    const { id, editId } = await narratedDraft(h, 1)
    h.deps.nextBus = BUS
    h.deps.nextExtra = {
      manifest: {
        narration: report({
          bus: { sha256: 'f'.repeat(64), samples: 3 },
          stt: { status: 'timeout', provider: 'parakeet', model: null, words: 0 },
        }),
      },
    }
    expect((await render(h, editId)).status).toBe(202)
    await h.drive(4)
    const v = (await h.deps.store.getVersion(id, 2))!
    expect(v.narration?.bus).toEqual({
      key: `${id}/v2/narration-bus.wav`,
      sha256: sha256Hex(BUS),
      samples: 9 * S,
    })
    expect(v.captions?.status).toBe('timeout')
    expect(logged(h, 'finalize.narration_report_mismatch')).toHaveLength(1)
  })

  it('without a usable report: the frozen recipe, no ffmpeg version and failed captions', async () => {
    const h = harness()
    const { id, editId } = await narratedDraft(h, 1)
    h.deps.nextBus = BUS
    h.deps.nextExtra = { manifest: { narration: { pipeline: 'one' } as unknown as NarrationReport } }
    expect((await render(h, editId)).status).toBe(202)
    await h.drive(4)
    const v = (await h.deps.store.getVersion(id, 2))!
    expect(v.status).toBe('ready')
    expect(v.narration?.recipe).toEqual({ pipeline: 1, ffmpegVersion: '', settings: { cleanup: 'light' } })
    expect(v.captions?.status).toBe('failed')
    expect(logged(h, 'finalize.narration_report_invalid')).toHaveLength(1)
  })

  it('a narrated render without its bus fails, and lets go of its takes', async () => {
    const h = harness()
    const { id, editId, ids } = await narratedDraft(h, 1)
    expect((await render(h, editId)).status).toBe(202)
    await dropDraftRefs(h, editId)
    await h.drive(4)
    const a = (await h.attempts(id)).find((x) => x.versionN === 2)!
    expect(a).toMatchObject({ stage: 'failed', errorCategory: 'invalid_output' })
    expect((await h.deps.store.getVersion(id, 2))?.narration ?? null).toBeNull()
    expect(await attemptRefs(h, id)).toEqual({})
    expect(await refs(h, 'version', `${id}#2`)).toEqual([])
    expect((await h.deps.store.getMedia(ids[0]!))?.retainUntil).not.toBeNull()
  })

  it.each(stores)(
    'a failed attempt releases its takes (30 days from then); a retry takes them and its success keeps them (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const { id, editId, ids } = await narratedDraft(h)
      h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
      expect((await render(h, editId)).status).toBe(202)
      const first = (await h.attempts(id)).find((x) => x.versionN === 2)!
      expect(await attemptRefs(h, id)).toEqual({ [first.id]: ids })
      await dropDraftRefs(h, editId)
      await h.drive(5)
      expect((await h.deps.store.getVersion(id, 2))?.status).toBe('failed')
      expect(await attemptRefs(h, id)).toEqual({})
      const failedAt = (await h.deps.store.getAttempt(first.id))!.endedAt!
      for (const m of ids)
        expect((await h.deps.store.getMedia(m))?.retainUntil).toBe(
          new Date(new Date(failedAt).getTime() + TAKE_RETAIN_MS).toISOString(),
        )

      h.deps.nextBus = BUS
      h.deps.nextExtra = { manifest: { narration: report() } }
      expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/retry`, { as: h.member })).status).toBe(
        202,
      )
      const second = (await h.attempts(id)).find((x) => x.versionN === 2 && x.id !== first.id)!
      expect(await attemptRefs(h, id)).toEqual({ [second.id]: ids })
      await h.drive(4)
      const v = (await h.deps.store.getVersion(id, 2))!
      expect(v.status).toBe('ready')
      expect(v.narration?.bus.sha256).toBe(sha256Hex(BUS))
      expect(await attemptRefs(h, id)).toEqual({})
      expect(await refs(h, 'version', `${id}#2`)).toEqual(ids)
    },
    60_000,
  )

  it('a cancelled attempt releases its takes', async () => {
    const h = harness()
    const { id, editId, ids } = await narratedDraft(h, 1)
    h.deps.runner.nextScripts.push({ timeline: [running(), running(), running(), running()] })
    expect((await render(h, editId)).status).toBe(202)
    await h.drive(1)
    expect(Object.values(await attemptRefs(h, id))).toEqual([ids])
    await dropDraftRefs(h, editId)
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/cancel`, { as: h.member })).status).toBe(
      202,
    )
    await h.drive(3)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('cancelled')
    expect(await attemptRefs(h, id)).toEqual({})
    expect((await h.deps.store.getMedia(ids[0]!))?.retainUntil).not.toBeNull()
  })
})

describe('the run’s narration report', () => {
  it('takes a well-formed one, bounded, and refuses anything else', () => {
    expect(narrationReportOf(report())).toEqual(report())
    expect(narrationReportOf({ ...report(), ffmpeg: 'x'.repeat(500) })?.ffmpeg).toHaveLength(200)
    expect(narrationReportOf({ ...report(), stt: null })?.stt).toBeNull()
    for (const bad of [
      null,
      'report',
      { ...report(), cleanup: 'heavy' },
      { ...report(), bus: { sha256: 'nope', samples: 1 } },
      { ...report(), bus: { sha256: 'a'.repeat(64), samples: -1 } },
      { ...report(), stt: { status: 'great' } },
      { ...report(), pipeline: 1.5 },
    ])
      expect(narrationReportOf(bad)).toBeNull()
  })

  it('reads a WAV’s length from its headers', () => {
    expect(wavSamples(BUS)).toBe(9 * S)
    expect(wavSamples(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
