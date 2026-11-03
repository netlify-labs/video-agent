// Placing a recorded take on the Narration track (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, §6.1):
// the take's piecewise fit, plus the route's calibration and the take's manual Sync offset, become NarrationClip
// placement fields. One clip per fit segment: a take whose picture stepped a frame is two clips that join exactly
// (srcEnd of one = srcStart of the next), each placed by its own line, so the step doesn't smear sync over the rest
// of the take. The composition start is timeline.placeTake's, so the editor, the validator and the mixer agree.
import { placeTake, type Fit } from '../../../../src/lib/timeline'
import type { FitSegment } from './fit'

/** The NarrationClip fields a recorded take's clip gets (id, mediaId, gain and fades are the caller's). */
export interface RecordedPlacement {
  start: number
  srcStart: number
  srcEnd: number
  fit: Fit
  /** Calibration + manual offset, in samples (provenance: `start` already includes it). */
  offsetSamples: number
}

/**
 * Clip placements for a take. `calibrationOffsetSamples` is the route's (calibration.ts gives it already negated:
 * the mic hears later than the picture shows, so the take moves earlier); `manualOffsetSamples` is the Sync offset
 * slider's (+ = later). Segments are integer-snapped: srcStart/srcEnd round to whole samples, and empty pieces are
 * dropped. `fit.residualMs` is the segment's max residual, the conservative one of the two.
 */
export function placeRecordedTake(
  fitSegments: readonly FitSegment[],
  calibrationOffsetSamples: number,
  manualOffsetSamples: number,
): RecordedPlacement[] {
  const offsetSamples = Math.round(calibrationOffsetSamples) + Math.round(manualOffsetSamples)
  const out: RecordedPlacement[] = []
  for (const s of fitSegments) {
    const srcStart = Math.max(0, Math.round(s.fromSample))
    const srcEnd = Math.round(s.toSample)
    if (srcEnd <= srcStart) continue
    const fit: Fit = { a: s.a, b: s.b, residualMs: s.residualMax }
    out.push({ start: placeTake(fit, offsetSamples, srcStart), srcStart, srcEnd, fit, offsetSamples })
  }
  return out
}
