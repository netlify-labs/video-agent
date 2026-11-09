// Spike S10: the recorder worker (plan §5.1). Bounded memory: it never holds the take.
//   worklet blocks (context rate, Float32, frame index) -> gap fill -> streaming resample to 24 kHz -> PeaksBuilder
//   (src/lib/peaks.ts) + onset detector + PCM16 -> CHUNK_SAMPLES chunks -> streaming SHA-256 over the PCM and an
//   IndexedDB write per chunk from the first one (the take record carries the running PCM hash, for recovery).
// At the end: flush, wait for the writes, then the file hash. SHA-256 of the WAV file cannot be streamed during the
// take because its 44-byte header carries the length and comes first, so the worker streams SHA-256 over the PCM
// (the data chunk) live and computes the file hash at stop with one pass over header + chunks read back from
// IndexedDB (bounded: read 64 chunks, 1.5 MB, at a time). Both are timed and checked against one-shot hashes by the page.
import { encodePeaks, PeaksBuilder } from '../../../../app/server/lib/peaks.js'
import { OnsetDetector } from '../lib/onsets.js'
import { Resampler } from '../lib/resample.js'
import { Sha256 } from '../lib/sha256.js'
import { floatToPcm16, wavHeader } from '../lib/wav.js'
import { CHUNK_SAMPLES, chunksOf, openDb, putMany, type TakeRecord } from './idb.js'

const OUT_RATE = 24_000

interface Init {
  type: 'init'
  takeId: string
  ctxRate: number
  port: MessagePort
  persist: boolean
  meta?: unknown
}
interface Block {
  type: 'block'
  frame: number
  samples: Float32Array
}
interface End {
  type: 'end'
  startFrame: number
  frames: number
  gaps: { at: number; missing: number }[]
  noInput: number
  blocks: number
}

interface Scope {
  postMessage(m: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<Init>) => void) | null
}
const scope = self as unknown as Scope

class State {
  readonly resampler: Resampler
  readonly peaks = new PeaksBuilder(OUT_RATE)
  readonly onsets = new OnsetDetector({ sampleRate: OUT_RATE })
  readonly sha = new Sha256()
  readonly chunkBuf = new Uint8Array(CHUNK_SAMPLES * 2)
  chunkFill = 0
  seq = 0
  samples = 0
  expectedFrame = -1
  startFrame = -1
  padded = 0
  inFrames = 0
  db: IDBDatabase | null = null
  writes: Promise<void> = Promise.resolve()
  pendingWrites = 0
  maxPending = 0
  writeMs: number[] = []
  writeErrors: string[] = []
  createdAt = Date.now()
  lastProgress = 0

  constructor(readonly init: Init) {
    this.resampler = new Resampler(init.ctxRate, OUT_RATE)
  }

  async open(): Promise<void> {
    if (this.init.persist) this.db = await openDb()
  }

  block(b: Block): void {
    if (this.startFrame < 0) {
      this.startFrame = b.frame
      this.expectedFrame = b.frame
    }
    if (b.frame - this.expectedFrame > 256) {
      // A real gap in the worklet's stream (more than two render quanta): keep sample index == context frame by
      // filling silence. Single-quantum jitter is ignored: Chromium once reported currentFrame one quantum low and
      // then skipped a value (F-128, F-128, F+128) with continuous data, so the block count is the authority there.
      const fill = new Float32Array(b.frame - this.expectedFrame)
      this.padded += fill.length
      this.input(fill)
    }
    this.input(b.samples)
    this.expectedFrame = b.frame + b.samples.length
  }

  private input(x: Float32Array): void {
    this.inFrames += x.length
    this.output(this.resampler.push(x))
  }

  output(y: Float32Array): void {
    if (!y.length) return
    this.peaks.push(y)
    const found = this.onsets.push(y)
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
    const now = performance.now()
    if (found.length || now - this.lastProgress > 500) {
      this.lastProgress = now
      scope.postMessage({
        type: 'progress',
        samples: this.samples,
        chunks: this.seq,
        onsets: found.map((o) => o.sample),
        pendingWrites: this.pendingWrites,
        lastWriteMs: this.writeMs.at(-1) ?? null,
      })
    }
  }

