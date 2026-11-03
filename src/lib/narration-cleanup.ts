// Narration take cleanup (docs/spikes.md S13, plan §6.3 step 2). Pure helpers: the ffmpeg filtergraph for a preset
// plus measured parameters, and the measurements it needs (an energy speech gate, BS.1770 loudness of the speech
// regions, the noise floor in the gaps, 4-9 kHz band energy) over decoded 24 kHz mono PCM16. scripts/lib runs ffmpeg.
//
// The chain is sample-for-sample (IIR high-pass, FFT denoiser, de-esser, feed-forward compressor, gain), so the output
// has exactly the input's sample count: no content trim, no time-stretch. afftdn alone delays its output by a
// quarter window (600 samples, 25 ms at 24 kHz, the same in ffmpeg 6.0 and 9.0) and drops the tail by as much, so
// the graph pads that many samples after the take and cuts them off the front again: no time shift either.
// Every option used exists in ffmpeg 6.0 (run with the 6.0 static build and 9.0.2: identical PCM), so 6.1 should too.
//
// `heavy` (opt-in) declicks before denoising and follows afftdn with RNNoise (arnndn) and a vendored, pinned model
// (scripts/lib/rnnoise/README.md). arnndn runs at 48 kHz only and delays by one 10 ms frame (480 samples there, 240
// at 24 kHz), so it gets the same pad-and-trim treatment around an explicit 48 kHz round trip. It also emits whole
// frames, filling the last one with uninitialised memory (its output then differs from run to run, and reaches one
// frame back), so the pad is three frames, not one, and the trim cuts at the take's own length.
import type { NarrationCleanup } from './timeline.js'

export const CLEANUP_SAMPLE_RATE = 24_000
/** The narration processing recipe's version (plan §6.3): frozen with every render, bumped when the chain changes. */
export const NARRATION_PIPELINE = 1
export type CleanupPreset = NarrationCleanup
/** afftdn's latency in samples at CLEANUP_SAMPLE_RATE (measured with a click; test/narration-cleanup.test.ts). */
export const AFFTDN_DELAY = 600
/** arnndn's latency in samples at CLEANUP_SAMPLE_RATE (one RNNoise frame; measured with a chirp, same test file). */
export const ARNNDN_DELAY = 240
/** Silence appended before arnndn: its delay plus two frames, so its unstable last frame lands in the cut tail. */
export const ARNNDN_PAD = 3 * ARNNDN_DELAY
/** The RNNoise model heavy uses, vendored at scripts/lib/rnnoise/ (rnnoise-models "somnolent-hogwash"). */
export const RNNOISE_MODEL = {
  file: 'sh.rnnn',
  sha256: '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
} as const

type Range = readonly [lo: number, hi: number]
export interface LightParams {
  highpassHz: number
  /** afftdn noise reduction in dB. */
  noiseReductionDb: number
  /** afftdn's noise floor is the raw take's gap level (dBFS RMS) plus this, clamped to afftdn's range. */
  noiseFloorOffsetDb: number
  noiseFloorRange: Range
  /** De-esser intensity, max de-essing and split frequency, in ffmpeg's 0-1 units. */
  deesser: { i: number; m: number; f: number }
  /** Speech level the compressor sees: the take is brought here before it, so every take is compressed alike. */
  preTargetLufs: number
  preGainRange: Range
  compressor: {
    thresholdDb: number
    ratio: number
    attackMs: number
    releaseMs: number
    knee: number
    detection: 'rms' | 'peak'
  }
  /** Per-take speech target, from gated loudness of the speech regions after the chain. */
  speechTargetLufs: number
  trimRange: Range
  /** The trim never pushes the take's true peak above this (the output is PCM16; the bus limiter sits at -2 dBTP). */
  peakCeilingDbtp: number
}

/** The v1 light chain (S13). Levels are dBFS / LUFS, times ms. */
export const LIGHT: LightParams = {
  highpassHz: 80,
  noiseReductionDb: 12,
  noiseFloorOffsetDb: 10,
  noiseFloorRange: [-80, -20],
  deesser: { i: 0.4, m: 0.5, f: 0.5 },
  preTargetLufs: -24,
  preGainRange: [-12, 24],
  compressor: { thresholdDb: -24, ratio: 2, attackMs: 10, releaseMs: 120, knee: 4, detection: 'rms' },
  speechTargetLufs: -18,
  trimRange: [-12, 12],
  peakCeilingDbtp: -1,
}

