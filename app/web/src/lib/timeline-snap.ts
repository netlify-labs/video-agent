// Snapping for the narration timeline (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3): a dragged edge or
// a ruler selection snaps to beat boundaries, other clips' edges and the playhead when it's within a few pixels of
// one. Holding Alt / Option turns it off. Pure: the timeline's ruler uses it now, and the clip editing commands
// (move, trim) use it for the edge being dragged.
import { clipEnd, secondsToSamples, SAMPLE_RATE, type NarrationClip } from '../../../server/lib/timeline'

/** How close (CSS px) an edge must come to a target to snap. */
export const SNAP_PX = 8

export type SnapKind = 'beat' | 'clip' | 'playhead'

export interface SnapTarget {
  sample: number
  kind: SnapKind
}

/**
 * Every snap target, sorted by sample: each beat's start and end (beats given in composition seconds), the start and
 * end of each clip not in `exclude` (the clips being dragged), and the playhead.
 */
export function snapTargets(input: {
  beats?: readonly { start: number; duration: number }[]
  clips?: readonly NarrationClip[]
  playhead?: number | null
  exclude?: ReadonlySet<string>
}): SnapTarget[] {
  const out: SnapTarget[] = []
  for (const b of input.beats ?? []) {
    out.push({ sample: secondsToSamples(b.start), kind: 'beat' })
    out.push({ sample: secondsToSamples(b.start + b.duration), kind: 'beat' })
  }
  for (const c of input.clips ?? []) {
    if (input.exclude?.has(c.id)) continue
    out.push({ sample: c.start, kind: 'clip' }, { sample: clipEnd(c), kind: 'clip' })
  }
  if (input.playhead != null) out.push({ sample: input.playhead, kind: 'playhead' })
  return out.sort((a, b) => a.sample - b.sample)
}

export interface Snapped {
  sample: number
  /** The target it snapped to; null when nothing was close enough (or snapping was off). */
  target: SnapTarget | null
}

/**
 * `sample` moved to the nearest target within `thresholdPx` at this zoom; unchanged when none is that close or
 * `disabled` (Alt / Option held). On a tie the playhead wins, then a beat, then a clip edge. `targets` must be sorted
 * (snapTargets sorts them).
 */
export function snap(
  sample: number,
  targets: readonly SnapTarget[],
  pxPerSec: number,
  opts: { disabled?: boolean; thresholdPx?: number } = {},
): Snapped {
  if (opts.disabled || !targets.length) return { sample, target: null }
  const reach = ((opts.thresholdPx ?? SNAP_PX) / pxPerSec) * SAMPLE_RATE
  // The first target at or after `sample`; the nearest lies around it.
  let lo = 0
  let hi = targets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((targets[mid]?.sample ?? Infinity) < sample) lo = mid + 1
    else hi = mid
  }
  const rank: Record<SnapKind, number> = { playhead: 0, beat: 1, clip: 2 }
  let best: SnapTarget | null = null
  let bestD = Infinity
  for (const dir of [-1, 1]) {
    for (let i = dir < 0 ? lo - 1 : lo; i >= 0 && i < targets.length; i += dir) {
      const t = targets[i]
      if (!t) break
      const d = Math.abs(t.sample - sample)
      if (d > reach) break
      if (d < bestD || (d === bestD && best && rank[t.kind] < rank[best.kind])) {
        best = t
        bestD = d
      }
    }
  }
  return best ? { sample: best.sample, target: best } : { sample, target: null }
}

/**
 * Snaps a clip being moved: whichever of its two edges is nearer a target decides, and the clip keeps its length.
 * Returns the new start.
 */
export function snapMove(
  start: number,
  length: number,
  targets: readonly SnapTarget[],
  pxPerSec: number,
  opts: { disabled?: boolean; thresholdPx?: number } = {},
): Snapped {
  const head = snap(start, targets, pxPerSec, opts)
  const tail = snap(start + length, targets, pxPerSec, opts)
  const dHead = head.target ? Math.abs(head.sample - start) : Infinity
  const dTail = tail.target ? Math.abs(tail.sample - (start + length)) : Infinity
  if (dHead === Infinity && dTail === Infinity) return { sample: start, target: null }
  return dHead <= dTail ? head : { sample: tail.sample - length, target: tail.target }
}

/**
 * Where a file dropped on the Narration lane starts (§2.4): the composition sample under the pointer, `x` CSS px
 * into the lanes' content, snapped like a dragged edge (Alt / Option turns it off) and never before 0. The take's
 * length isn't known until it's decoded, so only its start snaps.
 */
export function dropSample(
  x: number,
  pxPerSec: number,
  targets: readonly SnapTarget[],
  opts: { disabled?: boolean } = {},
): number {
  const at = Math.max(0, Math.round((x / pxPerSec) * SAMPLE_RATE))
  return Math.max(0, snap(at, targets, pxPerSec, opts).sample)
}
