// Auto-align an uploaded narration against the AI voice track (docs/plans/2026-11-02-record-your-own-voiceover.md
// §2.4, phase 6): a suggested start for the upload, which the person confirms. Pure and framework-free (no I/O, no
// DOM, no Node built-ins), so it runs on the page and in Node tests.
//
// A person reading the same script speaks and pauses where the AI voice did, so the two energy envelopes line up even
// though the voices differ. Three passes, each bounded:
//   1. coarse: Pearson correlation of 10 ms log-energy envelopes (the AI voice stems summed in power on the
//      composition timeline) over every lag in the search range (±10 s around where the clip is, or the whole track
//      when it's short). When lags × frames is over a budget, both envelopes are pooled by a factor first and the
//      best pooled lag is refined at 10 ms.
//   2. fine: the same correlation on a 1 ms hop, at every sample lag within ±1 frame of the coarse peak, over the
//      most varied ≤ 8 s of the overlap.
//   3. waveform: normalized cross-correlation of the raw samples within ±2 ms, kept only when it is strong (the upload
//      is the AI voice itself, re-exported or re-recorded through speakers); different voices don't correlate there.
import { SAMPLE_RATE } from './timeline.js'

/** One AI voice stem: its mono samples at 24 kHz and the composition sample it starts at. */
export interface VoiceStem {
  start: number
  samples: Float32Array
}

export interface AlignOptions {
  /** Where the clip is now (composition samples); the ±10 s search is centred here. Default 0. */
  near?: number
  /** Search radius in samples around `near`. Default ALIGN_SEARCH_SAMPLES. */
  radius?: number
  /** A composition whose AI voice ends within this many samples is searched whole. Default 120 s. */
  wholeTrackBelow?: number
}

export interface AlignSuggestion {
  /** Composition sample where upload sample 0 belongs. Negative: the upload has extra audio before the voice. */
  start: number
  /** Pearson correlation of the envelopes at the coarse peak, 0..1. */
  score: number
  /** How the start was refined: 'frame' (10 ms), 'envelope' (1 ms hop, sample lags) or 'waveform' (exact). */
  refined: 'frame' | 'envelope' | 'waveform'
}

/** Envelope frame: 10 ms. */
export const ALIGN_FRAME_SAMPLES = SAMPLE_RATE / 100
export const ALIGN_SEARCH_SAMPLES = 10 * SAMPLE_RATE
/** Below this coarse score there's no suggestion. */
export const ALIGN_MIN_SCORE = 0.3
/** Multiply-adds the coarse pass may spend before it pools frames. */
const COARSE_BUDGET = 4e7
/** The overlap must cover at least this share of the shorter side, and at least 1 s. */
const MIN_OVERLAP_SHARE = 0.25
const MIN_OVERLAP_FRAMES = 100
const FINE_HOP = 24
const FINE_SPAN = 8 * SAMPLE_RATE
const WAVE_RADIUS = 48
const WAVE_MIN = 0.6
/** Energies below this (−80 dBFS) are silence. */
const FLOOR = 1e-8

/** `count` frames of log energy, frame f being `power(f · hop)` (a mean square). */
function logEnvelope(power: (i: number) => number, count: number, hop: number): Float32Array {
  const out = new Float32Array(count)
  for (let f = 0; f < count; f++) out[f] = Math.log10(power(f * hop) + FLOOR)
  return out
}

/** Prefix sums of squares, so any window's mean square is O(1). */
function squarePrefix(x: Float32Array): Float64Array {
  const p = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) p[i + 1] = (p[i] ?? 0) + (x[i] ?? 0) * (x[i] ?? 0)
  return p
}

/** The upload's 10 ms envelope. */
export function uploadEnvelope(samples: Float32Array, hop = ALIGN_FRAME_SAMPLES): Float32Array {
  const p = squarePrefix(samples)
  const n = Math.floor(samples.length / hop)
  return logEnvelope((i) => ((p[i + hop] ?? 0) - (p[i] ?? 0)) / hop, n, hop)
}

