// The take's piecewise sync fit (fit.ts) on synthetic anchors: slope, jitter, one-frame steps, re-anchoring on a steady
// offset, residual and slope stops.
import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE } from '../../../../src/lib/timeline'
import {
  fitLine,
  fitPiecewise,
  median,
  residuals,
  robustMedian,
  slopePpm,
  SyncFitter,
  wholeFrameStep,
  type SyncPoint,
} from './fit'

/** Deterministic uniform noise in [-1, 1). */
function rng(seed = 1) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 2 ** 32) * 2 - 1
  }
}

const FPS = 30

/**
 * Anchors for a take: frame k (composition k/FPS + t0) is on screen at take sample x, with the picture clock running
 * `ppm` fast against the audio, `jitterMs` of uniform noise on the display time and the composition shifted by
 * `steps[i].frames` from anchor `steps[i].at` on.
 */
function take(o: {
  seconds: number
  ppm?: number
  jitterMs?: number
  t0?: number
  steps?: { at: number; frames: number }[]
}) {
  const r = rng(7)
  const b = (1 + (o.ppm ?? 0) * 1e-6) / SAMPLE_RATE
  const t0 = o.t0 ?? 0.4
  const pts: SyncPoint[] = []
  for (let k = 0; k < o.seconds * FPS; k++) {
    const shift = (o.steps ?? []).filter((s) => k >= s.at).reduce((n, s) => n + s.frames, 0)
    const time = t0 + k / FPS
    const x = k / FPS / b + r() * ((o.jitterMs ?? 0) / 1000) * SAMPLE_RATE
    pts.push({ sample: x, time: time + shift / FPS })
  }
  return { pts, a: t0, b }
}

describe('line fit', () => {
  it('recovers slope and intercept from 10 minutes of samples without losing precision', () => {
    const { pts, a, b } = take({ seconds: 600, ppm: 33 })
    const l = fitLine(
      pts.map((p) => p.sample),
      pts.map((p) => p.time),
    )!
    expect(l.a).toBeCloseTo(a, 9)
    expect(slopePpm(l.b)).toBeCloseTo(33, 3)
    expect(l.b).toBeCloseTo(b, 15)
  })

  it('reports RMS and max residual', () => {
    const r = residuals({ a: 0, b: 1, n: 2 }, [0, 1, 2], [0, 1.5, 2])
    expect(r.max).toBe(0.5)
    expect(r.argmax).toBe(1)
    expect(r.rms).toBeCloseTo(Math.sqrt(0.25 / 3), 12)
  })

  it('robust median drops outliers beyond 3 MADs', () => {
    const r = robustMedian([40, 42, 41, 39, 43, 40, 200, -90], 5)
    expect(r.dropped.sort((p, q) => p - q)).toEqual([-90, 200])
    expect(r.median).toBe(median([40, 42, 41, 39, 43, 40]))
  })

  it('a run is a whole-frame step only when every residual sits at the same frame count', () => {
    expect(wholeFrameStep([-33, -34, -32.5], 1000 / 30, 4)).toBe(-1)
    expect(wholeFrameStep([66, 67, 65], 1000 / 30, 4)).toBe(2)
    expect(wholeFrameStep([-33, -20, -33], 1000 / 30, 4)).toBeNull()
    expect(wholeFrameStep([12, 13, 14], 1000 / 30, 4)).toBeNull()
  })
})

