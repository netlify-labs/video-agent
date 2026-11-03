import { describe, expect, it } from 'vitest'
import { IDENTITY_FIT, SAMPLE_RATE, type NarrationClip } from '../../../src/lib/timeline'
import { snap, SNAP_PX, snapMove, snapTargets } from './timeline-snap'

const S = SAMPLE_RATE
const clip = (id: string, start: number, len: number): NarrationClip => ({
  id,
  mediaId: 'm',
  srcStart: 0,
  srcEnd: len,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
})

describe('snap targets', () => {
  it('collects beat edges, other clip edges and the playhead, sorted', () => {
    const t = snapTargets({
      beats: [
        { start: 0, duration: 2 },
        { start: 2, duration: 3 },
      ],
      clips: [clip('a', 1 * S, S), clip('b', 6 * S, S)],
      playhead: 4.5 * S,
      exclude: new Set(['b']),
    })
    expect(t.map((x) => [x.sample / S, x.kind])).toEqual([
      [0, 'beat'],
      [1, 'clip'],
      [2, 'beat'],
      [2, 'beat'],
      [2, 'clip'],
      [4.5, 'playhead'],
      [5, 'beat'],
    ])
  })
})

describe('snap', () => {
  const targets = snapTargets({ beats: [{ start: 10, duration: 10 }], playhead: 15 * S })
  // At 100 px/s, 8 px is 80 ms.
  const pps = 100

  it('snaps within the pixel threshold at this zoom', () => {
    expect(snap(10.05 * S, targets, pps)).toEqual({
      sample: 10 * S,
      target: { sample: 10 * S, kind: 'beat' },
    })
    expect(snap(9.95 * S, targets, pps).sample).toBe(10 * S)
    expect(snap(10.1 * S, targets, pps)).toEqual({ sample: 10.1 * S, target: null })
  })

  it('reaches further in seconds when zoomed out', () => {
    expect(snap(10.5 * S, targets, 10).sample).toBe(10 * S)
    expect(snap(10.5 * S, targets, 1000).sample).toBe(10.5 * S)
  })

  it('turns off with Alt / Option', () => {
    expect(snap(10.01 * S, targets, pps, { disabled: true })).toEqual({ sample: 10.01 * S, target: null })
  })

  it('takes the nearest target, and the playhead on a tie', () => {
    const t = snapTargets({ beats: [{ start: 1, duration: 1 }], playhead: 1 * S + 100 })
    expect(snap(1 * S + 40, t, pps).target?.kind).toBe('beat')
    expect(snap(1 * S + 60, t, pps).target?.kind).toBe('playhead')
    const tie = snapTargets({ beats: [{ start: 1, duration: 1 }], playhead: 1 * S })
    expect(snap(1 * S + 10, tie, pps).target?.kind).toBe('playhead')
  })

  it('handles no targets and a custom threshold', () => {
    expect(snap(5, [], pps)).toEqual({ sample: 5, target: null })
    expect(snap(10.15 * S, targets, pps, { thresholdPx: SNAP_PX * 2 }).sample).toBe(10 * S)
  })

  it('moves a clip by whichever edge is nearer a target, keeping its length', () => {
    // A 2 s clip whose end lands 30 ms before the 20 s beat edge and whose start is far from anything.
    const m = snapMove(17.97 * S, 2 * S, targets, pps)
    expect(m.sample).toBe(18 * S)
    expect(m.target?.sample).toBe(20 * S)
    expect(snapMove(9.99 * S, 2 * S, targets, pps).sample).toBe(10 * S)
    expect(snapMove(3 * S, 2 * S, targets, pps)).toEqual({ sample: 3 * S, target: null })
  })
})
