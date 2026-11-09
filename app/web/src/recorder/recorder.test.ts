// The recorder's pure parts in Node (plan 2026-11-02 §5.1): the streaming SHA-256 against node:crypto, the resampler
// against a reference tone, WAV header and sizes, and the worker pipeline (TakeWriter) end to end on an in-memory store:
// exact sample counts, file hash = one-shot hash of the WAV, PCM hash = the running one, peaks and speech, gap fill,
// and a quota error that stops the take and keeps the saved prefix.
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodePeaks } from '../../../server/lib/peaks'
import { Resampler } from './resample'
import { Sha256 } from './sha256'
import { CHUNK_SAMPLES, MemoryRecoveryStore } from './store'
import { takeRecord } from './take-fixture'
import { finalizeTake, TakeWriter } from './take-writer'
import { floatToPcm16, pcm16ToFloat, wavData, wavHeader } from './wav'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** One second of 1 kHz at 0.5, then one second of silence, repeated, at `rate`. */
const bursts = (rate: number, seconds: number) =>
  new Float32Array(rate * seconds).map((_, i) =>
    Math.floor(i / rate) % 2 === 0 ? 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate) : 0,
  )

async function record(store: MemoryRecoveryStore, x: Float32Array, rec = takeRecord(), block = 2048) {
  const w = new TakeWriter(store, rec)
  await w.open()
  for (let i = 0; i < x.length; i += block) w.block(1000 + i, x.subarray(i, i + block))
  return { w, take: await w.end() }
}

describe('Sha256', () => {
  it('streams to the same digest as a one-shot hash, at any split', () => {
    for (const n of [0, 1, 55, 64, 65, 4097, 100_003]) {
      const d = randomBytes(n)
      const h = new Sha256()
      for (let i = 0; i < n; i += 997) h.update(d.subarray(i, i + 997))
      expect(h.hex()).toBe(sha(d))
    }
  })

  it('reads a running digest with clone() without disturbing the stream', () => {
    const d = randomBytes(5000)
    const h = new Sha256().update(d.subarray(0, 3000))
    expect(h.clone().hex()).toBe(sha(d.subarray(0, 3000)))
    expect(h.update(d.subarray(3000)).hex()).toBe(sha(d))
  })
})

describe('Resampler', () => {
  for (const inRate of [48_000, 44_100]) {
    it(`${inRate} -> 24 kHz keeps 1 kHz, removes 15 kHz, and gives ceil(n × 24000 / rate) samples`, () => {
      const x = new Float32Array(inRate * 2).map(
        (_, i) =>
          0.5 * Math.sin((2 * Math.PI * 1000 * i) / inRate) +
          0.3 * Math.sin((2 * Math.PI * 15_000 * i) / inRate),
      )
      const r = new Resampler(inRate, 24_000)
      const parts: Float32Array[] = []
      for (let i = 0; i < x.length; i += 1000) parts.push(r.push(x.subarray(i, i + 1000)))
      parts.push(r.finish())
      const y = Float32Array.from(parts.flatMap((p) => [...p]))
      expect(y.length).toBe(Math.ceil((x.length * 24_000) / inRate))
      let err = 0
      let sig = 0
      for (let j = 100; j < y.length - 100; j++) {
        const ref = 0.5 * Math.sin((2 * Math.PI * 1000 * j) / 24_000)
        err += ((y[j] ?? 0) - ref) ** 2
        sig += ref ** 2
      }
      expect(10 * Math.log10(err / sig)).toBeLessThan(-60)
    })
  }

  it('gives the same output for any block size', () => {
    const x = bursts(48_000, 1)
    const run = (block: number) => {
      const r = new Resampler(48_000, 24_000)
      const out: number[] = []
      for (let i = 0; i < x.length; i += block) out.push(...r.push(x.subarray(i, i + block)))
      out.push(...r.finish())
      return out
    }
    expect(run(128)).toEqual(run(x.length))
  })
})

describe('wav', () => {
  it('writes a 44-byte mono PCM16 header with the right sizes', () => {
    const h = wavHeader(1234, 24_000)
    const dv = new DataView(h.buffer)
    expect(h.length).toBe(44)
    expect(String.fromCharCode(...h.subarray(0, 4))).toBe('RIFF')
    expect(dv.getUint32(4, true)).toBe(36 + 2468)
    expect(String.fromCharCode(...h.subarray(8, 16))).toBe('WAVEfmt ')
    expect([dv.getUint16(20, true), dv.getUint16(22, true)]).toEqual([1, 1])
    expect(dv.getUint32(24, true)).toBe(24_000)
    expect(dv.getUint32(28, true)).toBe(48_000)
    expect([dv.getUint16(32, true), dv.getUint16(34, true)]).toEqual([2, 16])
    expect(dv.getUint32(40, true)).toBe(2468)
  })

  it('round-trips PCM16 and clamps', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 0.5, -0.5, 2, -2]))
    const back = pcm16ToFloat(pcm)
    expect(back[1]).toBeCloseTo(0.5, 4)
    expect([back[3], back[4]]).toEqual([1, Math.fround(-32768 / 32767)])
  })
})

