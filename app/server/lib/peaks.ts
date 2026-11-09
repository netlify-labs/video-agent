// Waveform peaks and speech spans for narration takes (docs/plans/2026-11-02-record-your-own-voiceover.md §5.1,
// §6.1, §6.2). Computed where the audio is: the recorder worker for takes, a decode worker for uploads, and Node in
// tests and for API-only uploads. Pure and framework-free (no I/O, no DOM, no Node built-ins); both builders take
// audio in blocks of any size and give the same result as one call on the whole take, in the browser and in Node.
//
// peaks.bin, version 1. All integers little-endian.
//
//   offset  size  field
//   0       4     magic "VAPK" (ASCII)
//   4       1     version = 1
//   5       1     level count L (>= 1)
//   6       2     reserved, 0
//   8       4     u32 sample rate (24000)
//   12      4     u32 source length in samples
//   16      8·L   per level, finest first: u32 samples per bin, u32 bin count
//   16+8L   ...   per level, in the same order: bin count × (Int8 min, Int8 max)
//
// Level 0 has PEAKS_BASE_BIN samples per bin; each next level doubles it (pairs of bins merged) until one bin covers
// the whole take, capped at PEAKS_MAX_LEVELS. The last bin of a level may cover fewer samples. A value v in -1..1 is
// stored as round(v · 127) clamped to -127..127, so 0 stays 0 and the scale is symmetric. About 56 KB for 10 minutes.
import { SAMPLE_RATE, type Span } from './timeline.js'

export const PEAKS_MAGIC = 'VAPK'
export const PEAKS_VERSION = 1
/** Samples per bin at the finest level (about 43 ms at 24 kHz). */
export const PEAKS_BASE_BIN = 1024
export const PEAKS_MAX_LEVELS = 16
const HEADER = 16

export interface PeaksLevel {
  samplesPerBin: number
  /** Interleaved (min, max) per bin. */
  data: Int8Array
}

export interface Peaks {
  sampleRate: number
  /** Length of the source in samples. */
  samples: number
  /** Finest first. */
  levels: PeaksLevel[]
}

export const binCount = (level: PeaksLevel): number => level.data.length / 2

const quantize = (v: number): number =>
  Number.isNaN(v) ? 0 : Math.max(-127, Math.min(127, Math.round(v * 127)))

/** Builds peaks from audio pushed in blocks; memory is one Int8 pair per PEAKS_BASE_BIN samples. */
export class PeaksBuilder {
  private readonly bins: number[] = []
  private min = Infinity
  private max = -Infinity
  private inBin = 0
  private total = 0

  constructor(private readonly sampleRate = SAMPLE_RATE) {}

  push(block: Float32Array): void {
    for (const v of block) {
      if (v < this.min) this.min = v
      if (v > this.max) this.max = v
      if (++this.inBin === PEAKS_BASE_BIN) this.flush()
    }
    this.total += block.length
  }

  private flush(): void {
    this.bins.push(quantize(this.min), quantize(this.max))
    this.min = Infinity
    this.max = -Infinity
    this.inBin = 0
  }

  finish(): Peaks {
    if (this.inBin > 0) this.flush()
    const levels: PeaksLevel[] = [{ samplesPerBin: PEAKS_BASE_BIN, data: Int8Array.from(this.bins) }]
    for (let last = levels[0]; last && binCount(last) > 1 && levels.length < PEAKS_MAX_LEVELS;) {
      const n = Math.ceil(binCount(last) / 2)
      const data = new Int8Array(n * 2)
      for (let i = 0; i < n; i++) {
        const a = 4 * i
        const lo = last.data[a] ?? 0
        const hi = last.data[a + 1] ?? 0
        // A trailing odd bin is carried up on its own.
        data[2 * i] = a + 2 < last.data.length ? Math.min(lo, last.data[a + 2] ?? lo) : lo
        data[2 * i + 1] = a + 3 < last.data.length ? Math.max(hi, last.data[a + 3] ?? hi) : hi
      }
      last = { samplesPerBin: last.samplesPerBin * 2, data }
      levels.push(last)
    }
    return { sampleRate: this.sampleRate, samples: this.total, levels }
  }
}

export function computePeaks(samples: Float32Array, sampleRate = SAMPLE_RATE): Peaks {
  const b = new PeaksBuilder(sampleRate)
  b.push(samples)
  return b.finish()
}

/** The coarsest level whose bins are no wider than `samplesPerPixel` (the finest level when zoomed in further). */
export function levelFor(peaks: Peaks, samplesPerPixel: number): PeaksLevel {
  let pick = peaks.levels[0]
  for (const l of peaks.levels) if (l.samplesPerBin <= samplesPerPixel) pick = l
  if (!pick) throw new Error('peaks: no levels')
  return pick
}

