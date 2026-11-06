// The picture clock (picture.ts) driven by fakes: anchors, frame steps and skips, every stop rule, and the final fit.
import { describe, expect, it, vi } from 'vitest'
import { AudioClock, type ClockContext } from './audio-clock'
import type { StopKind } from './fit'
import { lookaheadAnchors, PictureClock, PictureMonitor, type Anchor } from './picture'

const FPS = 30
const FRAME_MS = 1000 / FPS

/** A context whose currentTime is perf − 500 ms, in 128-frame quanta at 48 kHz. */
function fakeContext(
  clock: { now: number },
  withOutput = true,
): ClockContext & EventTarget & { state: string } {
  const t = new EventTarget() as EventTarget & ClockContext & { state: string }
  Object.assign(t, {
    sampleRate: 48_000,
    baseLatency: 0.005,
    outputLatency: 0.02,
    state: 'running',
  })
  Object.defineProperty(t, 'currentTime', {
    get: () => Math.floor(((clock.now - 500) / 1000) * 375) / 375,
  })
  if (withOutput)
    t.getOutputTimestamp = () => ({ contextTime: (clock.now - 530) / 1000, performanceTime: clock.now })
  return t
}

class FakeVideo extends EventTarget {
  paused = false
  cb: ((now: number, md: VideoFrameCallbackMetadata) => void) | null = null
  requestVideoFrameCallback(cb: (now: number, md: VideoFrameCallbackMetadata) => void) {
    this.cb = cb
    return 1
  }
  cancelVideoFrameCallback() {
    this.cb = null
  }
}

function rig() {
  const time = { now: 0 }
  const ctx = fakeContext(time)
  const audio = new AudioClock(ctx, () => time.now)
  for (time.now = 600; time.now <= 1000; time.now += 5) audio.sample()
  const video = new FakeVideo()
  const doc: EventTarget & { visibilityState: DocumentVisibilityState } = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as const,
  })
  const mediaDevices = new EventTarget()
  const track = new EventTarget()
  const log = vi.fn()
  const clock = new PictureClock(video, {
    fps: FPS,
    audioClock: audio,
    context: ctx,
    doc,
    mediaDevices,
    track,
    now: () => time.now,
    log,
  }).start()
  // Take starts at perf 1000: context frame (1000 − 500) / 1000 · 48000.
  clock.beginTake({ startFrame: 24_000 })
  /**
   * Plays `n` frames from frame `from` via the rVFC callback; `shift` frames of picture offset from `stepAt` on.
   * `firefox` makes it look like Firefox's rVFC under a busy main thread (docs/spikes.md S10, Firefox): every fifth
   * callback is a lookahead, and every 25th two in a row, reporting a frame 8-11 frames ahead with presentedFrames
   * jumping by as many.
   */
  let jumped = 0
  const play = (
    from: number,
    n: number,
    o: { stepAt?: number; shift?: number; wobbleFrom?: number; lurchFrom?: number; firefox?: boolean } = {},
  ) => {
    for (let k = from; k < from + n; k++) {
      const e = 1000 + k * FRAME_MS
      time.now = e
      audio.sample()
      const shift = o.stepAt !== undefined && k >= o.stepAt ? (o.shift ?? -1) / FPS : 0
      const wobble = o.wobbleFrom !== undefined && k >= o.wobbleFrom ? 0.015 : 0
      // A picture that lurches 30-70 ms off, a different amount each frame: not a step, not steady.
      const lurch =
        o.lurchFrom !== undefined && k >= o.lurchFrom ? ([0.03, 0.07, 0.045, 0.06][k % 4] ?? 0) : 0
      const ahead = o.firefox && (k % 5 === 3 || k % 25 === 4) ? 8 + (k % 4) : 0
      jumped += ahead
      video.cb?.(e, {
        mediaTime: (k + ahead) / FPS + shift + wobble + lurch,
        expectedDisplayTime: e,
        presentedFrames: k + 1 + jumped,
        presentationTime: e,
        width: 0,
        height: 0,
      })
    }
  }
  return { time, ctx, audio, video, doc, mediaDevices, track, clock, play, log }
}

describe('PictureMonitor', () => {
  const anchor = (k: number, extra = 0): Anchor => ({
    mediaTime: k / FPS + extra,
    expectedDisplayTime: 1000 + k * FRAME_MS,
    now: 1000 + k * FRAME_MS,
    presentedFrames: k + 1,
  })

  it('reports a whole-frame step once, at the first stepped anchor, and re-references', () => {
    const m = new PictureMonitor({ fps: FPS })
    const events = Array.from({ length: 200 }, (_, k) => m.observe(anchor(k, k >= 120 ? -1 / FPS : 0))).flat()
    const steps = events.filter((e) => e.kind === 'step')
    expect(steps).toEqual([{ kind: 'step', frames: -1, index: 120, atPerf: 1000 + 120 * FRAME_MS }])
  })

  it('counts presentedFrames jumps as skipped frames', () => {
    const m = new PictureMonitor({ fps: FPS })
    m.observe(anchor(0))
    const ev = m.observe({ ...anchor(3), presentedFrames: 4 })
    expect(ev).toContainEqual({ kind: 'skip', frames: 2, index: 1 })
    expect(m.skipped).toBe(2)
  })

  it('a stall is no anchor for longer than stallMs while playing', () => {
    const m = new PictureMonitor({ stallMs: 300 })
    m.observe(anchor(0))
    expect(m.checkStall(1000 + 250, false)).toBeNull()
    expect(m.checkStall(1000 + 350, false)?.gapMs).toBe(350)
    expect(m.checkStall(1000 + 350, true)).toBeNull()
  })
})