/** The AI voice's 10 ms envelope on the composition timeline (stems summed in power), from composition sample 0. */
export function voiceEnvelope(stems: readonly VoiceStem[], hop = ALIGN_FRAME_SAMPLES): Float32Array {
  const end = stems.reduce((m, s) => Math.max(m, s.start + s.samples.length), 0)
  const n = Math.ceil(end / hop)
  const power = new Float64Array(n)
  for (const s of stems)
    for (let i = 0; i < s.samples.length; i++) {
      const t = s.start + i
      if (t < 0) continue
      const v = s.samples[i] ?? 0
      power[Math.floor(t / hop)] = (power[Math.floor(t / hop)] ?? 0) + v * v
    }
  return logEnvelope((i) => (power[i / hop] ?? 0) / hop, n, hop)
}

const pool = (x: Float32Array, d: number) => {
  if (d === 1) return x
  const out = new Float32Array(Math.floor(x.length / d))
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (let k = 0; k < d; k++) s += x[i * d + k] ?? 0
    out[i] = s / d
  }
  return out
}

/** Pearson correlation of u[i] with v[i + lag] over their overlap (null when the overlap is shorter than `min`). */
function pearson(u: Float32Array, v: Float32Array, lag: number, min: number): number | null {
  const a = Math.max(0, -lag)
  const b = Math.min(u.length, v.length - lag)
  const n = b - a
  if (n < min) return null
  let su = 0
  let sv = 0
  let suu = 0
  let svv = 0
  let suv = 0
  for (let i = a; i < b; i++) {
    const x = u[i] ?? 0
    const y = v[i + lag] ?? 0
    su += x
    sv += y
    suu += x * x
    svv += y * y
    suv += x * y
  }
  const cov = suv - (su * sv) / n
  const den = Math.sqrt(Math.max(0, suu - (su * su) / n) * Math.max(0, svv - (sv * sv) / n))
  return den > 1e-9 ? cov / den : null
}

/** The best lag in [lo, hi] (inclusive, in frames) and its score. */
function bestLag(u: Float32Array, v: Float32Array, lo: number, hi: number, min: number) {
  let best: { lag: number; score: number } | null = null
  for (let lag = lo; lag <= hi; lag++) {
    const r = pearson(u, v, lag, min)
    if (r !== null && (!best || r > best.score)) best = { lag, score: r }
  }
  return best
}

/** The composition's AI voice summed into one buffer over [from, from + length) (bounded by the caller). */
function voiceSlice(stems: readonly VoiceStem[], from: number, length: number): Float32Array {
  const out = new Float32Array(Math.max(0, length))
  for (const s of stems) {
    const a = Math.max(from, s.start)
    const b = Math.min(from + length, s.start + s.samples.length)
    for (let t = a; t < b; t++) out[t - from] = (out[t - from] ?? 0) + (s.samples[t - s.start] ?? 0)
  }
  return out
}

/**
 * Suggests where `upload` (mono, 24 kHz) belongs on the composition, given the AI voice stems placed on it. Null when
 * there's no AI voice, nothing to compare, or no convincing match.
 */
