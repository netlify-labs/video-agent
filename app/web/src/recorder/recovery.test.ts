// The recovery store and offer in Node (plan 2026-11-02 §5.1, "Recovery record"), on the in-memory store: CRUD and the
// merge that keeps the page's clock fields when the worker writes progress, owner scoping, the 7-day sweep, and a take
// cut off mid-recording coming back from its chunks.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodePeaks } from '../../../server/lib/peaks'
import { recoverableTakes, recoverTake } from './recovery'
import { CHUNK_SAMPLES, isQuotaError, MemoryRecoveryStore, RECOVERY_TTL_MS } from './store'
import { takeRecord } from './take-fixture'
import { TakeWriter } from './take-writer'

const DAY = 24 * 3600_000
const chunk = (take: string, seq: number, samples = CHUNK_SAMPLES) => ({
  take,
  seq,
  pcm: new Uint8Array(samples * 2).fill(seq + 1).buffer,
})

describe('MemoryRecoveryStore', () => {
  it('creates, merges, lists, reads chunks and deletes', async () => {
    const s = new MemoryRecoveryStore()
    await s.patchTake('a', takeRecord({ id: 'a' }))
    await s.putChunk(chunk('a', 0), { id: 'a', chunks: 1, samples: CHUNK_SAMPLES })
    await s.putChunk(chunk('a', 1, 100), { id: 'a', chunks: 2, samples: CHUNK_SAMPLES + 100 })
    expect(await s.getTake('a')).toMatchObject({ chunks: 2, samples: CHUNK_SAMPLES + 100, userId: 'u_1' })
    const got = await s.chunkRange('a', 0, 2)
    expect(got.map((c) => [c.seq, c.pcm.byteLength])).toEqual([
      [0, CHUNK_SAMPLES * 2],
      [1, 200],
    ])
    await s.deleteTake('a')
    expect(await s.getTake('a')).toBeUndefined()
    expect(await s.chunkRange('a', 0, 2)).toEqual([])
  })

  it("keeps the page's clock and placement fields when the worker writes progress", async () => {
    const s = new MemoryRecoveryStore()
    await s.patchTake('a', takeRecord({ id: 'a' }))
    await s.patchTake('a', {
      clock: { anchors: [[0, 1]], fit: null },
      placement: { start: 480, offsetSamples: 0 },
    })
    await s.putChunk(chunk('a', 0), { id: 'a', chunks: 1 })
    expect(await s.getTake('a')).toMatchObject({
      chunks: 1,
      clock: { anchors: [[0, 1]] },
      placement: { start: 480 },
    })
  })

  it('lists only the owner’s takes, newest first', async () => {
    const s = new MemoryRecoveryStore()
    await s.patchTake('a', takeRecord({ id: 'a', userId: 'u_1', createdAt: 1 }))
    await s.patchTake('b', takeRecord({ id: 'b', userId: 'u_2', createdAt: 2 }))
    await s.patchTake('c', takeRecord({ id: 'c', userId: 'u_1', createdAt: 3 }))
    expect((await s.listTakes('u_1')).map((t) => t.id)).toEqual(['c', 'a'])
    expect((await s.listTakes('u_2')).map((t) => t.id)).toEqual(['b'])
    expect(await s.listTakes('')).toEqual([])
  })

  it('sweeps takes (any owner) older than 7 days, with their chunks', async () => {
    const s = new MemoryRecoveryStore()
    const now = 100 * DAY
    await s.patchTake('old', takeRecord({ id: 'old', userId: 'u_2', createdAt: now - RECOVERY_TTL_MS - 1 }))
    await s.putChunk(chunk('old', 0), { id: 'old', chunks: 1 })
    await s.patchTake('new', takeRecord({ id: 'new', createdAt: now - 6 * DAY }))
    expect(await s.sweep(now)).toBe(1)
    expect(await s.getTake('old')).toBeUndefined()
    expect(s.chunks.size).toBe(0)
    expect(await s.getTake('new')).toBeDefined()
  })

  it('fails a write past its quota with a quota error and keeps what was saved', async () => {
    const s = new MemoryRecoveryStore(CHUNK_SAMPLES * 2)
    await s.putChunk(chunk('a', 0), { id: 'a', chunks: 1 })
    const err = await s.putChunk(chunk('a', 1), { id: 'a', chunks: 2 }).catch((e: unknown) => e)
    expect(isQuotaError(err)).toBe(true)
    expect(await s.getTake('a')).toMatchObject({ chunks: 1 })
  })
})

describe('recoverableTakes', () => {
  it("offers this person's takes for this draft that have audio, never another account's", async () => {
    const s = new MemoryRecoveryStore()
    await s.patchTake('mine', takeRecord({ id: 'mine', chunks: 2 }))
    await s.patchTake('empty', takeRecord({ id: 'empty', chunks: 0 }))
    await s.patchTake('other-draft', takeRecord({ id: 'other-draft', draftId: 'draft_2', chunks: 2 }))
    await s.patchTake('theirs', takeRecord({ id: 'theirs', userId: 'u_2', chunks: 2 }))
    expect((await recoverableTakes(s, 'u_1', 'draft_1')).map((t) => t.id)).toEqual(['mine'])
    expect((await recoverableTakes(s, 'u_2', 'draft_1')).map((t) => t.id)).toEqual(['theirs'])
    expect(await recoverableTakes(s, '', 'draft_1')).toEqual([])
  })

  it('drops takes past 7 days before offering', async () => {
    const s = new MemoryRecoveryStore()
    const now = 100 * DAY
    await s.patchTake('old', takeRecord({ id: 'old', chunks: 1, createdAt: now - 8 * DAY }))
    expect(await recoverableTakes(s, 'u_1', 'draft_1', now)).toEqual([])
    expect(await s.getTake('old')).toBeUndefined()
  })
})

describe('recoverTake', () => {
  it('brings back a take cut off mid-recording, up to its last saved chunk', async () => {
    const s = new MemoryRecoveryStore()
    const w = new TakeWriter(s, takeRecord({ startFrame: -1 }))
    await w.open()
    const x = new Float32Array(48_000 * 2).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 300 * i) / 48_000))
    for (let i = 0; i < x.length; i += 2048) w.block(9600 + i, x.subarray(i, i + 2048))
    await new Promise((r) => setTimeout(r, 0))
    // The tab dies here: no end(). The record says 'recording'.
    const rec = await s.getTake('take-1')
    if (!rec) throw new Error('no record')
    expect(rec.status).toBe('recording')
    const take = await recoverTake(s, rec)
    expect(take.samples).toBe(rec.chunks * CHUNK_SAMPLES)
    expect(take.stopReason).toBe('interrupted')
    expect(take.firstSampleContextTime).toBeCloseTo(0.2, 6)
    const bytes = new Uint8Array(await take.wav.arrayBuffer())
    expect(take.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(decodePeaks(take.peaks).samples).toBe(take.samples)
    expect(take.speech.length).toBe(1)
    expect(await s.getTake('take-1')).toMatchObject({ status: 'stopped', fileSha256: take.sha256 })
  })
})