describe('piecewise fit', () => {
  it('a clean take with drift and jitter is one segment over the whole take, no stop', () => {
    const { pts, a } = take({ seconds: 120, ppm: 33, jitterMs: 2 })
    const end = Math.ceil(pts.at(-1)!.sample)
    const f = fitPiecewise(pts, end)
    expect(f.stop).toBeNull()
    expect(f.segments).toHaveLength(1)
    const s = f.segments[0]!
    expect(s.fromSample).toBe(0)
    expect(s.toSample).toBe(end)
    expect(s.a).toBeCloseTo(a, 3)
    expect(slopePpm(s.b)).toBeGreaterThan(20)
    expect(slopePpm(s.b)).toBeLessThan(46)
    expect(s.residualRms).toBeLessThan(1.5)
    expect(s.residualMax).toBeLessThan(2.1)
    expect(f.cleanSamples).toBe(end)
  })

  it('splits at each injected one-frame step and fits each piece flat', () => {
    const { pts } = take({
      seconds: 600,
      ppm: 33,
      jitterMs: 1,
      steps: [
        { at: 388 * FPS, frames: -1 },
        { at: 496 * FPS, frames: -1 },
      ],
    })
    const end = Math.ceil(pts.at(-1)!.sample)
    const f = fitPiecewise(pts, end)
    expect(f.stop).toBeNull()
    expect(f.steps.map((s) => s.frames)).toEqual([-1, -1])
    expect(f.segments).toHaveLength(3)
    const [s0, s1, s2] = f.segments as [any, any, any]
    expect(s0.toSample).toBe(s1.fromSample)
    expect(s1.toSample).toBe(s2.fromSample)
    expect(s1.fromSample).toBeCloseTo(pts[388 * FPS]!.sample, 6)
    expect(s2.fromSample).toBeCloseTo(pts[496 * FPS]!.sample, 6)
    for (const s of f.segments) expect(s.residualMax).toBeLessThan(1.5)
    // Each step moves the intercept back one frame; a single line across them would have ~9 ms RMS (S10).
    expect((s1.a - s0.a) * 1000).toBeCloseTo(-1000 / FPS, 0)
    expect((s2.a - s1.a) * 1000).toBeCloseTo(-1000 / FPS, 0)
    const one = fitLine(
      pts.map((p) => p.sample),
      pts.map((p) => p.time),
    )!
    expect(
      residuals(
        one,
        pts.map((p) => p.sample),
        pts.map((p) => p.time),
      ).rms * 1000,
    ).toBeGreaterThan(8)
  })

  it('a single late frame is an outlier, not a step or a stop, and is left out of the fit', () => {
    const { pts } = take({ seconds: 30 })
    pts[300] = { ...pts[300]!, time: pts[300]!.time - 1 / FPS }
    const f = fitPiecewise(pts, Math.ceil(pts.at(-1)!.sample))
    expect(f.stop).toBeNull()
    expect(f.outliers).toBe(1)
    expect(f.segments).toHaveLength(1)
    expect(f.segments[0]!.residualMax).toBeLessThan(0.01)
  })

  it('stops on residual: a breach that scatters (not a frame step, not steady) keeps the clean part', () => {
    const { pts } = take({ seconds: 30 })
    // From anchor 450 on, the picture lurches 30-70 ms off, a different amount each frame.
    const lurch = [0.03, 0.07, 0.045, 0.06]
    const bad = pts.map((p, i) => (i >= 450 ? { ...p, time: p.time + (lurch[i % 4] ?? 0) } : p))
    const f = fitPiecewise(bad, Math.ceil(bad.at(-1)!.sample))
    expect(f.stop?.kind).toBe('residual')
    expect(f.stop?.atSample).toBeCloseTo(bad[450]!.sample, 6)
    expect(f.cleanSamples).toBe(Math.floor(bad[450]!.sample))
    expect(f.segments.at(-1)!.toSample).toBe(f.cleanSamples)
  })

  it('a steady offset that is not a whole frame re-anchors instead of stopping', () => {
    const { pts } = take({ seconds: 30, jitterMs: 1 })
    // From anchor 450 on, everything sits 25 ms later (a latency change): not a frame (33.3 ms), but steady.
    const moved = pts.map((p, i) => (i >= 450 ? { ...p, time: p.time + 0.025 } : p))
    const f = fitPiecewise(moved, Math.ceil(moved.at(-1)!.sample))
    expect(f.stop).toBeNull()
    expect(f.reanchors).toHaveLength(1)
    expect(f.reanchors[0]!.atSample).toBeCloseTo(moved[450]!.sample, 6)
    expect(f.reanchors[0]!.offsetMs).toBeCloseTo(25, 0)
    expect(f.segments).toHaveLength(2)
    expect(f.cleanSamples).toBe(Math.ceil(moved.at(-1)!.sample))
    for (const seg of f.segments) expect(seg.residualMax).toBeLessThan(2)
  })

  it('a steady offset beyond the re-anchor limit still stops', () => {
    const { pts } = take({ seconds: 30 })
    // 150 ms (4.5 frames): too large to be jitter or a latency change.
    const far = pts.map((p, i) => (i >= 450 ? { ...p, time: p.time + 0.15 } : p))
    expect(fitPiecewise(far, Math.ceil(far.at(-1)!.sample)).stop?.kind).toBe('residual')
  })

  it('jitter of up to one 60 Hz display interval stays in the fit (the 20 ms limit)', () => {
    const { pts } = take({ seconds: 30, jitterMs: 1 })
    // Every third frame presented one vsync (16.7 ms) late, as a 60 Hz screen does with a 30 fps video.
    const vsync = pts.map((p, i) => (i % 3 === 0 && i > 0 ? { ...p, time: p.time - 0.0167 } : p))
    const f = fitPiecewise(vsync, Math.ceil(vsync.at(-1)!.sample))
    expect(f.stop).toBeNull()
    expect(f.cleanSamples).toBe(Math.ceil(vsync.at(-1)!.sample))
  })

  it('stops on slope beyond tolerance', () => {
    const { pts } = take({ seconds: 30, ppm: 2500 })
    const f = fitPiecewise(pts, Math.ceil(pts.at(-1)!.sample), { slopeTolerancePpm: 1000 })
    expect(f.stop?.kind).toBe('slope')
    expect(f.stop?.detail).toMatch(/2500 ppm/)
    // The slope is checked once the segment has slopeWarmup (300) anchors: the 300th.
    expect(f.stop?.atSample).toBeCloseTo(pts[299]!.sample, 6)
  })

  it('residuals are not checked during warm-up', () => {
    const f = new SyncFitter()
    const { pts } = take({ seconds: 2 })
    for (const [i, p] of pts.slice(0, 59).entries()) {
      const ev = f.push(i === 30 ? { ...p, time: p.time + 0.2 } : p)
      expect(ev.type).toBe('ok')
    }
  })

  it('a young segment after a step keeps the previous slope until it has its own', () => {
    const { pts } = take({ seconds: 20, ppm: 500, steps: [{ at: 400, frames: 1 }] })
    const f = new SyncFitter()
    const events = pts.slice(0, 410).map((p) => f.push(p))
    expect(events.filter((e) => e.type === 'step')).toHaveLength(1)
    expect(slopePpm(f.currentLine()!.b)).toBeCloseTo(500, 0)
  })

  it('an explicit split (a picture step) starts a segment and moves later anchors into it', () => {
    const { pts } = take({ seconds: 10 })
    const f = new SyncFitter()
    for (const p of pts.slice(0, 200)) f.push(p)
    f.split(pts[150]!.sample)
    for (const p of pts.slice(200)) f.push(p)
    const segs = f.segments(Math.ceil(pts.at(-1)!.sample))
    expect(segs).toHaveLength(2)
    expect(segs[1]!.fromSample).toBe(pts[150]!.sample)
    expect(segs[0]!.n + segs[1]!.n).toBe(pts.length)
  })

  // Warm-up anchors go into the fit unchecked. Firefox's rVFC (docs/spikes.md S10, Firefox) reports a frame 8-12
  // frames ahead in up to one callback in five; the picture clock drops those (lookaheadAnchors), but before it did, 12
  // of the first 60 skewed the warm-up line by ~77 ms and the first checked anchors stopped the take ('residual', worst
  // 157 ms). The warm-up is now trimmed against its median offset, so stray anchors there can't do that.
  const strays = (pts: SyncPoint[], until = 60) =>
    pts.map((p, i) => (i < until && i % 5 === 3 ? { ...p, time: p.time + (7 + (i % 4)) / FPS } : p))

  it('stray anchors in the warm-up are trimmed: no stop, one clean segment', () => {
    const { pts, a } = take({ seconds: 30, ppm: 64, jitterMs: 1 })
    const ff = strays(pts)
    const f = fitPiecewise(ff, Math.ceil(ff.at(-1)!.sample))
    expect(f.stop).toBeNull()
    expect(f.steps).toEqual([])
    expect(f.segments).toHaveLength(1)
    expect(f.outliers).toBe(12)
    expect(f.segments[0]!.n).toBe(pts.length - 12)
    expect(f.segments[0]!.residualMax).toBeLessThan(1.5)
    expect(f.segments[0]!.a).toBeCloseTo(a, 3)
    expect(Math.abs(slopePpm(f.segments[0]!.b) - 64)).toBeLessThan(30)
  })

  it('after a trimmed warm-up, a real drift still stops and a one-frame step still splits', () => {
    const { pts } = take({ seconds: 30, jitterMs: 1 })
    const lurch = [0.03, 0.07, 0.045, 0.06]
    const bad = strays(pts).map((p, i) => (i >= 450 ? { ...p, time: p.time + (lurch[i % 4] ?? 0) } : p))
    const f = fitPiecewise(bad, Math.ceil(bad.at(-1)!.sample))
    expect(f.stop?.kind).toBe('residual')
    expect(f.stop?.atSample).toBeCloseTo(bad[450]!.sample, 6)
    const stepped = take({ seconds: 30, jitterMs: 1, steps: [{ at: 450, frames: -1 }] }).pts
    const g = fitPiecewise(strays(stepped), Math.ceil(stepped.at(-1)!.sample))
    expect(g.stop).toBeNull()
    expect(g.steps.map((s) => s.frames)).toEqual([-1])
    const fast = take({ seconds: 30, ppm: 2500 }).pts
    expect(fitPiecewise(strays(fast), Math.ceil(fast.at(-1)!.sample)).stop?.kind).toBe('slope')
  })

  it('the warm-up trim keeps a clean take whole', () => {
    const { pts } = take({ seconds: 10, ppm: 900, jitterMs: 2 })
    const f = fitPiecewise(pts, Math.ceil(pts.at(-1)!.sample))
    expect(f.stop).toBeNull()
    expect(f.outliers).toBe(0)
    expect(f.segments[0]!.n).toBe(pts.length)
  })
})