describe('TakeWriter', () => {
  it('records a take: exact samples, file hash = one-shot hash, PCM hash, peaks and speech', async () => {
    const store = new MemoryRecoveryStore()
    const x = bursts(48_000, 4)
    const { take } = await record(store, x)
    const samples = Math.ceil((x.length * 24_000) / 48_000)
    expect(take.samples).toBe(samples)
    expect(take.chunks).toBe(Math.ceil(samples / CHUNK_SAMPLES))
    expect(take.startFrame).toBe(1000)
    const bytes = new Uint8Array(await take.wav.arrayBuffer())
    expect(bytes.length).toBe(44 + 2 * samples)
    expect(take.wav.type).toBe('audio/wav')
    expect(take.sha256).toBe(sha(bytes))
    const { sampleRate, pcm } = wavData(bytes)
    expect(sampleRate).toBe(24_000)
    expect(take.pcmSha256).toBe(sha(pcm))
    expect(decodePeaks(take.peaks).samples).toBe(samples)
    // Speech in seconds 0-1 and 2-3 (each extended by the 200 ms hangover).
    expect(take.speech).toHaveLength(2)
    expect(take.speech[0]?.[0]).toBe(0)
    expect(take.speech[1]?.[0]).toBeGreaterThanOrEqual(2 * 24_000 - 480)
    const rec = await store.getTake('take-1')
    expect(rec).toMatchObject({ status: 'stopped', samples, fileSha256: take.sha256, userId: 'u_1' })
  })

  it('writes the running PCM hash with every chunk, from the first one', async () => {
    const store = new MemoryRecoveryStore()
    const w = new TakeWriter(store, takeRecord())
    await w.open()
    const x = bursts(48_000, 2)
    for (let i = 0; i < x.length; i += 2048) w.block(i, x.subarray(i, i + 2048))
    await new Promise((r) => setTimeout(r, 0))
    const rec = await store.getTake('take-1')
    expect(rec?.chunks).toBeGreaterThanOrEqual(3)
    const saved = await store.chunkRange('take-1', 0, rec?.chunks ?? 0)
    const h = new Sha256()
    for (const c of saved) h.update(new Uint8Array(c.pcm))
    expect(rec?.pcmSha256).toBe(h.hex())
    expect(rec?.status).toBe('recording')
  })

  it('fills a gap in the worklet frames with silence so sample index follows the context clock', async () => {
    const store = new MemoryRecoveryStore()
    const w = new TakeWriter(store, takeRecord())
    await w.open()
    const b = new Float32Array(2048).fill(0.1)
    w.block(0, b)
    w.block(2048 + 4800, b) // 100 ms missing
    w.block(2048 * 2 + 4800 + 128, b) // one quantum of jitter: ignored
    const take = await w.end()
    expect(w.padded).toBe(4800)
    expect(take.samples).toBe(Math.ceil(((2048 * 3 + 4800) * 24_000) / 48_000))
  })

  it('stops at a quota error and keeps the saved prefix, with peaks and speech rebuilt to match', async () => {
    const store = new MemoryRecoveryStore(CHUNK_SAMPLES * 2 * 3) // room for three chunks
    const failures: string[] = []
    const w = new TakeWriter(store, takeRecord(), { onFailure: (r) => failures.push(r) })
    await w.open()
    const x = bursts(48_000, 4)
    for (let i = 0; i < x.length; i += 2048) w.block(i, x.subarray(i, i + 2048))
    const take = await w.end()
    expect(failures).toEqual(['quota'])
    expect(take.stopReason).toBe('quota')
    expect(take.samples).toBe(3 * CHUNK_SAMPLES)
    const bytes = new Uint8Array(await take.wav.arrayBuffer())
    expect(bytes.length).toBe(44 + 6 * CHUNK_SAMPLES)
    expect(take.sha256).toBe(sha(bytes))
    expect(decodePeaks(take.peaks).samples).toBe(3 * CHUNK_SAMPLES)
    expect(await store.getTake('take-1')).toMatchObject({ stopReason: 'quota', chunks: 3 })
  })
})

describe('finalizeTake', () => {
  it('rebuilds an interrupted take from its chunks: same WAV and hash as the live finalize', async () => {
    const store = new MemoryRecoveryStore()
    const { take } = await record(store, bursts(48_000, 3))
    const rec = await store.getTake('take-1')
    if (!rec) throw new Error('no record')
    const again = await finalizeTake(store, rec, { rebuild: true })
    expect(again.sha256).toBe(take.sha256)
    expect(again.samples).toBe(take.samples)
    expect(again.speech).toEqual(take.speech)
    expect(decodePeaks(again.peaks ?? new Uint8Array()).samples).toBe(take.samples)
  })

  it('throws when a chunk is missing', async () => {
    const store = new MemoryRecoveryStore()
    await record(store, bursts(48_000, 2))
    store.chunks.delete('take-1:1')
    await expect(finalizeTake(store, { id: 'take-1', chunks: 4 })).rejects.toThrow(/missing/)
  })

  it('gives an empty WAV for a take with no chunks', async () => {
    const f = await finalizeTake(new MemoryRecoveryStore(), { id: 'none', chunks: 0 })
    expect(f.samples).toBe(0)
    expect(f.wav.size).toBe(44)
  })
})