  commit(): void {
    if (this.chunkFill === 0) return
    const bytes = this.chunkBuf.slice(0, this.chunkFill)
    this.chunkFill = 0
    this.sha.update(bytes)
    const seq = this.seq++
    const db = this.db
    if (!db) return
    const rec: TakeRecord = {
      id: this.init.takeId,
      status: 'recording',
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      ctxRate: this.init.ctxRate,
      startFrame: this.startFrame,
      samples: seq * CHUNK_SAMPLES + bytes.length / 2,
      chunks: seq + 1,
      pcmSha256: this.sha.clone().hex(),
      meta: this.init.meta,
    }
    this.pendingWrites++
    this.maxPending = Math.max(this.maxPending, this.pendingWrites)
    this.writes = this.writes.then(async () => {
      const t0 = performance.now()
      try {
        await putMany(db, [
          { store: 'chunks', value: { take: this.init.takeId, seq, pcm: bytes.buffer } },
          { store: 'takes', value: rec },
        ])
      } catch (e) {
        this.writeErrors.push(String(e))
      }
      this.writeMs.push(performance.now() - t0)
      this.pendingWrites--
    })
  }

  async end(e: End): Promise<void> {
    const tEnd = performance.now()
    this.output(this.resampler.finish())
    this.commit()
    const peaks = this.peaks.finish()
    const pcmSha256 = this.sha.hex()
    await this.writes
    const tWritten = performance.now()
    let fileSha256: string | null = null
    let fileHashMs = 0
    if (this.db) {
      const t0 = performance.now()
      const h = new Sha256().update(wavHeader(this.samples, OUT_RATE))
      for await (const c of chunksOf(this.db, this.init.takeId, this.seq)) h.update(new Uint8Array(c.pcm))
      fileSha256 = h.hex()
      fileHashMs = performance.now() - t0
      const rec: TakeRecord = {
        id: this.init.takeId,
        status: 'stopped',
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        ctxRate: this.init.ctxRate,
        startFrame: this.startFrame,
        samples: this.samples,
        chunks: this.seq,
        pcmSha256,
        fileSha256,
        meta: this.init.meta,
      }
      await putMany(this.db, [{ store: 'takes', value: rec }])
    }
    const peaksBytes = encodePeaks(peaks)
    const sortedWrites = [...this.writeMs].sort((p, q) => p - q)
    scope.postMessage(
      {
        type: 'done',
        takeId: this.init.takeId,
        startFrame: this.startFrame,
        ctxRate: this.init.ctxRate,
        inFrames: this.inFrames,
        worklet: e,
        padded: this.padded,
        samples: this.samples,
        expectedSamples: Math.ceil((this.inFrames * OUT_RATE) / this.init.ctxRate),
        chunks: this.seq,
        pcmSha256,
        fileSha256,
        fileHashMs,
        flushMs: tWritten - tEnd,
        peaks: {
          levels: peaks.levels.map((l) => ({ samplesPerBin: l.samplesPerBin, bins: l.data.length / 2 })),
          bytes: peaksBytes,
        },
        onsets: this.onsets.onsets.map((o) => ({ sample: o.sample, peak: o.peak })),
        idb: {
          writes: this.writeMs.length,
          maxPending: this.maxPending,
          p50Ms: sortedWrites[Math.floor(sortedWrites.length / 2)] ?? null,
          p99Ms: sortedWrites[Math.floor(sortedWrites.length * 0.99)] ?? null,
          maxMs: sortedWrites.at(-1) ?? null,
          errors: this.writeErrors,
        },
      },
      [peaksBytes.buffer],
    )
  }
}

scope.onmessage = (ev: MessageEvent<Init>) => {
  const m = ev.data
  if (m.type !== 'init') return
  const s = new State(m)
  const ready = s.open()
  m.port.onmessage = (e: MessageEvent<Block | End>) => {
    const d = e.data
    void ready
      .then(() => (d.type === 'block' ? s.block(d) : s.end(d)))
      .catch((err: unknown) => scope.postMessage({ type: 'error', error: String(err) }))
  }
  void ready.then(() => scope.postMessage({ type: 'ready', takeId: m.takeId }))
}
