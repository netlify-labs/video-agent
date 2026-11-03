// The picture clock (picture.ts) driven by fakes: anchors, frame steps and skips, every stop rule, and the final fit.
import { describe, expect, it, vi } from 'vitest'
import { AudioClock, type ClockContext } from './audio-clock'
import type { StopKind } from './fit'
import { PictureClock, PictureMonitor, type Anchor } from './picture'

const FPS = 30
const FRAME_MS = 1000 / FPS

/** A context whose currentTime is perf − 500 ms, in 128-frame quanta at 48 kHz. */
function fakeContext(clock: { now: number }, withOutput = true): ClockContext & EventTarget & { state: string } {
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
  /** Plays `n` frames from frame `from` via the rVFC callback; `shift` frames of picture offset from `stepAt` on. */
  const play = (from: number, n: number, o: { stepAt?: number; shift?: number; wobbleFrom?: number } = {}) => {
    for (let k = from; k < from + n; k++) {
      const e = 1000 + k * FRAME_MS
      time.now = e
      audio.sample()
      const shift = o.stepAt !== undefined && k >= o.stepAt ? (o.shift ?? -1) / FPS : 0
      const wobble = o.wobbleFrom !== undefined && k >= o.wobbleFrom ? 0.015 : 0
      video.cb?.(e, {
        mediaTime: k / FPS + shift + wobble,
        expectedDisplayTime: e,
        presentedFrames: k + 1,
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

  it('stops on a residual breach that is not a frame step, at the first breaching anchor', () => {
    const r = rig()
    r.play(0, 400, { wobbleFrom: 300 })
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
      r.clock.observe({ mediaTime: (k / FPS) * 1.002, expectedDisplayTime: e, now: e, presentedFrames: k + 1 })
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
})
