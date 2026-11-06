// Monitor scheduling (monitor-schedule.ts): start from the median of ~10 anchors, then resync on drift or period.
import { describe, expect, it } from 'vitest'
import {
  MonitorSync,
  monitorError,
  pictureOffsetFrom,
  planMonitorStart,
  type OutputMap,
} from './monitor-schedule'
import type { Anchor } from './picture'

const FRAME_MS = 1000 / 30
/** Context time ct is heard at perf 530 + 1000·ct (optionally drifting `ppm`). */
const out = (ppm = 0): OutputMap => ({
  outputContextToPerf: (ct) => 530 + 1000 * ct * (1 + ppm * 1e-6),
  perfToOutputContext: (p) => (p - 530) / (1000 * (1 + ppm * 1e-6)),
})
/** Frame k is on screen at perf 1000 + k·frame; the first `late` frames are presented `lateMs` late. */
const anchors = (n: number, late = 0, lateMs = 0): Anchor[] =>
  Array.from({ length: n }, (_, k) => {
    const e = 1000 + k * FRAME_MS + (k < late ? lateMs : 0)
    return { mediaTime: k / 30, expectedDisplayTime: e, now: e, presentedFrames: k + 1 }
  })

describe('monitor schedule', () => {
  it('needs 10 anchors and takes their median, so a few late first frames do not bias it', () => {
    expect(pictureOffsetFrom(anchors(9))).toBeNull()
    const a = anchors(10, 3, 29)
    expect(pictureOffsetFrom(a)! * 1000).toBeCloseTo(-1000, 6)
    // The first anchor alone would be 29 ms off.
    expect((a[0]!.mediaTime - a[0]!.expectedDisplayTime / 1000) * 1000).toBeCloseTo(-1029, 6)
  })

  it('plans a start lead seconds ahead, at what will be on screen when it is heard', () => {
    const plan = planMonitorStart(anchors(12), out(), 1.0)!
    expect(plan.when).toBeCloseTo(1.25, 12)
    // Heard at perf 1780 → composition 0.78 s.
    expect(plan.offset).toBeCloseTo(0.78, 9)
    expect(monitorError(plan, anchors(60)[59]!, out())).toBeCloseTo(0, 6)
  })

  it('asks for a resync when the median drift passes 5 ms, not on one late frame', () => {
    const sync = new MonitorSync()
    const o = out(33)
    const plan = planMonitorStart(anchors(10), o, 0.5)!
    sync.started(plan, 1000)
    let first: number | null = null
    let late = false
    for (let k = 10; k < 30 * 600; k++) {
      const e = 1000 + k * FRAME_MS
      const a: Anchor = {
        mediaTime: k / 30,
        expectedDisplayTime: e + (k === 40 ? 30 : 0),
        now: e,
        presentedFrames: k,
      }
      const c = sync.observe(a, o)!
      if (k === 40) late = c.resync
      if (c.resync && c.why === 'drift') {
        first = (e - 1000) / 1000
        break
      }
    }
    expect(late).toBe(false)
    // 33 ppm reaches 5 ms after about 150 s.
    expect(first).toBeGreaterThan(140)
    expect(first).toBeLessThan(160)
  })

  it('resyncs on the 2 s period only when it has drifted at least 1 ms', () => {
    const sync = new MonitorSync()
    const steady = out()
    sync.started(planMonitorStart(anchors(10), steady, 0.5)!, 1000)
    const run = (o: OutputMap) => {
      for (let k = 10; k < 200; k++) {
        const e = 1000 + k * FRAME_MS
        const c = sync.observe({ mediaTime: k / 30, expectedDisplayTime: e, now: e, presentedFrames: k }, o)!
        if (c.resync) return c.why
      }
      return null
    }
    expect(run(steady)).toBeNull()
    // Now 1.5 ms off (a constant shift): the period resync catches it.
    const shifted: OutputMap = {
      outputContextToPerf: (ct) => steady.outputContextToPerf(ct) - 1.5,
      perfToOutputContext: (p) => steady.perfToOutputContext(p + 1.5),
    }
    sync.started(planMonitorStart(anchors(10), steady, 0.5)!, 1000)
    expect(run(shifted)).toBe('period')
    expect(sync.resyncs).toBe(1)
  })
})