export interface CleanupMeasured {
  /** Gap level of the raw take (dBFS RMS); null when the take has no gaps to measure. */
  noiseFloorDb: number | null
  /** Gain before the compressor (dB). */
  preGainDb: number
  /** Gain after the compressor toward the speech target (dB). */
  trimDb: number
}

const fx = (n: number, d = 2) => {
  const s = n.toFixed(d)
  return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s
}
const clamp = (v: number, [lo, hi]: Range) => Math.min(hi, Math.max(lo, v))
const dbToLin = (db: number) => 10 ** (db / 20)

/**
 * arnndn around a 48 kHz round trip, padded and cut so the output is the input's `samples`, sample-aligned (an
 * impulse lands on its own sample; test/narration-cleanup.test.ts).
 */
export function rnnoiseStage(model: string, samples: number): string[] {
  if (UNSAFE_PATH.test(model) || !model)
    throw new Error(`the RNNoise model path can't hold spaces or : , ; = [ ] ' \\ (filtergraph syntax)`)
  if (!Number.isInteger(samples) || samples < 1) throw new Error('the RNNoise stage needs the take length')
  return [
    `apad=pad_len=${ARNNDN_PAD}`,
    'aresample=48000',
    `arnndn=m=${model}`,
    `aresample=${CLEANUP_SAMPLE_RATE}`,
    `atrim=start_sample=${ARNNDN_DELAY}:end_sample=${ARNNDN_DELAY + samples}`,
  ]
}

/** Characters that would need filtergraph escaping in the model path; such a path is refused, not escaped. */
const UNSAFE_PATH = /[\\':,;=[\]\s]/

/**
 * The ffmpeg -af graph for a take, or null for `off` (a true bypass: the take's bytes are used as they are, no
 * ffmpeg). Numbers are written with fixed decimals so the same inputs always give the same string. `heavy` needs
 * the RNNoise model's path (scripts/lib/narration-cleanup.ts resolves the vendored one) and the take's length.
 */
export function cleanupFilter(
  preset: CleanupPreset,
  m: CleanupMeasured,
  p: LightParams = LIGHT,
  rnnoise?: { model: string; samples: number },
): string | null {
  if (preset === 'off') return null
  const c = p.compressor
  const nf = clamp(Math.round((m.noiseFloorDb ?? -60) + p.noiseFloorOffsetDb), p.noiseFloorRange)
  const afftdn = [
    `apad=pad_len=${AFFTDN_DELAY}`,
    `afftdn=nr=${fx(p.noiseReductionDb, 1)}:nf=${nf}:tn=0`,
    `atrim=start_sample=${AFFTDN_DELAY}`,
  ]
  let denoise = afftdn
  if (preset === 'heavy') {
    if (!rnnoise) throw new Error('heavy cleanup needs the RNNoise model and the take length')
    // Declick first (a click would steer both denoisers), then light's afftdn for the steady floor, then RNNoise
    // for what is left (S13: RNNoise alone leaves a quiet take's hiss and loses SNR to light).
    denoise = ['adeclick', ...afftdn, 'asetpts=N/SR/TB', ...rnnoiseStage(rnnoise.model, rnnoise.samples)]
  }
  return [
    `highpass=f=${p.highpassHz}`,
    ...denoise,
    'asetpts=N/SR/TB',
    `volume=${fx(m.preGainDb)}dB:precision=double`,
    `deesser=i=${fx(p.deesser.i)}:m=${fx(p.deesser.m)}:f=${fx(p.deesser.f)}:s=o`,
    `acompressor=threshold=${fx(dbToLin(c.thresholdDb), 6)}:ratio=${fx(c.ratio)}:attack=${fx(c.attackMs)}:release=${fx(c.releaseMs)}:knee=${fx(c.knee)}:makeup=1:detection=${c.detection}`,
    `volume=${fx(m.trimDb)}dB:precision=double`,
  ].join(',')
}

/** Gain before the compressor, from the raw take's speech loudness (0 for a silence-only take). */
export const preGain = (rawSpeechLufs: number | null, p: LightParams = LIGHT) =>
  rawSpeechLufs === null ? 0 : round2(clamp(p.preTargetLufs - rawSpeechLufs, p.preGainRange))

/** Trim after the compressor toward the speech target, capped so the true peak stays under the ceiling. */
export function trimGain(
  cleanedSpeechLufs: number | null,
  cleanedTruePeakDb: number,
  p: LightParams = LIGHT,
): { trimDb: number; peakLimited: boolean } {
  if (cleanedSpeechLufs === null) return { trimDb: 0, peakLimited: false }
  const want = clamp(p.speechTargetLufs - cleanedSpeechLufs, p.trimRange)
  const room = p.peakCeilingDbtp - cleanedTruePeakDb
  return want > room
    ? { trimDb: round2(room), peakLimited: true }
    : { trimDb: round2(want), peakLimited: false }
}
const round2 = (n: number) => Math.round(n * 100) / 100

// ───────── PCM ─────────

export interface Pcm16 {
  sampleRate: number
  channels: number
  samples: Int16Array
  /** Byte range of the data chunk, for hashing the PCM alone. */
  dataOffset: number
  dataBytes: number
}

/** Reads a PCM16 WAV (any chunk order before data). Throws on anything else. */
export function readPcm16(b: Uint8Array): Pcm16 {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const id = (o: number) => String.fromCharCode(...b.subarray(o, o + 4))
  if (b.length < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('not a WAV file')
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 0
  for (let o = 12; o + 8 <= b.length;) {
    const size = v.getUint32(o + 4, true)
    if (id(o) === 'fmt ') {
      format = v.getUint16(o + 8, true)
      channels = v.getUint16(o + 10, true)
      sampleRate = v.getUint32(o + 12, true)
      bits = v.getUint16(o + 22, true)
    } else if (id(o) === 'data') {
      if (format !== 1 || bits !== 16) throw new Error(`WAV is not PCM16 (format ${format}, ${bits} bits)`)
      const bytes = Math.min(size, b.length - o - 8) & ~1
      const samples = new Int16Array(bytes / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = v.getInt16(o + 8 + i * 2, true)
      return { sampleRate, channels, samples, dataOffset: o + 8, dataBytes: bytes }
    }
    o += 8 + size + (size & 1)
  }
  throw new Error('WAV has no data chunk')
}

const toFloat = (s: Int16Array) => Float64Array.from(s, (x) => x / 32768)

// ───────── Biquads ─────────

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number]

function biquad(x: Float64Array, [b0, b1, b2, a1, a2]: Biquad): Float64Array {
  const y = new Float64Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] ?? 0
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    y[i] = yi
  }
  return y
}

