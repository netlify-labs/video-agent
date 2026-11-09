// The review's narration (review.ts): exactly what Add would leave on the track, a punch-in keeping the narration
// around its range; the span it plays and the times it shows.
import { describe, expect, it } from 'vitest'
import { IDENTITY_FIT, SAMPLE_RATE, type NarrationClip, type NarrationOp } from '../../../server/lib/timeline'
import type { RecordedPlacement } from './clock'
import type { Review } from './flow'
import { reviewMediaId, reviewOp, reviewSpan, tenths } from './review'

const S = SAMPLE_RATE

const opOf = (clips: NarrationClip[]): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})
const clip = (id: string, mediaId: string, start: number, len: number): NarrationClip => ({
  id,
  mediaId,
  srcStart: 0,
  srcEnd: len,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
})
/** A recorded piece: source [srcStart, srcEnd) at composition `start` (the identity fit). */
const piece = (start: number, srcStart: number, srcEnd: number): RecordedPlacement => ({
  start,
  srcStart,
  srcEnd,
  offsetSamples: start - srcStart,
  fit: IDENTITY_FIT,
})
const review = (o: Partial<Review>): Review => ({
  recordingId: 'rec_1',
  pieces: [piece(0, 0, 8.7 * S)],
  punch: null,
  early: true,
  from: 0,
  joined: false,
  ...o,
})

describe('the review narration', () => {
  it('a whole take: the take alone, at its place, under the review media id', () => {
    const id = reviewMediaId('rec_1')
    const op = reviewOp(opOf([]), { mediaId: id, samples: 9 * S }, [piece(0, 0, 8.7 * S)], {
      fps: 30,
      takeSamples: new Map(),
      keepTakes: false,
    })
    expect(op?.clips).toEqual([
      expect.objectContaining({ mediaId: id, start: 0, srcStart: 0, srcEnd: 8.7 * S }),
    ])
  })

  it('a punch-in replaces only its range: the old narration plays on either side', () => {
    const old = clip('nar_1', 'med_old', 0, 10 * S)
    const id = reviewMediaId('rec_2')
    const op = reviewOp(opOf([old]), { mediaId: id, samples: 6 * S }, [piece(4 * S, 3 * S, 5 * S)], {
      fps: 30,
      takeSamples: new Map([['med_old', 10 * S]]),
      keepTakes: true,
    })
    const spans = (op?.clips ?? [])
      .map((c) => [c.mediaId, c.start, c.start + (c.srcEnd - c.srcStart)])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
    // The old clip around the range, the take inside it (the editor resolves overlaps the way Add would).
    expect(spans.find((s) => s[0] === id)).toEqual([id, 4 * S, 6 * S])
    expect(spans.some((s) => s[0] === 'med_old' && Number(s[1]) === 0)).toBe(true)
  })

  it('nothing to insert gives no op', () => {
    expect(
      reviewOp(opOf([]), { mediaId: 'x', samples: S }, [], {
        fps: 30,
        takeSamples: new Map(),
        keepTakes: false,
      }),
    ).toBeNull()
  })
})

describe('the review span and times', () => {
  it('a take plays from the picture start to its end; a punch from its pre-roll; a joined take from 0', () => {
    expect(reviewSpan(review({}))).toMatchObject({ from: 0, start: 0, end: 8.7 })
    const punch = review({ pieces: [piece(4 * S, 0, 2 * S)], punch: { from: 4 * S, to: 6 * S }, from: 2 * S })
    expect(reviewSpan(punch)).toMatchObject({ from: 2, start: 4, end: 6 })
    expect(reviewSpan({ ...punch, from: 0, joined: true })).toMatchObject({ from: 0, start: 4 })
  })

  it('shows tenths, never past what is there', () => {
    expect(tenths(0)).toBe('0:00.0')
    expect(tenths(8.69)).toBe('0:08.6')
    expect(tenths(8.7)).toBe('0:08.7')
    expect(tenths(72.25)).toBe('1:12.2')
  })
})