export function encodePeaks(p: Peaks): Uint8Array {
  const dataBytes = p.levels.reduce((n, l) => n + l.data.length, 0)
  const out = new Uint8Array(HEADER + 8 * p.levels.length + dataBytes)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) out[i] = PEAKS_MAGIC.charCodeAt(i)
  dv.setUint8(4, PEAKS_VERSION)
  dv.setUint8(5, p.levels.length)
  dv.setUint32(8, p.sampleRate, true)
  dv.setUint32(12, p.samples, true)
  let at = HEADER
  for (const l of p.levels) {
    dv.setUint32(at, l.samplesPerBin, true)
    dv.setUint32(at + 4, binCount(l), true)
    at += 8
  }
  for (const l of p.levels) {
    out.set(new Uint8Array(l.data.buffer, l.data.byteOffset, l.data.length), at)
    at += l.data.length
  }
  return out
}

/** Reads peaks.bin; throws on a wrong magic, an unknown version or a size that doesn't match the header. */
export function decodePeaks(bytes: Uint8Array): Peaks {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (why: string): never => {
    throw new Error(`peaks: ${why}`)
  }
  if (bytes.length < HEADER) fail('too short')
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== PEAKS_MAGIC) fail('bad magic')
  if (dv.getUint8(4) !== PEAKS_VERSION) fail(`unknown version ${dv.getUint8(4)}`)
  const count = dv.getUint8(5)
  if (count < 1) fail('no levels')
  if (bytes.length < HEADER + 8 * count) fail('truncated level table')
  const dims = Array.from({ length: count }, (_, i) => ({
    samplesPerBin: dv.getUint32(HEADER + 8 * i, true),
    bins: dv.getUint32(HEADER + 8 * i + 4, true),
  }))
  let at = HEADER + 8 * count
  if (bytes.length !== at + dims.reduce((n, d) => n + 2 * d.bins, 0)) fail('size does not match header')
  const levels = dims.map(({ samplesPerBin, bins }) => {
    const data = new Int8Array(bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + at + 2 * bins))
    at += 2 * bins
    return { samplesPerBin, data }
  })
  return { sampleRate: dv.getUint32(8, true), samples: dv.getUint32(12, true), levels }
}

// ---- speech spans
//
// A simple energy VAD over the take at 24 kHz: frames of VAD_FRAME_SAMPLES; a frame is speech when its RMS level
// (20·log10(rms), so a full-scale sine is -3 dBFS) is at or above VAD_THRESHOLD_DBFS. Runs of speech frames less
// than VAD_MIN_GAP_SAMPLES apart are joined, runs shorter than VAD_MIN_SPEECH_SAMPLES (clicks, bumps) are dropped,
// and each survivor is extended by VAD_HANGOVER_SAMPLES (word endings and soft consonants fall under the threshold),
// clamped to the take. Spans are [start, end) in source samples. It only needs to say where the voice is, for draft
// duck lanes; the run re-measures the processed bus. Change VAD_VERSION when any of these change.

export const VAD_VERSION = 1
/** 20 ms. */
export const VAD_FRAME_SAMPLES = 480
export const VAD_THRESHOLD_DBFS = -40
/** 200 ms. */
export const VAD_HANGOVER_SAMPLES = 4_800
/** 300 ms. */
export const VAD_MIN_GAP_SAMPLES = 7_200
/** 100 ms. */
export const VAD_MIN_SPEECH_SAMPLES = 2_400

const THRESHOLD_POWER = 10 ** (VAD_THRESHOLD_DBFS / 10)

/** Finds speech spans in audio pushed in blocks; memory is one byte per 20 ms frame. */
export class SpeechDetector {
  private readonly active: number[] = []
  private sum = 0
  private inFrame = 0
  private total = 0

  push(block: Float32Array): void {
    for (const v of block) {
      this.sum += v * v
      if (++this.inFrame === VAD_FRAME_SAMPLES) this.flush()
    }
    this.total += block.length
  }

  private flush(): void {
    this.active.push(this.sum / this.inFrame >= THRESHOLD_POWER ? 1 : 0)
    this.sum = 0
    this.inFrame = 0
  }

  finish(): Span[] {
    if (this.inFrame > 0) this.flush()
    const runs: Span[] = []
    for (const [i, a] of this.active.entries()) {
      if (!a) continue
      const s = i * VAD_FRAME_SAMPLES
      const e = Math.min(s + VAD_FRAME_SAMPLES, this.total)
      const last = runs[runs.length - 1]
      if (last && s - last[1] < VAD_MIN_GAP_SAMPLES) last[1] = e
      else runs.push([s, e])
    }
    const out: Span[] = []
    for (const [s, e] of runs) {
      if (e - s < VAD_MIN_SPEECH_SAMPLES) continue
      const end = Math.min(e + VAD_HANGOVER_SAMPLES, this.total)
      const last = out[out.length - 1]
      if (last && s <= last[1]) last[1] = end
      else out.push([s, end])
    }
    return out
  }
}

export function detectSpeech(samples: Float32Array): Span[] {
  const d = new SpeechDetector()
  d.push(samples)
  return d.finish()
}

/** The fallback when a take has no measured spans (an API-only upload before a run): all of it is speech. */
export function wholeClipSpans(samples: number): Span[] {
  return samples > 0 ? [[0, samples]] : []
}