/** RBJ cookbook Butterworth sections (Q = 1/sqrt 2). */
function butter(kind: 'hp' | 'lp', f0: number, fs: number): Biquad {
  const w = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  const b =
    kind === 'hp' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
  return [(b[0] ?? 0) / a0, (b[1] ?? 0) / a0, (b[2] ?? 0) / a0, (-2 * cos) / a0, (1 - alpha) / a0]
}

/** BS.1770 K-weighting at any rate (libebur128's derivation of the two stages). */
function kWeight(x: Float64Array, fs: number): Float64Array {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs)
  const Vh = 10 ** (3.999843853973347 / 20)
  const Vb = Vh ** 0.4996667741545416
  let Q = 0.7071752369554196
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ]
  K = Math.tan((Math.PI * 38.13547087602444) / fs)
  Q = 0.5003270373238773
  a0 = 1 + K / Q + K * K
  const hp: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]
  return biquad(biquad(x, shelf), hp)
}

// ───────── Speech gate ─────────

export interface Region {
  start: number
  end: number
}
export const GATE = { frameMs: 20, padMs: 150, mergeMs: 300, minSpeechMs: 100, minGapMs: 200, minRangeDb: 10 }

const dbOf = (meanSquare: number) => (meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120)

/**
 * Speech regions by an energy gate on the 150 Hz-5 kHz band (hum and rumble don't open it): 20 ms frames above
 * noise + max(6, 35% of the noise-to-speech range), padded 150 ms, gaps under 300 ms merged. A take whose frame
 * levels span under 10 dB (or never pass -60 dBFS) has no speech.
 */
