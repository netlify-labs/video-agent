// Auto-align against the AI voice (plan 2026-11-02 §2.4, phase 6): synthetic speech with a known offset is found
// within a frame through noise and a different voice, the same voice to the sample, and nothing without AI voice.
import { describe, expect, it } from 'vitest'
import { ALIGN_FRAME_SAMPLES, alignToVoice, type VoiceStem } from './narration-align.js'
import { SAMPLE_RATE } from './timeline.js'

/** A seeded PRNG (mulberry32), so every run is the same. */
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

/** Syllables and pauses: [start, end, level] in samples, like someone reading a script. */
function script(seed: number, seconds: number) {
  const r = rng(seed)
  const out: [number, number, number][] = []
  for (let t = 0.2 * SAMPLE_RATE; t < seconds * SAMPLE_RATE;) {
    const len = Math.round((0.08 + 0.27 * r()) * SAMPLE_RATE)
    out.push([t, Math.min(t + len, seconds * SAMPLE_RATE), 0.3 + 0.6 * r()])
    // Mostly short gaps, now and then a sentence break.
    t += len + Math.round((r() < 0.15 ? 0.4 + 0.5 * r() : 0.04 + 0.16 * r()) * SAMPLE_RATE)
  }
  return out
}

/** A voice reading `syllables`: a harmonic carrier at f0 (or noise), each syllable's level scaled by `vary`. */
function speak(
  syllables: [number, number, number][],
  length: number,
  o: { f0: number; seed: number; vary?: number; noise?: number },
) {
  const r = rng(o.seed)
  const out = new Float32Array(length)
  const phases = [0, 1, 2, 3, 4].map(() => r() * 2 * Math.PI)
  for (const [a, b, level] of syllables) {
    const g = level * (1 + (o.vary ?? 0) * (r() * 2 - 1))
    for (let t = a; t < b && t < length; t++) {
      const x = (t - a) / (b - a)
      const shape = Math.sin(Math.PI * x)
      let c = 0
      for (let h = 0; h < 5; h++)
        c += Math.sin((2 * Math.PI * o.f0 * (h + 1) * t) / SAMPLE_RATE + (phases[h] ?? 0)) / (h + 1)
      out[t] = 0.3 * g * shape * c
    }
  }
  if (o.noise) for (let t = 0; t < length; t++) out[t] = (out[t] ?? 0) + o.noise * (r() * 2 - 1)
  return out
}

/** The AI voice of `syllables` cut into stems at its sentence breaks, placed from composition sample `at`. */
function stems(voice: Float32Array, at: number, cuts: number[]): VoiceStem[] {
  const edges = [0, ...cuts.map((c) => Math.round(c * SAMPLE_RATE)), voice.length]
  return edges
    .slice(1)
    .map((end, i) => ({ start: at + (edges[i] ?? 0), samples: voice.slice(edges[i], end) }))
}

