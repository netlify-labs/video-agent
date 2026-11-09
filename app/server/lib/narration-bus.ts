// The narration bus's pre-limiter and PCM16 conversions (plan 2026-11-02 §6.3 step 3). Pure and deterministic (no
// I/O, no ffmpeg), so the same mix gives the same bus bytes on any ffmpeg build; scripts/narration.ts runs it.
//
// The limiter is offline, so its look-ahead costs no latency: nothing moves in time and the sample count is kept.
//   1. True peak per sample, BS.1770-style: the sample itself and three interpolated points between it and the next
//      (4× oversampling, a Hann-windowed sinc with `tpTaps` taps per side). Points between two samples both 6 dB
//      under the ceiling are skipped: speech can't overshoot that much between samples.
//   2. The gain each sample needs, min(1, ceiling / peak).
//   3. Look-ahead: a running minimum over the last `lookaheadSamples`, then a running mean over the next as many, so
//      the gain has fully come down (a linear-ish ramp) by the time each peak arrives and never sits above what any
//      sample needs.
//   4. Release: the gain recovers toward 1 with a `releaseMs` one-pole, never above what step 3 allows.
// Rounding to PCM16 can lift a peak by an LSB, so the ceiling carries a 0.05 dB margin and the limiter runs again
// (at most `passes` times) until the true peak of the result is under it. A bus already under the ceiling comes
// back unchanged. S13 notes that delivering -14 LUFS at -1 dBTP needs about 1.5 dB of limiting; mastering applies one
// gain over the whole mix, so this ceiling is what it has to work with.
import { SAMPLE_RATE } from './timeline.js'

export const BUS_LIMITER = {
  ceilingDbtp: -2,
  marginDb: 0.05,
  lookaheadSamples: 120, // 5 ms
  releaseMs: 100,
  tpTaps: 12,
  passes: 3,
} as const

const dbToLin = (db: number) => 10 ** (db / 20)
export const linToDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120)

const PHASES = [0.25, 0.5, 0.75]
/** Interpolation kernels for the three in-between points: x(n+f) ≈ Σ_k h_f[k] · x[n + k - TAPS + 1]. */
const KERNELS = PHASES.map((f) => {
  const taps = BUS_LIMITER.tpTaps
  const h = Array.from({ length: 2 * taps }, (_, i) => {
    const t = i - taps + 1 - f // distance from the point to sample n + i - taps + 1
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (taps + 1))
    return sinc * w
  })
  const sum = h.reduce((a, b) => a + b, 0)
  return Float64Array.from(h, (x) => x / sum)
})

/** |true peak| per sample: max of the sample and the interpolated points up to the next one. */
export function truePeaks(x: Float32Array, skipBelow = 0): Float32Array {
  const taps = BUS_LIMITER.tpTaps
  const out = new Float32Array(x.length)
  for (let n = 0; n < x.length; n++) {
    const a = Math.abs(x[n] ?? 0)
    let peak = a
    if (Math.max(a, Math.abs(x[n + 1] ?? 0)) >= skipBelow)
      for (const h of KERNELS) {
        let v = 0
        for (let k = 0; k < h.length; k++) v += (h[k] ?? 0) * (x[n + k - taps + 1] ?? 0)
        if (Math.abs(v) > peak) peak = Math.abs(v)
      }
    out[n] = peak
  }
  return out
}

/** Running minimum of `r` over the window [n - len + 1, n] (monotonic deque of indices). */
function holdMin(r: Float32Array, len: number): Float32Array {
  const out = new Float32Array(r.length)
  const q = new Int32Array(r.length)
  let head = 0
  let tail = 0
  for (let n = 0; n < r.length; n++) {
    const v = r[n] ?? 1
    while (tail > head && (r[q[tail - 1] ?? 0] ?? 1) >= v) tail--
    q[tail++] = n
    if ((q[head] ?? 0) <= n - len) head++
    out[n] = r[q[head] ?? n] ?? 1
  }
  return out
}

function limitOnce(x: Float32Array, ceiling: number): { y: Float32Array; minGain: number; limited: number } {
  const tp = truePeaks(x, ceiling / 2)
  const need = new Float32Array(x.length)
  let any = false
  for (let n = 0; n < x.length; n++) {
    const p = tp[n] ?? 0
    need[n] = p > ceiling ? ceiling / p : 1
    if (p > ceiling) any = true
  }
  if (!any) return { y: x, minGain: 1, limited: 0 }
  const L = BUS_LIMITER.lookaheadSamples
  const held = holdMin(need, L)
  const rel = 1 - Math.exp(-1 / ((BUS_LIMITER.releaseMs / 1000) * SAMPLE_RATE))
  const y = new Float32Array(x.length)
  let sum = 0 // running sum of held[n .. n + L - 1]; held past the end is 1
  for (let i = 0; i < L; i++) sum += held[i] ?? 1
  let g = 1
  let minGain = 1
  let limited = 0
  for (let n = 0; n < x.length; n++) {
    const smooth = Math.min(sum / L, need[n] ?? 1)
    g = Math.min(smooth, g + (1 - g) * rel)
    if (g > 0.9999 && smooth >= 1) g = 1 // the one-pole never quite arrives; -0.001 dB is inaudible
    if (g < 1) limited++
    if (g < minGain) minGain = g
    y[n] = (x[n] ?? 0) * g
    sum += (held[n + L] ?? 1) - (held[n] ?? 1)
  }
  return { y, minGain, limited }
}

export interface LimitResult {
  bus: Float32Array
  /** Deepest gain reduction (dB, ≤ 0). */
  maxReductionDb: number
  /** Samples whose gain went under 1 (summed over passes). */
  limitedSamples: number
  /** True peak of the PCM16 result, dBTP (4× estimate). */
  truePeakDb: number
}

/** Limits a bus to the ceiling, measured on its PCM16 rounding. Returns the bus PCM16-exact (pcm16ToFloat ∘ floatToPcm16). */
export function limitBus(x: Float32Array, ceilingDbtp: number = BUS_LIMITER.ceilingDbtp): LimitResult {
  const ceiling = dbToLin(ceilingDbtp - BUS_LIMITER.marginDb)
  let cur = pcm16ToFloat(floatToPcm16(x))
  let minGain = 1
  let limitedSamples = 0
  for (let pass = 0; pass < BUS_LIMITER.passes; pass++) {
    const r = limitOnce(cur, ceiling)
    if (!r.limited) break
    minGain *= r.minGain
    limitedSamples += r.limited
    cur = pcm16ToFloat(floatToPcm16(r.y))
  }
  // Between samples under half the ceiling only the samples count: the figure is exact wherever it matters.
  const peak = truePeaks(cur, ceiling / 2).reduce((m, v) => (v > m ? v : m), 0)
  return { bus: cur, maxReductionDb: linToDb(minGain), limitedSamples, truePeakDb: linToDb(peak) }
}

/** Float in -1..1 to PCM16: × 32768, rounded half away from zero, clamped to -32768..32767. */
export function floatToPcm16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const v = (x[i] ?? 0) * 32768
    const r = v < 0 ? -Math.round(-v) : Math.round(v)
    out[i] = Math.max(-32768, Math.min(32767, r))
  }
  return out
}

export const pcm16ToFloat = (s: Int16Array): Float32Array => Float32Array.from(s, (v) => v / 32768)
