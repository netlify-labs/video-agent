// Upload to the Narration track (docs/plans/2026-11-02-record-your-own-voiceover.md §2.4, §5.2): an audio file is
// decoded to mono at 24 kHz, its peaks and speech spans are computed off the page, and it goes up as a narration
// upload (role narration-upload, for this video) with them, then is waited on until the server has checked it.
//
// Decoding stays on the page: decodeAudioData and OfflineAudioContext don't exist in workers, and WebCodecs would need
// a demuxer per format. A 24 kHz PCM16 WAV (what the recorder writes) is read directly, without decodeAudioData;
// anything else goes through the browser's decoder once (narration-decode.ts browserDecoder, which resamples). The
// peaks and speech pass (the long part for a long take) runs in a worker, or here when a worker can't start.
import { decodePeaks, VAD_VERSION, type Peaks } from '../../../src/lib/peaks'
import type { Span } from '../../../src/lib/timeline'
import { analyzeSamples, type AnalyzedAudio } from './narration-analyze'
import { browserDecoder, parseWav, sliceable, slicePcm16, type Decoder } from './narration-decode'
import { uploadFile, UploadError, waitReady, type UploadProgress } from './upload'

/** What the Narration track takes today (WebM/Opus once the classifier reads it, §5.2). */
export const NARRATION_ACCEPT =
  'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/ogg,.mp3,.m4a,.wav,.ogg'
const NARRATION_FILE = /\.(mp3|m4a|wav|ogg)$/i

export const isNarrationFile = (f: File): boolean => NARRATION_FILE.test(f.name)

/** A take on the track: its id, length, speech spans, waveform and name. */
export interface ImportedTake {
  mediaId: string
  samples: number
  spans: Span[]
  peaks: Peaks
  name: string
}

const log = (event: string, fields: Record<string, unknown>) => {
  console.info(JSON.stringify({ event, ...fields }))
}

/** The file as mono samples at 24 kHz. */
export async function decodeFile(f: File, decode: Decoder = browserDecoder): Promise<Float32Array> {
  const bytes = await f.arrayBuffer()
  const w = parseWav(bytes)
  if (sliceable(w)) return slicePcm16(bytes, w, 0, w.frames)
  return decode(bytes)
}

/** Peaks and speech in the analysis worker; on the page when the worker can't start or fails. */
export async function analyze(mono: Float32Array): Promise<AnalyzedAudio> {
  let worker: Worker
  try {
    worker = new Worker(new URL('./narration-analyze.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return analyzeSamples(mono)
  }
  try {
    return await new Promise<AnalyzedAudio>((ok, bad) => {
      worker.onmessage = (e: MessageEvent<AnalyzedAudio>) => {
        ok(e.data)
      }
      worker.onerror = () => {
        bad(new Error('worker'))
      }
      // Copied, not transferred: if the worker fails, the samples are still here for the fallback.
      worker.postMessage({ samples: mono })
    })
  } catch {
    return analyzeSamples(mono)
  } finally {
    worker.terminate()
  }
}

export interface ImportOptions {
  scopeJobId: string
  userId?: string | undefined
  onProgress?: (p: UploadProgress | { phase: 'decoding'; sent: 0; total: number }) => void
  decode?: Decoder
  signal?: AbortSignal
}

/**
 * Decodes, analyzes and uploads one file as narration for video `scopeJobId`, and waits until it's ready. Throws
 * UploadError with a message people can act on.
 */
export async function importNarrationFile(f: File, opts: ImportOptions): Promise<ImportedTake> {
  if (!isNarrationFile(f)) throw new UploadError(`${f.name} isn't an MP3, M4A, WAV or Ogg file.`)
  const t0 = performance.now()
  opts.onProgress?.({ phase: 'decoding', sent: 0, total: f.size })
  let mono: Float32Array
  try {
    mono = await decodeFile(f, opts.decode)
  } catch {
    log('narration.import.decode_failed', { file: f.name, bytes: f.size })
    throw new UploadError(`${f.name} can't be played in this browser. Try an MP3 or WAV.`)
  }
  if (!mono.length) throw new UploadError(`${f.name} has no audio.`)
  const a = await analyze(mono)
  const t1 = performance.now()
  log('narration.import.decoded', {
    file: f.name,
    bytes: f.size,
    samples: a.samples,
    spans: a.spans.length,
    ms: Math.round(t1 - t0),
  })
  const mediaId = await uploadFile(f, {
    role: 'narration-upload',
    scopeJobId: opts.scopeJobId,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    extra: { peaks: a.peaks, speech: { version: VAD_VERSION, spans: a.spans, samples: a.samples } },
  })
  await waitReady(mediaId, opts.signal ? { signal: opts.signal } : {})
  log('narration.import.ready', { file: f.name, mediaId, ms: Math.round(performance.now() - t1) })
  return { mediaId, samples: a.samples, spans: a.spans, peaks: decodePeaks(a.peaks), name: f.name }
}