describe('alignToVoice', () => {
  const syl = script(7, 40)
  const len = 40 * SAMPLE_RATE
  const ai = speak(syl, len, { f0: 118, seed: 1 })

  it('finds a different voice reading the same script within one 10 ms frame, through noise', () => {
    const at = Math.round(2.37 * SAMPLE_RATE)
    // The person's take: 0.5 s of room tone first, another voice, uneven levels, a noisy room.
    const lead = Math.round(0.5 * SAMPLE_RATE)
    const take = new Float32Array(lead + len)
    take.set(speak(syl, len, { f0: 205, seed: 2, vary: 0.4, noise: 0.01 }), lead)
    for (let t = 0; t < lead; t++) take[t] = 0.01 * (Math.sin(t * 12.9898) % 1)
    const s = alignToVoice(take, stems(ai, at, [11, 23, 31]))
    expect(s).not.toBeNull()
    expect(Math.abs((s?.start ?? 0) - (at - lead))).toBeLessThanOrEqual(ALIGN_FRAME_SAMPLES)
    expect(s?.score).toBeGreaterThan(0.6)
  })

  it('places the AI voice itself (a re-export) to the sample, whatever the offset', () => {
    const at = 5 * SAMPLE_RATE + 1234
    const s = alignToVoice(ai.slice(0, 20 * SAMPLE_RATE), stems(ai, at, [11, 23, 31]))
    expect(s).toMatchObject({ start: at, refined: 'waveform' })
  })

  it('suggests a negative start when the take has extra speech before the voice', () => {
    const extra = script(99, 3).map(([a, b, l]): [number, number, number] => [a, b, l])
    const pre = Math.round(3 * SAMPLE_RATE)
    const take = new Float32Array(pre + len)
    take.set(speak(extra, pre, { f0: 205, seed: 3 }))
    take.set(speak(syl, len, { f0: 205, seed: 4, vary: 0.3, noise: 0.005 }), pre)
    const at = SAMPLE_RATE
    const s = alignToVoice(take, stems(ai, at, [11, 23]))
    expect(Math.abs((s?.start ?? 0) - (at - pre))).toBeLessThanOrEqual(ALIGN_FRAME_SAMPLES)
  })

  it('searches ±10 s around the clip on a long composition', () => {
    // 3 minutes of AI voice; the take is the 40 s from 100 s on, its clip dropped at 95 s.
    const long = script(11, 180)
    const voice = speak(long, 180 * SAMPLE_RATE, { f0: 118, seed: 5 })
    const from = 100 * SAMPLE_RATE
    const part = long
      .filter(([a]) => a >= from && a < from + len)
      .map(([a, b, l]): [number, number, number] => [a - from, b - from, l])
    const take = speak(part, len, { f0: 190, seed: 6, vary: 0.3, noise: 0.01 })
    const s = alignToVoice(take, stems(voice, 0, [60, 120]), { near: 95 * SAMPLE_RATE })
    expect(Math.abs((s?.start ?? 0) - from)).toBeLessThanOrEqual(ALIGN_FRAME_SAMPLES)
    // Too far from where the clip is: the true place is outside the window, so the score is poor or there's none.
    const far = alignToVoice(take, stems(voice, 0, [60, 120]), { near: 20 * SAMPLE_RATE })
    expect(far === null || Math.abs(far.start - from) > 5 * SAMPLE_RATE).toBe(true)
  })

  it('has nothing to suggest without AI voice, with a silent one, or for an unrelated take', () => {
    const take = speak(syl, len, { f0: 205, seed: 2 })
    expect(alignToVoice(take, [])).toBeNull()
    expect(alignToVoice(take, [{ start: 0, samples: new Float32Array(0) }])).toBeNull()
    expect(alignToVoice(take, [{ start: 0, samples: new Float32Array(len) }])).toBeNull()
    expect(alignToVoice(new Float32Array(100), stems(ai, 0, []))).toBeNull()
    const other = speak(script(12345, 40), len, { f0: 205, seed: 8 })
    const s = alignToVoice(other, stems(ai, 0, [11, 23, 31]))
    expect(s === null || s.score < 0.5).toBe(true)
  })

  it('is bounded: a 10-minute take against a 15-minute track, and a 2-minute track searched whole', () => {
    const r = rng(3)
    const take = new Float32Array(600 * SAMPLE_RATE).map(() => 0.1 * (r() * 2 - 1))
    const track = new Float32Array(900 * SAMPLE_RATE).map(() => 0.1 * (r() * 2 - 1))
    let t = performance.now()
    alignToVoice(take, [{ start: 0, samples: track }], { near: 60 * SAMPLE_RATE })
    expect(performance.now() - t).toBeLessThan(4000)
    t = performance.now()
    alignToVoice(take.subarray(0, 110 * SAMPLE_RATE), [
      { start: 0, samples: track.subarray(0, 119 * SAMPLE_RATE) },
    ])
    expect(performance.now() - t).toBeLessThan(4000)
  })
})
