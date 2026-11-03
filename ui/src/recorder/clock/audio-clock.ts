// AudioContext time <-> performance.now() (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, docs/spikes.md
// S10). Two maps, both fitted lines on this document's performance.now():
//
//   render  (currentTime, perf) at the first sight of each new currentTime: when the audio thread rendered or
//           captured context time ct. Mic samples go through THIS map (the worklet's block frames are context frames).
//   output  getOutputTimestamp() (contextTime, performanceTime): when context time ct is HEARD. The monitor is
//           scheduled through this map. It already includes the output latency, so outputLatency is never added on
//           top. Where getOutputTimestamp is missing (or hasn't produced live values yet) the output map is the render
//           map plus baseLatency + outputLatency, and `outputSource` says so.
//
// S10 measured the render map at 1.5 ms RMS and getOutputTimestamp's implied output latency at 30.2 ms against a
// reported 32.3 ms in headless Chromium. Sampling is driven from outside (rVFC, rAF, a 5 ms timer): `start()` does
// the timers, `sample()` can be called from any callback that wants a fresh pair.
import { OnlineLine, type Line } from './fit'

/** The parts of an AudioContext the clock reads, so tests can drive it with a fake. */
export interface ClockContext {
  readonly currentTime: number
  readonly sampleRate: number
  readonly baseLatency?: number
  readonly outputLatency?: number
  getOutputTimestamp?: () => AudioTimestamp
}

export type OutputSource = 'getOutputTimestamp' | 'fallback-latency'

/** Pairs a map needs before its own fit is used (the output map falls back until then). */
const MIN_OUTPUT_PAIRS = 20

export class AudioClock {
  private render = new OnlineLine()
  private out = new OnlineLine()
  private lastCt = -1
  private lastOutCt = -1
  private timer: ReturnType<typeof setInterval> | null = null
  private raf = 0
  /** Whether this context has getOutputTimestamp at all (feature-detected once). */
  readonly hasOutputTimestamp: boolean

  constructor(
    readonly ctx: ClockContext,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.hasOutputTimestamp = typeof ctx.getOutputTimestamp === 'function'
  }

  /** Samples every 5 ms and every animation frame until `stop()`. */
  start(): this {
    if (this.timer) return this
    this.timer = setInterval(() => this.sample(), 5)
    if (typeof requestAnimationFrame === 'function') {
      const loop = () => {
        this.sample()
        this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
    }
    return this
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Forgets both maps (a new take on the same context starts clean). */
  reset(): void {
    this.render = new OnlineLine()
    this.out = new OnlineLine()
    this.lastCt = -1
    this.lastOutCt = -1
  }

  sample(at: number = this.now()): void {
    const ct = this.ctx.currentTime
    if (ct !== this.lastCt && ct > 0) {
      this.lastCt = ct
      this.render.add(ct, at)
    }
    if (!this.hasOutputTimestamp) return
    const ts = this.ctx.getOutputTimestamp?.()
    const oct = ts?.contextTime
    const opt = ts?.performanceTime
    // Before output starts both are 0; a repeated contextTime is the same pair again.
    if (oct && opt && opt > 0 && oct !== this.lastOutCt) {
      this.lastOutCt = oct
      this.out.add(oct, opt)
    }
  }

  get renderPairs(): number {
    return this.render.count
  }

  get outputSource(): OutputSource {
    return this.out.count > MIN_OUTPUT_PAIRS ? 'getOutputTimestamp' : 'fallback-latency'
  }

  /** perf ms = a + b·contextSeconds for the render map; before any pairs, the instantaneous offset. */
  renderLine(): Line {
    return this.render.line() ?? { a: this.now() - this.ctx.currentTime * 1000, b: 1000, n: 0 }
  }

  /** The output map: getOutputTimestamp's fit, else render + baseLatency + outputLatency (labelled fallback). */
  outputLine(): Line {
    const o = this.out.line()
    if (o && this.out.count > MIN_OUTPUT_PAIRS) return o
    const r = this.renderLine()
    return { a: r.a + this.fallbackLatencyMs(), b: r.b, n: 0 }
  }

  /** The latency the fallback adds, in ms: only ever used without getOutputTimestamp's own pairs. */
  fallbackLatencyMs(): number {
    return ((this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)) * 1000
  }

  /** When context time `ct` (s) was rendered/captured, on performance.now(). */
  contextToPerf(ct: number): number {
    const l = this.renderLine()
    return l.a + l.b * ct
  }

  perfToContext(perf: number): number {
    const l = this.renderLine()
    return (perf - l.a) / l.b
  }

  /** When context time `ct` (s) is heard, on performance.now(). */
  outputContextToPerf(ct: number): number {
    const l = this.outputLine()
    return l.a + l.b * ct
  }

  /** The context time being heard at `perf`. */
  perfToOutputContext(perf: number): number {
    const l = this.outputLine()
    return (perf - l.a) / l.b
  }

  /** performance.now() of context frame `frame` (a worklet block's currentFrame plus an offset). */
  frameToPerf(frame: number): number {
    return this.contextToPerf(frame / this.ctx.sampleRate)
  }

  /**
   * Take sample (at `outRate`) captured at `perf`, for a take whose first captured context frame is `startFrame`:
   * the x of every picture anchor in the fit.
   */
  perfToTakeSample(perf: number, startFrame: number, outRate: number): number {
    return (this.perfToContext(perf) * this.ctx.sampleRate - startFrame) * (outRate / this.ctx.sampleRate)
  }
}
