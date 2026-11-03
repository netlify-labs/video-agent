// Peaks pyramid and speech spans (plan §5.1, §6.1, §6.2): dims, values, the binary format, block-size independence,
// and the VAD on a labelled synthetic take.
import { describe, expect, it } from 'vitest'
import {
  binCount,
  computePeaks,
  decodePeaks,
  detectSpeech,
  encodePeaks,
  levelFor,
  PEAKS_BASE_BIN,
  PEAKS_VERSION,
  PeaksBuilder,
  SpeechDetector,
  VAD_FRAME_SAMPLES,
  VAD_HANGOVER_SAMPLES,
  VAD_MIN_SPEECH_SAMPLES,
  wholeClipSpans,
} from './peaks.js'
import { SAMPLE_RATE, type Span } from './timeline.js'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform noise with RMS `rms` (uniform on [-k, k] has RMS k/√3). */
function noise(out: Float32Array, from: number, to: number, rms: number, next: () => number) {
  const k = rms * Math.sqrt(3)
  for (let i = from; i < to; i++) out[i] = (next() * 2 - 1) * k
}

/** Push `samples` in random block sizes, the way a worklet delivers them. */
function pushInBlocks(b: { push(x: Float32Array): void }, samples: Float32Array, seed: number) {
  const next = rng(seed)
  for (let i = 0; i < samples.length;) {
    const n = 1 + Math.floor(next() * 3000)
    b.push(samples.subarray(i, i + n))
    i += n
  }
}

const sec = (s: number) => Math.round(s * SAMPLE_RATE)

describe('peaks', () => {
  it('builds a pyramid with the documented dims and values', () => {
    const n = PEAKS_BASE_BIN * 5 + 100
    const x = new Float32Array(n)
    x[10] = 0.5
    x[PEAKS_BASE_BIN * 2 + 3] = -1
    x[n - 1] = 1.5 // clamps to 127
    const p = computePeaks(x)
    expect(p.samples).toBe(n)
    expect(p.levels.map((l) => [l.samplesPerBin, binCount(l)])).toEqual([
      [1024, 6],
      [2048, 3],
      [4096, 2],
      [8192, 1],
    ])
    expect([...p.levels[0]!.data]).toEqual([0, 64, 0, 0, -127, 0, 0, 0, 0, 0, 0, 127])
    expect([...p.levels[1]!.data]).toEqual([0, 64, -127, 0, 0, 127])
    expect([...p.levels[2]!.data]).toEqual([-127, 64, 0, 127])
    expect([...p.levels[3]!.data]).toEqual([-127, 127])
    expect(computePeaks(new Float32Array(0)).levels.map(binCount)).toEqual([0])
  })

  it('is about 56 KB for 10 minutes and round-trips through the binary format', () => {
    const next = rng(1)
    const x = new Float32Array(sec(600))
    noise(x, 0, x.length, 0.2, next)
    const p = computePeaks(x)
    const bin = encodePeaks(p)
    expect(bin.length).toBeGreaterThan(50_000)
    expect(bin.length).toBeLessThan(60_000)
    expect(String.fromCharCode(...bin.subarray(0, 4))).toBe('VAPK')
    expect(bin[4]).toBe(PEAKS_VERSION)
    expect(decodePeaks(bin)).toEqual(p)
    expect(levelFor(p, 5000).samplesPerBin).toBe(4096)
    expect(levelFor(p, 10).samplesPerBin).toBe(PEAKS_BASE_BIN)
  })

  it('rejects malformed files', () => {
    const bin = encodePeaks(computePeaks(new Float32Array(5000)))
    expect(() => decodePeaks(bin.subarray(0, 10))).toThrow(/too short/)
    expect(() => decodePeaks(bin.subarray(0, bin.length - 1))).toThrow(/size/)
    const bad = bin.slice()
    bad[0] = 0
    expect(() => decodePeaks(bad)).toThrow(/magic/)
    const v2 = bin.slice()
    v2[4] = 2
    expect(() => decodePeaks(v2)).toThrow(/version 2/)
  })

  it('gives the same bytes whatever the block sizes', () => {
    const next = rng(7)
    const x = new Float32Array(sec(3) + 17)
    noise(x, 0, x.length, 0.3, next)
    const b = new PeaksBuilder()
    pushInBlocks(b, x, 3)
    expect(encodePeaks(b.finish())).toEqual(encodePeaks(computePeaks(x)))
  })
})

describe('speech spans', () => {
  // A labelled take: speech-like bursts of noise at -20 dBFS over a -70 dBFS floor.
  const labels: Span[] = [
    [sec(0.5), sec(1.7)],
    [sec(2.5), sec(2.9)],
    [sec(4.0), sec(6.25)],
    [sec(8.0), sec(8.6)],
  ]
  const length = sec(10)
  const take = new Float32Array(length)
  const next = rng(11)
  noise(take, 0, length, 10 ** (-70 / 20), next)
  for (const [s, e] of labels) noise(take, s, e, 0.1, next)

  it('finds the labelled bursts within a frame at the start and the hangover at the end', () => {
    const spans = detectSpeech(take)
    expect(spans).toHaveLength(labels.length)
    for (const [i, [s, e]] of spans.entries()) {
      const [ls, le] = labels[i]!
      expect(Math.abs(s - ls)).toBeLessThanOrEqual(VAD_FRAME_SAMPLES)
      expect(e).toBeGreaterThanOrEqual(le)
      expect(e - le).toBeLessThanOrEqual(VAD_HANGOVER_SAMPLES + VAD_FRAME_SAMPLES)
    }
  })

  it('closes short gaps, drops clicks and ignores the noise floor', () => {
    const x = new Float32Array(sec(4))
    const r = rng(5)
    noise(x, sec(0.5), sec(1.0), 0.1, r)
    noise(x, sec(1.05), sec(1.5), 0.1, r) // a 50 ms gap: one span
    noise(x, sec(3.0), sec(3.0) + 960, 0.3, r) // a 40 ms click: dropped
    const spans = detectSpeech(x)
    expect(spans).toHaveLength(1)
    expect(spans[0]![0]).toBe(sec(0.5))
    expect(detectSpeech(take.subarray(sec(1.8), sec(2.4)))).toEqual([])
    expect(VAD_MIN_SPEECH_SAMPLES).toBeGreaterThan(960)
  })

  it('gives the same spans whatever the block sizes, and clamps to the take', () => {
    const d = new SpeechDetector()
    pushInBlocks(d, take, 9)
    expect(d.finish()).toEqual(detectSpeech(take))
    const tail = take.subarray(0, sec(8.3))
    expect(detectSpeech(tail).at(-1)?.[1]).toBe(tail.length)
  })

  it('falls back to the whole clip', () => {
    expect(wholeClipSpans(length)).toEqual([[0, length]])
    expect(wholeClipSpans(0)).toEqual([])
  })
})
