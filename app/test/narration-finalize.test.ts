// Finalizing a render of recorded narration (plan 2026-11-02 §6.1 Version fields, §6.6, bead va-2qq.3.18): the
// version records what was mixed (the frozen op, the recipe with ffmpeg's version from the run's receipt, the bus as
// stored) and its captions (transcription status, policy, rev 0); the attempt's take references become the version's.
// A failed or cancelled attempt lets go of its references instead (their 30 days start), and a retry takes them again.
import { describe, expect, it } from 'vitest'
import { narrationOpHash } from '../server/domain/captions.js'
import { narrationReportOf, wavSamples } from '../server/domain/finalize.js'
import { TAKE_RETAIN_MS } from '../server/domain/takes.js'
import type { NarrationReport } from '../server/domain/types.js'
import { sha256Hex } from '../server/lib/crypto.js'
import type { Store } from '../server/store/types.js'
import { failedSnap, running } from './fakes.js'
import { harness, pgStore, stubNetlify, type Harness } from './helpers.js'
import { BUS, dropDraftRefs, narratedDraft, render, report, S } from './narration-render.js'

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]

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
  stubNetlify()

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
        opHash: narrationOpHash(v.frozen!.narration!.op),
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
      { ...report(), cleanup: 'extreme' },
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
