// What a take's waveform and duck lanes are drawn from without decoding it (voice-over plan §5.1, §6.1): peaks.bin
// (the VAPK pyramid in src/lib/peaks.ts) at `<media id>/peaks.bin`, and the take summary as top-level meta.json fields
// that the narration op reads (edits.ts takeSummary): `samples` (the take's length at 24 kHz), `speech` (Span[]) and
// `speechVersion` (the VAD version). The recorder computes peaks and spans as it records and sends them after the
// upload session; only the uploader writes them, before or after the take is ready. Assembly fills in `samples` when
// the client didn't. Reading them follows canReadTake, like the take.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { Classified } from '../lib/media/classify.js'
import { decodePeaks } from '../lib/peaks.js'
import { SAMPLE_RATE, secondsToSamples, type Span } from '../lib/timeline.js'
import { loadMedia, mergeMediaMeta, readMediaMeta } from './media.js'
import type { Principal } from './policy.js'
import { isTake, takePeaksKey } from './takes.js'

/** About 56 KB covers 10 minutes; anything much bigger isn't peaks for a take. */
export const PEAKS_MAX_BYTES = 256 * 1024
/** Spans in one summary (10 minutes of alternating 100 ms speech and 300 ms pauses is 1,500). */
export const SPEECH_MAX_SPANS = 10_000

export interface SpeechSummary {
  version: number
  spans: Span[]
  /** The take's length in samples at 24 kHz, when known. */
  samples?: number | undefined
}

/**
 * A take's length in samples at 24 kHz, from its bytes: exact from a PCM WAV's header (frames in the data chunk,
 * resampled to 24 kHz when recorded at another rate), else from the classified duration.
 */
export function takeSamples(bytes: Uint8Array, c: Classified): number | null {
  if (c.ext === 'wav') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const id = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
    let rate = 0
    let align = 0
    for (let o = 12, n = 0; o + 8 <= bytes.length && n < 64; n++) {
      const size = dv.getUint32(o + 4, true)
      if (id(o) === 'fmt ' && o + 16 <= bytes.length) {
        rate = dv.getUint32(o + 12, true)
        align = dv.getUint16(o + 20, true)
      } else if (id(o) === 'data') {
        // Streamed WAVs leave the size unset (0 or 0xFFFFFFFF): count what's there.
        const left = bytes.length - (o + 8)
        const data = size === 0 || size > left ? left : size
        if (rate > 0 && align > 0) return Math.round((Math.floor(data / align) * SAMPLE_RATE) / rate)
        break
      }
      o += 8 + size + (size & 1)
    }
  }
  return c.durationSec ? secondsToSamples(c.durationSec) : null
}

/** The caller's own take, not rejected or being deleted; anyone else's is not_found. */
async function ownTake(deps: Deps, p: Principal, id: string) {
  const m = await deps.store.getMedia(id)
  if (!m || m.deletedAt || m.deletingAt || m.uploaderId !== p.userId)
    throw new ApiError('not_found', 'Media not found.')
  // Peaks and speech spans exist only for takes.
  if (!isTake(m)) throw new ApiError('invalid_request', 'Only recordings have peaks and speech spans.')
  if (m.status === 'rejected') throw new ApiError('conflict', 'This recording was rejected.')
  return m
}

/** A take the caller may read (loadMedia applies canReadTake); library items have no peaks. */
async function readableTake(deps: Deps, p: Principal, id: string) {
  const m = await loadMedia(deps, p, id)
  // Same: only takes have peaks.
  if (!isTake(m)) throw new ApiError('not_found', 'This item has no peaks.')
  return m
}

export async function putTakePeaks(deps: Deps, p: Principal, id: string, bytes: Uint8Array) {
  const m = await ownTake(deps, p, id)
  if (bytes.byteLength > PEAKS_MAX_BYTES)
    throw new ApiError('invalid_request', `Peaks must be ${PEAKS_MAX_BYTES / 1024} KB or smaller.`)
  let peaks
  try {
    peaks = decodePeaks(bytes)
  } catch (e) {
    throw new ApiError('invalid_request', `These aren't valid peaks (${(e as Error).message}).`)
  }
  if (peaks.sampleRate !== SAMPLE_RATE)
    throw new ApiError('invalid_request', `Peaks must be at ${SAMPLE_RATE} Hz.`)
  await deps.blobs.set('media', takePeaksKey(m.id), bytes, {
    contentType: 'application/octet-stream',
    size: String(bytes.byteLength),
  })
  deps.log.info('take.peaks_stored', {
    mediaId: m.id,
    bytes: bytes.byteLength,
    levels: peaks.levels.length,
    samples: peaks.samples,
  })
  return { mediaId: m.id, bytes: bytes.byteLength, levels: peaks.levels.length, samples: peaks.samples }
}

export async function getTakePeaks(deps: Deps, p: Principal, id: string) {
  const m = await readableTake(deps, p, id)
  const bytes = await deps.blobs.get('media', takePeaksKey(m.id))
  if (!bytes) throw new ApiError('not_found', 'No peaks for this recording yet.')
  return bytes
}

/** Spans are [start, end) in source samples: whole numbers, each start before its end, in order, not overlapping. */
function checkSpans(spans: Span[]) {
  if (spans.length > SPEECH_MAX_SPANS)
    throw new ApiError('invalid_request', `Send at most ${SPEECH_MAX_SPANS} speech spans.`)
  let last = 0
  for (const [i, [s, e]] of spans.entries()) {
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < last || e <= s)
      throw new ApiError(
        'invalid_request',
        `Speech span ${i} must be whole samples [start, end) with start < end, in order and not overlapping.`,
      )
    last = e
  }
}

const isSamples = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0

export async function putTakeSpeech(deps: Deps, p: Principal, id: string, input: SpeechSummary) {
  const m = await ownTake(deps, p, id)
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new ApiError('invalid_request', 'version must be a positive integer.')
  if (input.samples !== undefined && !isSamples(input.samples))
    throw new ApiError('invalid_request', 'samples must be a positive whole number.')
  checkSpans(input.spans)
  const spans = input.spans.map(([s, e]): Span => [s, e])
  // Under the row lock, so the take's assembly (which writes the rest of meta.json the same way) can't drop them.
  const samples = await deps.store.tx(async (repo) => {
    await repo.lockMedia([m.id])
    const meta = await readMediaMeta(deps, m.id)
    const length = input.samples ?? (isSamples(meta?.samples) ? meta.samples : undefined)
    const end = spans[spans.length - 1]?.[1] ?? 0
    if (length !== undefined && end > length)
      throw new ApiError(
        'invalid_request',
        `Speech spans end at ${end}, past the recording's ${length} samples.`,
      )
    await mergeMediaMeta(deps, m.id, {
      speech: spans,
      speechVersion: input.version,
      ...(input.samples !== undefined ? { samples: input.samples } : {}),
    })
    return length
  })
  deps.log.info('take.speech_stored', { mediaId: m.id, spans: spans.length, version: input.version, samples })
  return { version: input.version, spans, ...(samples !== undefined ? { samples } : {}) }
}

export async function getTakeSpeech(deps: Deps, p: Principal, id: string): Promise<SpeechSummary> {
  const m = await readableTake(deps, p, id)
  const meta = await readMediaMeta(deps, m.id)
  if (!meta || !Array.isArray(meta.speech))
    throw new ApiError('not_found', 'No speech spans for this recording yet.')
  return {
    version: typeof meta.speechVersion === 'number' ? meta.speechVersion : 1,
    spans: meta.speech as Span[],
    ...(isSamples(meta.samples) ? { samples: meta.samples } : {}),
  }
}