export function speechRegions(s: Int16Array, fs = CLEANUP_SAMPLE_RATE): Region[] {
  const band = biquad(biquad(toFloat(s), butter('hp', 150, fs)), butter('lp', 5000, fs))
  const n = Math.round((GATE.frameMs / 1000) * fs)
  const frames: number[] = []
  for (let o = 0; o + n <= band.length; o += n) {
    let e = 0
    for (let i = o; i < o + n; i++) e += (band[i] ?? 0) ** 2
    frames.push(dbOf(e / n))
  }
  if (!frames.length) return []
  const sorted = [...frames].sort((a, b) => a - b)
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? -120
  const floor = pct(0.1)
  const peak = pct(0.95)
  if (peak - floor < GATE.minRangeDb || peak < -60) return []
  const thr = floor + Math.max(6, 0.35 * (peak - floor))
  const pad = Math.round((GATE.padMs / 1000) * fs)
  const merge = Math.round((GATE.mergeMs / 1000) * fs)
  const out: Region[] = []
  frames.forEach((db, k) => {
    if (db < thr) return
    const start = Math.max(0, k * n - pad)
    const end = Math.min(s.length, (k + 1) * n + pad)
    const last = out.at(-1)
    if (last && start - last.end <= merge) last.end = Math.max(last.end, end)
    else out.push({ start, end })
  })
  const minSpeech = (GATE.minSpeechMs / 1000) * fs + 2 * pad
  return out.filter((r) => r.end - r.start >= minSpeech)
}

/** The gaps between speech regions that are long enough to measure room tone in. */
export function gapRegions(speech: Region[], length: number, fs = CLEANUP_SAMPLE_RATE): Region[] {
  const min = (GATE.minGapMs / 1000) * fs
  const gaps: Region[] = []
  let at = 0
  for (const r of [...speech, { start: length, end: length }]) {
    if (r.start - at >= min) gaps.push({ start: at, end: r.start })
    at = Math.max(at, r.end)
  }
  return gaps
}

// ───────── Measurements ─────────

/** dBFS RMS over the regions (full band, unweighted); null when they hold no samples. */
export function rmsDb(s: Int16Array, regions: Region[]): number | null {
  let e = 0
  let n = 0
  for (const r of regions)
    for (let i = r.start; i < r.end; i++) {
      e += ((s[i] ?? 0) / 32768) ** 2
      n++
    }
  return n ? round2(dbOf(e / n)) : null
}

/**
 * BS.1770-4 gated integrated loudness (400 ms blocks, 75% overlap, -70 LUFS absolute and -10 LU relative gates) of
 * the blocks that lie at least half inside the regions; the whole take when `regions` is omitted. null if no block
 * passes the gates.
 */
export function gatedLoudness(s: Int16Array, regions?: Region[], fs = CLEANUP_SAMPLE_RATE): number | null {
  const k = kWeight(toFloat(s), fs)
  const block = Math.round(0.4 * fs)
  const hop = Math.round(0.1 * fs)
  const inside = (a: number, b: number) =>
    !regions ||
    regions.reduce((acc, r) => acc + Math.max(0, Math.min(b, r.end) - Math.max(a, r.start)), 0) * 2 >= b - a
  const z: number[] = []
  for (let o = 0; o + block <= k.length; o += hop) {
    if (!inside(o, o + block)) continue
    let e = 0
    for (let i = o; i < o + block; i++) e += (k[i] ?? 0) ** 2
    z.push(e / block)
  }
  const lufs = (ms: number) => -0.691 + 10 * Math.log10(ms)
  const abs = z.filter((ms) => ms > 0 && lufs(ms) > -70)
  if (!abs.length) return null
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
  const gated = abs.filter((ms) => lufs(ms) > rel)
  return gated.length ? round2(lufs(gated.reduce((a, b) => a + b, 0) / gated.length)) : null
}

/** dB of 4-9 kHz energy over the regions (4th-order Butterworth band), relative to full-band energy there. */
export function sibilanceDb(s: Int16Array, regions: Region[], fs = CLEANUP_SAMPLE_RATE): number | null {
  const x = toFloat(s)
  const hp = butter('hp', 4000, fs)
  const lp = butter('lp', 9000, fs)
  const band = biquad(biquad(biquad(biquad(x, hp), hp), lp), lp)
  let eb = 0
  let ef = 0
  for (const r of regions)
    for (let i = r.start; i < r.end; i++) {
      eb += (band[i] ?? 0) ** 2
      ef += (x[i] ?? 0) ** 2
    }
  return ef > 0 && eb > 0 ? round2(10 * Math.log10(eb / ef)) : null
}

/** The shift (in samples, within ±maxLag) that best aligns b with a: 0 means the chain added no delay. */
export function bestLag(a: Int16Array, b: Int16Array, region: Region, maxLag = 480): number {
  let best = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = Math.max(region.start, -lag); i < Math.min(region.end, a.length - Math.max(0, lag)); i++)
      sum += (a[i] ?? 0) * (b[i + lag] ?? 0)
    if (sum > bestScore) {
      bestScore = sum
      best = lag
    }
  }
  return best
}