describe('PictureClock', () => {
  it('collects anchors through requestVideoFrameCallback and fits a clean take as one segment', () => {
    const r = rig()
    r.play(0, 300)
    expect(r.clock.anchors).toHaveLength(300)
    r.clock.stop('user')
    const fit = r.clock.fitFor()
    expect(fit.stop?.kind).toBe('user')
    expect(fit.segments).toHaveLength(1)
    const s = fit.segments[0]!
    expect(s.residualMax).toBeLessThan(1)
    // Composition 0 was on screen at perf 1000 = take sample 0, within the quantized render map's bias (~1 ms).
    expect(Math.abs(s.a * 1000)).toBeLessThan(2)
    expect(fit.outputSource).toBe('getOutputTimestamp')
    expect(fit.cleanSamples).toBe(r.clock.stopReason?.atSample)
  })

  it('splits the fit at a picture frame step instead of stopping', () => {
    const r = rig()
    r.play(0, 600, { stepAt: 400 })
    expect(r.clock.stopReason).toBeNull()
    r.clock.stop('user')
    const fit = r.clock.fitFor()
    expect(fit.segments).toHaveLength(2)
    expect(fit.steps[0]?.frames).toBe(-1)
    expect(Math.abs(fit.segments[1]!.fromSample - 400 * FRAME_MS * 24)).toBeLessThan(48)
    expect(r.log).toHaveBeenCalledWith('clock.picture-step', expect.objectContaining({ frames: -1 }))
  })

  const events: [StopKind, (r: ReturnType<typeof rig>) => void][] = [
    ['seek', (r) => r.video.dispatchEvent(new Event('seeking'))],
    ['stall', (r) => r.video.dispatchEvent(new Event('waiting'))],
    ['ended', (r) => r.video.dispatchEvent(new Event('ended'))],
    [
      'hidden',
      (r) => {
        r.doc.visibilityState = 'hidden'
        r.doc.dispatchEvent(new Event('visibilitychange'))
      },
    ],
    ['devicechange', (r) => r.mediaDevices.dispatchEvent(new Event('devicechange'))],
    ['track-ended', (r) => r.track.dispatchEvent(new Event('ended'))],
    [
      'context-interrupted',
      (r) => {
        r.ctx.state = 'interrupted'
        r.ctx.dispatchEvent(new Event('statechange'))
      },
    ],
    [
      'stall',
      (r) => {
        r.time.now += 400
        r.clock.tick()
      },
    ],
  ]
  for (const [kind, fire] of events) {
    it(`stops on ${kind} and keeps the clean part`, () => {
      const r = rig()
      const heard = vi.fn()
      r.clock.onStop(heard)
      r.play(0, 90)
      fire(r)
      expect(heard).toHaveBeenCalledTimes(1)
      expect(r.clock.stopReason?.kind).toBe(kind)
      // Stopped at about 3 s: the clean part is the samples up to then.
      expect(r.clock.stopReason?.atSample).toBeGreaterThan(2.9 * 24_000)
      expect(r.clock.fitFor().cleanSamples).toBe(r.clock.stopReason?.atSample)
      // Listeners are detached: later events don't change the reason or call again.
      r.video.dispatchEvent(new Event('seeking'))
      r.play(90, 10)
      expect(heard).toHaveBeenCalledTimes(1)
      expect(r.clock.anchors).toHaveLength(90)
    })
  }

  it('does not stop on a context that was never running going to suspended', () => {
    const r = rig()
    r.ctx.state = 'suspended'
    const c = new PictureClock(r.video, { context: r.ctx }).start()
    r.ctx.dispatchEvent(new Event('statechange'))
    expect(c.stopReason).toBeNull()
  })

  it('a steady 15 ms shift re-anchors the fit instead of stopping the take', () => {
    const r = rig()
    r.play(0, 400, { wobbleFrom: 300 })
    expect(r.clock.stopReason).toBeNull()
    r.clock.stop('user')
    const fit = r.clock.fitFor()
    expect(fit.reanchors).toHaveLength(1)
    expect(fit.reanchors[0]!.offsetMs).toBeCloseTo(15, 0)
    for (const s of fit.segments) expect(s.residualMax).toBeLessThan(1)
  })

  it('stops on a residual breach that is not a frame step, at the first breaching anchor', () => {
    const r = rig()
    r.play(0, 400, { lurchFrom: 300 })
    expect(r.clock.stopReason?.kind).toBe('residual')
    expect(Math.abs(r.clock.stopReason!.atSample! - 300 * FRAME_MS * 24)).toBeLessThan(48)
    // The final refit (final clock maps) finds the same breach, to within a few samples.
    const clean = r.clock.fitFor().cleanSamples
    expect(Number.isInteger(clean)).toBe(true)
    expect(Math.abs(clean - r.clock.stopReason!.atSample!)).toBeLessThan(5)
  })

  it('stops on slope beyond tolerance', () => {
    const r = rig()
    // A picture running 0.2% fast against the audio clock.
    for (let k = 0; k < 400; k++) {
      const e = 1000 + k * FRAME_MS
      r.time.now = e
      r.clock.observe({
        mediaTime: (k / FPS) * 1.002,
        expectedDisplayTime: e,
        now: e,
        presentedFrames: k + 1,
      })
    }
    expect(r.clock.stopReason?.kind).toBe('slope')
  })

  it('fits anchors collected before beginTake', () => {
    const r = rig()
    const c = new PictureClock(r.video, { fps: FPS, audioClock: r.audio, now: () => r.time.now }).start()
    r.play(0, 120)
    c.beginTake({ startFrame: 24_000 })
    c.stop('user')
    // Anchor 0 maps a few samples before the take's first sample (the render map's bias) and is left out.
    expect(c.fitFor().segments[0]?.n).toBeGreaterThanOrEqual(119)
  })

  describe('Firefox lookahead anchors (docs/spikes.md S10, Firefox)', () => {
    it('are dropped: the take runs on, one clean segment, nothing in the fit is a lookahead', () => {
      const r = rig()
      // Before the fix: anchors 60-62 breached a line the warm-up lookaheads had skewed, and the take stopped
      // ('residual', worst 157 ms) about 2 s in.
      r.play(0, 600, { firefox: true })
      expect(r.clock.stopReason).toBeNull()
      expect(r.clock.lookaheads).toBe(144)
      // The picture monitor saw only the steady anchors: no breaks or steps.
      expect(r.clock.monitor.steps).toEqual([])
      r.clock.stop('user')
      expect(r.clock.anchors).toHaveLength(600)
      const fit = r.clock.fitFor()
      expect(fit.lookaheads).toBe(144)
      // 600 − 144 lookaheads, less anchor 0 when it maps just before the take's first sample (the render map's bias).
      expect(fit.segments[0]!.n).toBeGreaterThanOrEqual(455)
      expect(fit.segments[0]!.n).toBeLessThanOrEqual(456)
      expect(fit.outliers).toBe(0)
      expect(fit.segments).toHaveLength(1)
      expect(fit.segments[0]!.residualMax).toBeLessThan(1)
      expect(Math.abs(fit.segments[0]!.a * 1000)).toBeLessThan(2)
      expect(Math.abs(fit.slopePpm!)).toBeLessThan(100)
      expect(r.log).toHaveBeenCalledWith('clock.lookahead', expect.objectContaining({ count: 1 }))
    })

    it('a real drift still stops the take at its first anchor', () => {
      const r = rig()
      r.play(0, 400, { firefox: true, lurchFrom: 302 })
      expect(r.clock.stopReason?.kind).toBe('residual')
      expect(Math.abs(r.clock.stopReason!.atSample! - 302 * FRAME_MS * 24)).toBeLessThan(48)
    })

    it('a one-frame picture step still splits the fit instead of stopping', () => {
      const r = rig()
      r.play(0, 600, { firefox: true, stepAt: 402 })
      expect(r.clock.stopReason).toBeNull()
      r.clock.stop('user')
      const fit = r.clock.fitFor()
      expect(fit.segments).toHaveLength(2)
      expect(fit.steps[0]?.frames).toBe(-1)
      for (const s of fit.segments) expect(s.residualMax).toBeLessThan(1)
    })

    it('lookaheadAnchors finds one and two in a row, and nothing on a steady picture', () => {
      const at = (ms: number[]) =>
        ms.map((m, k) => ({ mediaTime: m / 1000, expectedDisplayTime: k, now: k, presentedFrames: k }))
      expect([...lookaheadAnchors(at([0, 33, 333, 67, 100, 433, 467, 133, 167]))]).toEqual([2, 5, 6])
      expect(lookaheadAnchors(at([0, 33, 67, 67, 100])).size).toBe(0)
    })

    it('a seek backwards is not a lookahead: it stops the take', () => {
      const r = rig()
      r.play(0, 120, { firefox: true })
      r.video.dispatchEvent(new Event('seeking'))
      expect(r.clock.stopReason?.kind).toBe('seek')
    })
  })
})
