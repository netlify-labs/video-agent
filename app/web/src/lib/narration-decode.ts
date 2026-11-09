// Narration take audio for the audition (docs/plans/2026-11-02-record-your-own-voiceover.md §5.4): each take as mono
// samples at the timeline rate, read by source range, held under one byte budget with LRU eviction. Takes are never
// all decoded at once (32 ten-minute takes as Float32 would be about 1.8 GB).
//
// A 24 kHz PCM16 WAV (what the recorder writes) is kept as its file bytes, 2 bytes a sample, and a range is converted
// only when it's read, sample-exact, without decodeAudioData. Anything else (an uploaded MP3, a WAV at another rate)
// goes through decodeAudioData on a 24 kHz offline context once, whole, because browsers can't decode a byte range.
import { SAMPLE_RATE } from '../../../server/lib/timeline'

/** The audition's whole cache (take audio plus rendered chunks) stays under this many bytes. */
export const DECODE_BUDGET_BYTES = 200 * 1024 * 1024

// ---- WAV

export interface WavInfo {
  /** 1 PCM, 3 float, 0xfffe extensible (its sub-format is checked separately). */
  format: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Byte offset of the first sample frame. */
  dataOffset: number
  /** Whole sample frames in the data chunk (a truncated file counts what's there). */
  frames: number
}

const tag = (v: DataView, at: number) =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))

/** The fmt and data chunks of a RIFF WAVE file; null when it isn't one. */
export function parseWav(bytes: ArrayBuffer): WavInfo | null {
  const v = new DataView(bytes)
  if (bytes.byteLength < 12 || tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') return null
  let fmt: Omit<WavInfo, 'dataOffset' | 'frames'> | null = null
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = tag(v, at)
    const size = v.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      let format = v.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.byteLength)
        format = v.getUint16(body + 24, true)
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      }
    } else if (id === 'data' && fmt) {
      const frameBytes = fmt.channels * (fmt.bitsPerSample / 8)
      if (!(frameBytes > 0)) return null
      const available = Math.min(size, bytes.byteLength - body)
      return { ...fmt, dataOffset: body, frames: Math.floor(available / frameBytes) }
    }
    at = body + size + (size % 2) // chunks are word-aligned
  }
  return null
}

/** Whether a WAV can be sliced byte-wise: integer PCM16 at the timeline rate. */
export const sliceable = (w: WavInfo | null): w is WavInfo =>
  !!w && w.format === 1 && w.bitsPerSample === 16 && w.sampleRate === SAMPLE_RATE && w.channels >= 1

/**
 * Source samples [from, to) of a PCM16 WAV as mono Float32 (channels averaged, int16 / 32768), sample-exact. Samples
 * outside the file read as silence, like mixToBuffer's.
 */
export function slicePcm16(bytes: ArrayBuffer, w: WavInfo, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.max(0, to - from))
  const v = new DataView(bytes)
  const a = Math.max(0, from)
  const b = Math.min(w.frames, to)
  const ch = w.channels
  for (let s = a; s < b; s++) {
    const at = w.dataOffset + s * ch * 2
    let sum = 0
    for (let c = 0; c < ch; c++) sum += v.getInt16(at + c * 2, true)
    out[s - from] = sum / ch / 32768
  }
  return out
}

// ---- takes

/** One take's audio at SAMPLE_RATE, mono, read by source range. */
export interface TakeAudio {
  kind: 'pcm16' | 'decoded'
  /** Length in samples. */
  samples: number
  /** Bytes this take holds in memory. */
  bytes: number
  read(from: number, to: number): Float32Array
}

export function pcm16Take(bytes: ArrayBuffer, w: WavInfo): TakeAudio {
  return {
    kind: 'pcm16',
    samples: w.frames,
    bytes: bytes.byteLength,
    read: (from, to) => slicePcm16(bytes, w, from, to),
  }
}

export function decodedTake(mono: Float32Array): TakeAudio {
  return {
    kind: 'decoded',
    samples: mono.length,
    bytes: mono.byteLength,
    read(from, to) {
      const out = new Float32Array(Math.max(0, to - from))
      const a = Math.max(0, from)
      const b = Math.min(mono.length, to)
      if (b > a) out.set(mono.subarray(a, b), a - from)
      return out
    },
  }
}

/** Decodes compressed audio to mono at SAMPLE_RATE (injectable: tests and Node have no decoder). */
export type Decoder = (bytes: ArrayBuffer) => Promise<Float32Array>

/** The browser's decoder: decodeAudioData on a 24 kHz offline context (it resamples), channels averaged. */
export const browserDecoder: Decoder = async (bytes) => {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  const buf = await ctx.decodeAudioData(bytes)
  const out = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) out[i] = (out[i] ?? 0) + (d[i] ?? 0) / buf.numberOfChannels
  }
  return out
}

/** A take's file bytes as TakeAudio: sliced in place when it's 24 kHz PCM16 WAV, else decoded whole. */
export async function takeFromBytes(bytes: ArrayBuffer, decode: Decoder): Promise<TakeAudio> {
  const w = parseWav(bytes)
  return sliceable(w) ? pcm16Take(bytes, w) : decodedTake(await decode(bytes))
}

// ---- budget

export interface BudgetStats {
  budgetBytes: number
  usedBytes: number
  entries: number
  evictions: number
  /** Bytes still held by entries the current window needs, past the budget (0 normally). */
  overBudgetBytes: number
}

/**
 * A byte-budgeted LRU cache. `get` and `set` mark an entry used; `trim` evicts least-recently-used entries until the
 * cache fits, never one in `pinned` (what the playhead's window needs), so a window bigger than the budget is held
 * whole and reported as overBudgetBytes rather than thrashed.
 */
export class LruBudget<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>()
  private used = 0
  private evicted = 0
  constructor(
    readonly budgetBytes: number,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key) // Map keeps insertion order: re-inserting makes it the most recent
    this.map.set(key, e)
    return e.value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: V, bytes: number, pinned: ReadonlySet<string> = new Set()) {
    this.delete(key)
    this.map.set(key, { value, bytes })
    this.used += bytes
    this.trim(new Set([...pinned, key]))
  }

  delete(key: string) {
    const e = this.map.get(key)
    if (!e) return
    this.map.delete(key)
    this.used -= e.bytes
  }

  /** Drops every entry whose key matches (e.g. rendered chunks of an op that changed). */
  deleteWhere(match: (key: string) => boolean) {
    for (const k of [...this.map.keys()]) if (match(k)) this.delete(k)
  }

  trim(pinned: ReadonlySet<string> = new Set()) {
    for (const [k, e] of this.map) {
      if (this.used <= this.budgetBytes) break
      if (pinned.has(k)) continue
      this.map.delete(k)
      this.used -= e.bytes
      this.evicted++
      this.onEvict?.(k, e.value)
    }
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  stats(): BudgetStats {
    return {
      budgetBytes: this.budgetBytes,
      usedBytes: this.used,
      entries: this.map.size,
      evictions: this.evicted,
      overBudgetBytes: Math.max(0, this.used - this.budgetBytes),
    }
  }
}
