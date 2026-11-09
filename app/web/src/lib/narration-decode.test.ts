// Audition take audio (plan §5.4): WAV parsing, sample-exact PCM16 slicing, the decode fallback and the LRU budget.
import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE } from '../../../server/lib/timeline'
import { LruBudget, parseWav, slicePcm16, sliceable, takeFromBytes } from './narration-decode'
import { wav } from './wav-fixture'

describe('WAV slicing', () => {
  const ramp = Array.from({ length: 1000 }, (_, i) => ((i * 37) % 65536) - 32768)

  it('parses fmt and data past other chunks', () => {
    const w = parseWav(wav([ramp]))
    expect(w).toMatchObject({
      format: 1,
      channels: 1,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      frames: 1000,
    })
    expect(sliceable(w)).toBe(true)
    expect(parseWav(wav([ramp], { extensible: true }))).toMatchObject({ format: 1, frames: 1000 })
    expect(parseWav(new TextEncoder().encode('ID3 not a wav').buffer)).toBeNull()
  })

  it('reads a range sample-exactly, silence outside the file', () => {
    const bytes = wav([ramp])
    const w = parseWav(bytes)
    if (!w) throw new Error('no wav')
    const s = slicePcm16(bytes, w, 990, 1010)
    expect(s).toHaveLength(20)
    for (let i = 0; i < 10; i++) expect(s[i]).toBe((ramp[990 + i] ?? 0) / 32768)
    expect([...s.subarray(10)]).toEqual(new Array(10).fill(0))
    expect([...slicePcm16(bytes, w, -3, 2)]).toEqual([
      0,
      0,
      0,
      (ramp[0] ?? 0) / 32768,
      (ramp[1] ?? 0) / 32768,
    ])
  })

  it('averages channels', () => {
    const bytes = wav([
      [1000, -2000],
      [3000, 2000],
    ])
    const w = parseWav(bytes)
    if (!w) throw new Error('no wav')
    expect([...slicePcm16(bytes, w, 0, 2)]).toEqual([2000 / 32768, 0])
  })

  it('slices 24 kHz PCM16 in place and decodes anything else', async () => {
    let decoded = 0
    const decode = async (b: ArrayBuffer) => {
      decoded++
      return new Float32Array(b.byteLength)
    }
    const sliced = await takeFromBytes(wav([ramp]), decode)
    expect(sliced).toMatchObject({ kind: 'pcm16', samples: 1000 })
    expect(decoded).toBe(0)
    const resampled = await takeFromBytes(wav([ramp], { rate: 48_000 }), decode)
    expect(resampled.kind).toBe('decoded')
    const mp3 = await takeFromBytes(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]).buffer, decode)
    expect(mp3).toMatchObject({ kind: 'decoded', samples: 6, bytes: 24 })
    expect(decoded).toBe(2)
    expect([...mp3.read(4, 8)]).toEqual([0, 0, 0, 0])
  })
})

describe('LRU budget', () => {
  it('evicts least recently used first, never a pinned entry', () => {
    const evicted: string[] = []
    const c = new LruBudget<number>(100, (k) => evicted.push(k))
    c.set('a', 1, 40)
    c.set('b', 2, 40)
    c.get('a') // b is now the oldest
    c.set('c', 3, 40)
    expect(evicted).toEqual(['b'])
    expect(c.keys()).toEqual(['a', 'c'])
    c.set('d', 4, 40, new Set(['a']))
    expect(evicted).toEqual(['b', 'c'])
    expect(c.stats()).toMatchObject({ usedBytes: 80, entries: 2, evictions: 2, overBudgetBytes: 0 })
  })

  it('holds a window bigger than the budget and reports it', () => {
    const c = new LruBudget<number>(50)
    c.set('a', 1, 40)
    c.set('b', 2, 40, new Set(['a']))
    expect(c.stats()).toMatchObject({ usedBytes: 80, overBudgetBytes: 30, evictions: 0 })
    c.trim()
    expect(c.keys()).toEqual(['b'])
  })

  it('drops by key and re-sets without double counting', () => {
    const c = new LruBudget<number>(1000)
    c.set('chunk:1:0', 1, 10)
    c.set('chunk:2:0', 1, 10)
    c.set('chunk:2:0', 1, 20)
    c.deleteWhere((k) => k.startsWith('chunk:1:'))
    expect(c.stats()).toMatchObject({ usedBytes: 20, entries: 1 })
  })
})