export function alignToVoice(
  upload: Float32Array,
  stems: readonly VoiceStem[],
  opts: AlignOptions = {},
): AlignSuggestion | null {
  const hop = ALIGN_FRAME_SAMPLES
  const voiced = stems.filter((s) => s.samples.length > 0)
  if (!voiced.length || upload.length < hop * MIN_OVERLAP_FRAMES) return null
  const u = uploadEnvelope(upload)
  const v = voiceEnvelope(voiced)
  if (v.length < MIN_OVERLAP_FRAMES) return null
  const min = Math.max(MIN_OVERLAP_FRAMES, Math.floor(MIN_OVERLAP_SHARE * Math.min(u.length, v.length)))
  // Lags (frames) where upload frame i sits on composition frame i + lag.
  const whole = v.length * hop <= (opts.wholeTrackBelow ?? 120 * SAMPLE_RATE)
  const near = Math.round((opts.near ?? 0) / hop)
  const radius = Math.round((opts.radius ?? ALIGN_SEARCH_SAMPLES) / hop)
  const lo = whole ? min - u.length : near - radius
  const hi = whole ? v.length - min : near + radius
  // Pool when the full search would cost too much; the pooled peak is refined at full resolution.
  const d = Math.max(1, Math.ceil(Math.sqrt(((hi - lo + 1) * Math.min(u.length, v.length)) / COARSE_BUDGET)))
  const coarse = bestLag(pool(u, d), pool(v, d), Math.floor(lo / d), Math.ceil(hi / d), Math.ceil(min / d))
  if (!coarse) return null
  const frame =
    d === 1
      ? coarse
      : bestLag(u, v, Math.max(lo, (coarse.lag - 2) * d), Math.min(hi, (coarse.lag + 2) * d), min)
  if (!frame || frame.score < ALIGN_MIN_SCORE) return null
  let start = frame.lag * hop
  let refined: AlignSuggestion['refined'] = 'frame'

  // The most varied ≤ 8 s of the upload inside the overlap (speech, not silence), for the fine passes.
  const a = Math.max(0, -frame.lag)
  const b = Math.min(u.length, v.length - frame.lag)
  const spanFrames = Math.min(b - a, FINE_SPAN / hop)
  let chunk = a
  let bestVar = -1
  for (let f = a; f + spanFrames <= b; f += Math.max(1, Math.floor(spanFrames / 4))) {
    let s = 0
    let ss = 0
    for (let i = f; i < f + spanFrames; i++) {
      s += u[i] ?? 0
      ss += (u[i] ?? 0) ** 2
    }
    const variance = ss / spanFrames - (s / spanFrames) ** 2
    if (variance > bestVar) {
      bestVar = variance
      chunk = f
    }
  }
  const from = chunk * hop
  const length = spanFrames * hop
  const up = upload.subarray(from, from + length)
  // The composition around where that chunk lands, with a frame (and the waveform radius) either side.
  const margin = hop + WAVE_RADIUS + FINE_HOP
  const base = from + start - margin
  const comp = voiceSlice(voiced, base, length + 2 * margin)
  const fineN = Math.floor((length - hop) / FINE_HOP)
  if (fineN >= MIN_OVERLAP_FRAMES) {
    const pu = squarePrefix(up)
    const pc = squarePrefix(comp)
    const uf = logEnvelope((i) => ((pu[i + hop] ?? 0) - (pu[i] ?? 0)) / hop, fineN, FINE_HOP)
    let best: { lag: number; score: number } | null = null
    const cf = new Float32Array(fineN)
    for (let lag = -hop; lag <= hop; lag++) {
      const o = margin + lag
      for (let f = 0; f < fineN; f++) {
        const i = o + f * FINE_HOP
        cf[f] = Math.log10(((pc[i + hop] ?? 0) - (pc[i] ?? 0)) / hop + FLOOR)
      }
      const r = pearson(uf, cf, 0, MIN_OVERLAP_FRAMES)
      if (r !== null && (!best || r > best.score)) best = { lag, score: r }
    }
    if (best) {
      start += best.lag
      refined = 'envelope'
    }
  }
  // Raw samples: only the same voice correlates here.
  let wave: { lag: number; score: number } | null = null
  let eu = 0
  for (const x of up) eu += x * x
  for (let lag = -WAVE_RADIUS; lag <= WAVE_RADIUS; lag++) {
    // Upload sample `from` sits on composition sample from + start; comp starts at composition sample base.
    const off = from + start + lag - base
    if (off < 0 || off + length > comp.length) continue
    let dot = 0
    let ec = 0
    for (let i = 0; i < length; i++) {
      const y = comp[off + i] ?? 0
      dot += (up[i] ?? 0) * y
      ec += y * y
    }
    const r = eu > 0 && ec > 0 ? dot / Math.sqrt(eu * ec) : 0
    if (!wave || r > wave.score) wave = { lag, score: r }
  }
  if (wave && wave.score >= WAVE_MIN) {
    start += wave.lag
    refined = 'waveform'
  }
  return { start, score: Math.max(0, Math.min(1, frame.score)), refined }
}
