// The recorder worker's pipeline (plan 2026-11-02 §5.1), kept free of worker plumbing so Node tests drive it with a
// MemoryRecoveryStore. Bounded memory: it never holds the take.
//
//   worklet blocks (context rate, Float32, frame index) -> gap fill -> streaming resample to 24 kHz -> PeaksBuilder +
//   SpeechDetector (src/lib/peaks.ts) + PCM16 -> CHUNK_SAMPLES chunks -> streaming SHA-256 over the PCM and a store
//   write per chunk from the first one (the take record carries the running PCM hash)
//
// SHA-256 of the WAV file can't be streamed during the take: its 44-byte header carries the length and comes first.
// So the PCM hash streams live, and finalizeTake() computes the file hash at stop with one pass over header + chunks
// read back from the store (64 chunks, 1.5 MB, at a time), checking the PCM hash on the way. The same pass builds the
// WAV Blob from per-batch Blobs, so the take is never one contiguous buffer here.
//
// A failed chunk write (a quota error, usually) stops the take: later audio is ignored, and the take is finalized from
// the chunks that were saved, with peaks and speech rebuilt from them so every output covers the same samples.
import { encodePeaks, PeaksBuilder, SpeechDetector } from '../../../src/lib/peaks'
import { SAMPLE_RATE, type Span } from '../../../src/lib/timeline'
import { Resampler } from './resample'
import { Sha256 } from './sha256'
import { CHUNK_SAMPLES, chunksOf, isQuotaError, type RecoveryStore, type TakeRecord } from './store'
import { floatToPcm16, pcm16ToFloat, wavHeader } from './wav'

/** Worklet frame gaps longer than this (two render quanta) are filled with silence; shorter jitter is ignored. */
const GAP_FILL_FRAMES = 256

export interface TakeProgress {
  samples: number
  chunks: number
}

export interface FinalTake {
  recordingId: string
  wav: Blob
  /** SHA-256 of the WAV file (what the upload session checks). */
  sha256: string
  pcmSha256: string
  /** 24 kHz samples in the WAV. */
  samples: number
  chunks: number
  /** peaks.bin (src/lib/peaks.ts). */
  peaks: Uint8Array
  speech: Span[]
  /** Context frame of the first sample, and the context's rate. */
  startFrame: number
  ctxRate: number
  /** Why the take stopped early, if it did ('quota', 'storage'). */
  stopReason: string | null
}

export class TakeWriter {
  private readonly resampler: Resampler
  private readonly peaks = new PeaksBuilder(SAMPLE_RATE)
  private readonly speech = new SpeechDetector()
  private readonly sha = new Sha256()
  private readonly chunkBuf = new Uint8Array(CHUNK_SAMPLES * 2)
  private chunkFill = 0
  private seq = 0
  private samples = 0
  private expectedFrame = -1
  private startFrame = -1
  private writes: Promise<void> = Promise.resolve()
  private lastProgress = 0
  /** Set at the first failed write; nothing after it is kept. */
  failure: string | null = null
  inFrames = 0
  padded = 0

  constructor(
    private readonly store: RecoveryStore,
    private readonly record: TakeRecord,
    private readonly hooks: {
      onProgress?: (p: TakeProgress) => void
      /** The first failed chunk write: the caller stops the take. */
      onFailure?: (reason: string, error: unknown) => void
    } = {},
  ) {
    this.resampler = new Resampler(record.ctxRate, SAMPLE_RATE)
  }

  get id(): string {
    return this.record.id
  }

  /** Creates the take record (before the first chunk, so the page's clock fields have something to merge into). */
  async open(): Promise<void> {
    await this.store.patchTake(this.record.id, this.record)
  }

  block(frame: number, samples: Float32Array): void {
    if (this.failure) return
    if (this.startFrame < 0) {
      this.startFrame = frame
      this.expectedFrame = frame
    }
    // A real gap in the worklet's stream: keep sample index == context frame by filling silence. Single-quantum jitter
    // is ignored (S10: Chromium once reported currentFrame one quantum low then skipped one, with continuous data).
    if (frame - this.expectedFrame > GAP_FILL_FRAMES) {
      const fill = new Float32Array(frame - this.expectedFrame)
      this.padded += fill.length
      this.input(fill)
    }
    this.input(samples)
    this.expectedFrame = frame + samples.length
  }

  private input(x: Float32Array): void {
    this.inFrames += x.length
    this.output(this.resampler.push(x))
  }

  private output(y: Float32Array): void {
    if (!y.length || this.failure) return
    this.peaks.push(y)
    this.speech.push(y)
    const pcm = floatToPcm16(y)
    let at = 0
    while (at < pcm.length) {
      const take = Math.min(pcm.length - at, this.chunkBuf.length - this.chunkFill)
      this.chunkBuf.set(pcm.subarray(at, at + take), this.chunkFill)
      this.chunkFill += take
      at += take
      if (this.chunkFill === this.chunkBuf.length) this.commit()
    }
    this.samples += y.length
    const now = Date.now()
    if (now - this.lastProgress > 500) {
      this.lastProgress = now
      this.hooks.onProgress?.({ samples: this.samples, chunks: this.seq })
    }
  }

