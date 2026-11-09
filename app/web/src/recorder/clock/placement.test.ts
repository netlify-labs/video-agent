// placeRecordedTake (placement.ts): fit segments + calibration + manual offset -> NarrationClip placement fields.
import { describe, expect, it } from 'vitest'
import { clipEnd, placeTake, SAMPLE_RATE, type NarrationClip } from '../../../../server/lib/timeline'
import type { FitSegment } from './fit'
import { placeRecordedTake } from './placement'

const seg = (fromSample: number, toSample: number, a: number, residualMax = 1.2): FitSegment => ({
  fromSample,
  toSample,
  a,
  b: 1 / SAMPLE_RATE,
  residualRms: 0.4,
  residualMax,
  n: 100,
})

describe('placeRecordedTake', () => {
  it('places one clip per segment with the summed offset and the fit as provenance', () => {
    // Recorded against composition 2.0 s at sample 0; the picture lost a frame at 10 s into the take.
    const segs = [seg(0, 240_000, 2.0), seg(240_000, 480_123.6, 2.0 - 1 / 30, 2.5)]
    const p = placeRecordedTake(segs, -960, 120)
    expect(p).toHaveLength(2)
    expect(p[0]).toEqual({
      start: 2 * SAMPLE_RATE - 840,
      srcStart: 0,
      srcEnd: 240_000,
      fit: { a: 2.0, b: 1 / SAMPLE_RATE, residualMs: 1.2 },
      offsetSamples: -840,
    })
    expect(p[1]!.srcStart).toBe(240_000)
    expect(p[1]!.srcEnd).toBe(480_124)
    expect(p[1]!.fit.residualMs).toBe(2.5)
    expect(p[1]!.start).toBe(placeTake(p[1]!.fit, -840, 240_000))
    // The second clip starts one frame (800 samples) earlier than where the first would have put that sample.
    const asClip = (i: number): NarrationClip => ({
      id: `c${i}`,
      mediaId: 'm',
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      ...p[i]!,
    })
    expect(clipEnd(asClip(0)) - asClip(1).start).toBe(800)
  })

  it('drops empty segments and rounds fractional offsets', () => {
    const p = placeRecordedTake([seg(0, 0.4, 0), seg(0.4, 100, 0)], -10.4, 0.6)
    expect(p).toHaveLength(1)
    expect(p[0]!.offsetSamples).toBe(-9)
    expect(p[0]!.srcStart).toBe(0)
  })
})
