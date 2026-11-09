// Reviewing a stopped take before it goes on the timeline (record flow, Review): the narration as Add would leave it,
// made with the editor's own insert command but never dispatched, so the review plays exactly what Add would add
// (a punch-in replaces its range; the narration around it plays on). The take is heard from the local WAV under a
// stand-in media id before its upload finishes.
import { SAMPLE_RATE, type NarrationOp } from '../../../server/lib/timeline'
import { applyCommand } from '../lib/narration-commands'
import { freshClipId, takeClip } from '../lib/narration-panel'
import type { RecordedPlacement } from './clock'
import { takeEnd, type Review } from './flow'

/** The media id the review plays the local take under (no real media id starts with this). */
export const reviewMediaId = (recordingId: string) => `review_${recordingId}`

/** The narration with the take's clips inserted as Add would (keepTakes for a punch-in), or null if it can't be. */
export function reviewOp(
  op: NarrationOp,
  take: { mediaId: string; samples: number },
  pieces: readonly RecordedPlacement[],
  ctx: { fps: number; takeSamples: ReadonlyMap<string, number>; keepTakes: boolean },
): NarrationOp | null {
  const taken = new Set<string>()
  const clips = pieces.map((p) => {
    const id = freshClipId(op, taken)
    taken.add(id)
    return {
      ...takeClip(id, take.mediaId, take.samples, p.start),
      srcStart: p.srcStart,
      srcEnd: p.srcEnd,
      fit: p.fit,
      offsetSamples: p.offsetSamples,
    }
  })
  const [first, ...rest] = clips
  if (!first) return null
  const r = applyCommand(
    op,
    {
      type: 'insert',
      clip: first,
      ...(rest.length ? { with: rest } : {}),
      ...(ctx.keepTakes ? { keepTakes: true } : {}),
    },
    {
      takeSamples: new Map([...ctx.takeSamples, [take.mediaId, take.samples]]),
      baseSamples: Number.MAX_SAFE_INTEGER,
      fps: ctx.fps,
    },
  )
  return r.ok ? r.op : null
}

/** The composition seconds the review plays: from the picture's start (or 0, joined) to where the take ends. */
export function reviewSpan(review: Review): { from: number; to: number; start: number; end: number } {
  const start = (review.pieces[0]?.start ?? 0) / SAMPLE_RATE
  const end = takeEnd(review.pieces) / SAMPLE_RATE
  return { from: Math.min(review.from / SAMPLE_RATE, start), to: end, start, end }
}

/** Seconds as 0:08.7 (tenths, floored so the end never reads past what's there). */
export function tenths(sec: number): string {
  const t = Math.max(0, Math.floor(sec * 10 + 1e-6)) / 10
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}