  private commit(): void {
    if (this.chunkFill === 0) return
    const bytes = this.chunkBuf.slice(0, this.chunkFill)
    this.chunkFill = 0
    this.sha.update(bytes)
    const seq = this.seq++
    const progress = {
      id: this.record.id,
      startFrame: this.startFrame,
      samples: seq * CHUNK_SAMPLES + bytes.length / 2,
      chunks: seq + 1,
      pcmSha256: this.sha.clone().hex(),
    }
    // Writes run one after another, so after a failure the queued ones see it and skip: the saved chunks stay
    // contiguous from 0.
    this.writes = this.writes.then(async () => {
      if (this.failure) return
      try {
        await this.store.putChunk({ take: this.record.id, seq, pcm: bytes.buffer }, progress)
      } catch (e) {
        this.failure = isQuotaError(e) ? 'quota' : 'storage'
        this.hooks.onFailure?.(this.failure, e)
      }
    })
  }

  /** Flushes, waits for the writes and finalizes: the WAV, its hash, peaks and speech spans. */
  async end(): Promise<FinalTake> {
    this.output(this.resampler.finish())
    this.commit()
    await this.writes
    const rec = await this.store.getTake(this.record.id)
    if (!rec) throw new Error('recovery: the take record is gone')
    const failed = this.failure !== null
    const fin = await finalizeTake(this.store, rec, { rebuild: failed })
    if (!failed && fin.pcmSha256 !== this.sha.hex())
      throw new Error('recorder: the saved audio does not match what was recorded')
    const speech = fin.speech ?? this.speech.finish()
    const peaks = fin.peaks ?? encodePeaks(this.peaks.finish())
    await this.store.patchTake(this.record.id, {
      status: 'stopped',
      samples: fin.samples,
      chunks: fin.chunks,
      pcmSha256: fin.pcmSha256,
      fileSha256: fin.sha256,
      stopReason: this.failure,
    })
    return {
      recordingId: this.record.id,
      wav: fin.wav,
      sha256: fin.sha256,
      pcmSha256: fin.pcmSha256,
      samples: fin.samples,
      chunks: fin.chunks,
      peaks,
      speech,
      startFrame: this.startFrame,
      ctxRate: this.record.ctxRate,
      stopReason: this.failure,
    }
  }
}

/**
 * Builds a take's WAV from its saved chunks: the file hash (header first, so the length must be known up front: it is
 * taken from the last chunk, the only one that may be short), the PCM hash, and with `rebuild` the peaks and speech
 * spans too (recovery, or a take cut short by a failed write). Throws when a chunk is missing or the wrong size.
 */
export async function finalizeTake(
  store: RecoveryStore,
  rec: Pick<TakeRecord, 'id' | 'chunks'>,
  opts: { rebuild?: boolean } = {},
): Promise<{
  wav: Blob
  sha256: string
  pcmSha256: string
  samples: number
  chunks: number
  peaks: Uint8Array | null
  speech: Span[] | null
}> {
  const n = rec.chunks
  const last = n > 0 ? (await store.chunkRange(rec.id, n - 1, n))[0] : undefined
  if (n > 0 && !last) throw new Error(`recovery: chunk ${n - 1} of ${rec.id} is missing`)
  const samples = (n - 1) * CHUNK_SAMPLES + (last?.pcm.byteLength ?? 0) / 2
  const total = Math.max(0, samples)
  const header = wavHeader(total, SAMPLE_RATE)
  const file = new Sha256().update(header)
  const pcm = new Sha256()
  const parts: BlobPart[] = [header]
  const peaks = opts.rebuild ? new PeaksBuilder(SAMPLE_RATE) : null
  const speech = opts.rebuild ? new SpeechDetector() : null
  let batch: ArrayBuffer[] = []
  for await (const c of chunksOf(store, rec.id, n)) {
    if (c.seq < n - 1 && c.pcm.byteLength !== CHUNK_SAMPLES * 2)
      throw new Error(`recovery: chunk ${c.seq} of ${rec.id} is short`)
    const bytes = new Uint8Array(c.pcm)
    file.update(bytes)
    pcm.update(bytes)
    if (peaks && speech) {
      const f = pcm16ToFloat(bytes)
      peaks.push(f)
      speech.push(f)
    }
    batch.push(c.pcm)
    if (batch.length === 64) {
      parts.push(new Blob(batch))
      batch = []
    }
  }
  if (batch.length) parts.push(new Blob(batch))
  return {
    wav: new Blob(parts, { type: 'audio/wav' }),
    sha256: file.hex(),
    pcmSha256: pcm.hex(),
    samples: total,
    chunks: n,
    peaks: peaks ? encodePeaks(peaks.finish()) : null,
    speech: speech ? speech.finish() : null,
  }
}
