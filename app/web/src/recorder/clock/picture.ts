// The picture clock (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, docs/spikes.md S10): while armed, the
// editor plays the base version's MP4 in a parent-document <video muted>, and requestVideoFrameCallback gives
// (mediaTime, expectedDisplayTime, presentedFrames) for every presented frame on this document's performance.now().
//
// PictureMonitor (pure) watches the anchors on their own clock: the offset mediaTime − expectedDisplayTime should
// hold still (it follows slow drift through a running median). It reports presentedFrames jumps (frames presented
// without a callback), whole-frame steps (S10's one-frame picture loss at 388-496 s of 10-minute takes) and stalls
// (no anchor for `stallMs` while playing).
//
// PictureClock attaches it to a real <video>, an AudioClock and the take's mic track, and runs the take's stop
// rules: seek, stall, hidden tab, devicechange, mic track ended, context interrupted, and the fit's residual and
// slope rules (fit.ts). A picture step splits the fit there. `fitFor()` is the final piecewise fit with the final
// clock maps. Everything the DOM provides comes in through small interfaces, so the stop rules run in Node tests.
import { SAMPLE_RATE } from '../../../../server/lib/timeline'
import type { AudioClock, OutputSource } from './audio-clock'
import {
  DEFAULT_FIT_OPTIONS,
  fitPiecewise,
  median,
  slopePpm,
  SyncFitter,
  wholeFrameStep,
  type FitEvent,
  type FitOptions,
  type FitSegment,
  type StopKind,
  type StopReason,
  type SyncPoint,
} from './fit'

/** One presented frame: composition seconds `mediaTime` was on screen at perf `expectedDisplayTime`. */
export interface Anchor {
  mediaTime: number
  expectedDisplayTime: number
  /** The callback's own `now` (perf ms). */
  now: number
  presentedFrames: number
}

/**
 * Anchors held back before the picture monitor and the online fit see them (PictureClock.observe): Firefox's
 * lookaheads came one or two in a row.
 */
export const LOOKAHEAD_HOLD = 3

/**
 * Lookahead anchors: ones whose mediaTime is later than one of the next `hold` anchors'. Playing forward, the picture
 * never shows a frame and then an earlier one, so such an anchor didn't show that frame at that time. Firefox's rVFC
 * does this when the main thread is busy (docs/spikes.md S10, Firefox): up to one callback in five reports a frame
 * 8-12 frames (283-400 ms) ahead of the steady offset, presentedFrames jumping by as many, one or two in a row, and
 * the next callback is back on the steady offset. Returns their indices.
 */
export function lookaheadAnchors(anchors: readonly Anchor[], hold = LOOKAHEAD_HOLD): Set<number> {
  const out = new Set<number>()
  anchors.forEach((a, i) => {
    for (let j = i + 1; j <= i + hold && j < anchors.length; j++) {
      if ((anchors[j]?.mediaTime ?? Infinity) < a.mediaTime) {
        out.add(i)
        return
      }
    }
  })
  return out
}

/** Seconds: what the picture shows at perf time p is p/1000 + pictureOffset (for a steady picture). */
export const pictureOffset = (a: Anchor): number => a.mediaTime - a.expectedDisplayTime / 1000

export type PictureEvent =
  | { kind: 'skip'; frames: number; index: number }
  | { kind: 'step'; frames: number; index: number; atPerf: number }
  | { kind: 'break'; offsetMs: number; index: number }
  | { kind: 'stall'; gapMs: number }

export interface PictureMonitorOptions {
  fps: number
  /** Offset change (ms) that counts as a breach. */
  limitMs: number
  run: number
  stepToleranceMs: number
  /** Anchors in the running median reference. */
  reference: number
  /**
   * No anchor for this long while playing (or the video waiting for data this long) is a stall. S10 used 300 ms, which
   * a garbage collection or a busy main thread reaches in normal playback and stopped real takes; a shorter pause only
   * moves the picture against the audio, which the fit re-anchors on.
   */
  stallMs: number
}

export const DEFAULT_PICTURE_OPTIONS: PictureMonitorOptions = {
  fps: 30,
  limitMs: 10,
  run: 3,
  stepToleranceMs: 4,
  reference: 30,
  stallMs: 2000,
}

export class PictureMonitor {
  readonly options: PictureMonitorOptions
  private recent: number[] = []
  private run: { index: number; offsetMs: number; atPerf: number }[] = []
  private last: Anchor | null = null
  private index = 0
  readonly steps: Extract<PictureEvent, { kind: 'step' }>[] = []
  skipped = 0

  constructor(options: Partial<PictureMonitorOptions> = {}) {
    this.options = { ...DEFAULT_PICTURE_OPTIONS, ...options }
  }

  observe(a: Anchor): PictureEvent[] {
    const o = this.options
    const out: PictureEvent[] = []
    const i = this.index++
    const prev = this.last
    this.last = a
    if (prev && a.presentedFrames - prev.presentedFrames > 1) {
      const frames = a.presentedFrames - prev.presentedFrames - 1
      this.skipped += frames
      out.push({ kind: 'skip', frames, index: i })
    }
    const d = pictureOffset(a)
    if (this.recent.length < Math.min(10, o.reference)) {
      this.accept(d)
      return out
    }
    const ref = median(this.recent)
    const r = (d - ref) * 1000
    if (Math.abs(r) <= o.limitMs) {
      this.run = []
      this.accept(d)
      return out
    }
    this.run.push({ index: i, offsetMs: r, atPerf: a.expectedDisplayTime })
    if (this.run.length < o.run) return out
    const first = this.run[0] ?? { index: i, atPerf: a.expectedDisplayTime }
    const k = wholeFrameStep(
      this.run.map((q) => q.offsetMs),
      1000 / o.fps,
      o.stepToleranceMs,
    )
    if (k !== null) {
      const step = { kind: 'step' as const, frames: k, index: first.index, atPerf: first.atPerf }
      this.steps.push(step)
      out.push(step)
    } else out.push({ kind: 'break', offsetMs: r, index: first.index })
    // Either way the picture now sits at the new offset: re-reference on the run.
    this.recent = this.run.map((q) => ref + q.offsetMs / 1000)
    this.run = []
    return out
  }

  private accept(d: number) {
    this.recent.push(d)
    if (this.recent.length > this.options.reference) this.recent.shift()
  }

  /** The watchdog: a stall when the last anchor (`last`, default the last observed) is older than stallMs while playing. */
  checkStall(
    now: number,
    paused: boolean,
    last: Anchor | null = this.last,
  ): Extract<PictureEvent, { kind: 'stall' }> | null {
    if (paused || !last) return null
    const gapMs = now - last.now
    return gapMs > this.options.stallMs ? { kind: 'stall', gapMs } : null
  }
}

// ---- the DOM-attached clock

/** The <video> parts the clock uses. */
export interface VideoLike extends EventTarget {
  readonly paused: boolean
  requestVideoFrameCallback?: (cb: (now: number, md: VideoFrameCallbackMetadata) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export interface PictureClockOptions {
  fps?: number
  audioClock?: AudioClock | null
  /** The take's mic track: `ended` stops the take. */
  track?: EventTarget | null
  /** The AudioContext: an `interrupted` (Safari) or non-running state after running stops the take. */
  context?: (EventTarget & { readonly state: string }) | null
  doc?: (EventTarget & { readonly visibilityState: DocumentVisibilityState }) | null
  mediaDevices?: EventTarget | null
  fit?: Partial<FitOptions>
  picture?: Partial<PictureMonitorOptions>
  now?: () => number
  /** Structured log, one event per step. */
  log?: (event: string, fields: Record<string, unknown>) => void
}

/** The take the anchors are fitted against: its first captured context frame and rates. */
export interface TakeClockInput {
  startFrame: number
  /** Context sample rate; defaults to the audio clock's context. */
  contextRate?: number
  /** Take sample rate (x axis of the fit). */
  outRate?: number
}

export interface TakeFit {
  segments: FitSegment[]
  /** Why the take stopped; null while running or with no stop yet. */
  stop: StopReason | null
  /** Take samples [0, cleanSamples) are clean: the take keeps them. */
  cleanSamples: number
  steps: { atSample: number; frames: number }[]
  /** Steady offsets the fit re-anchored on instead of stopping (fit.ts SyncFitter). */
  reanchors: { atSample: number; offsetMs: number }[]
  outliers: number
  /** Lookahead anchors dropped (Firefox; see PictureClock.observe). */
  lookaheads: number
  skippedFrames: number
  anchors: number
  outputSource: OutputSource | null
  /** Slope of the longest segment against 1/outRate. */
  slopePpm: number | null
}

type StopListener = (reason: StopReason) => void

export class PictureClock {
  /** Every anchor the video gave, lookaheads included (medians over them, as the stem monitor takes, shrug those off). */
  readonly anchors: Anchor[] = []
  /** The newest anchors, held back from the picture monitor and the online fit until later ones rule out lookaheads. */
  private held: Anchor[] = []
  /** Lookahead anchors dropped from the online stream. */
  lookaheads = 0
  readonly monitor: PictureMonitor
  private fitter: SyncFitter | null = null
  private take: Required<TakeClockInput> | null = null
  private stopped: StopReason | null = null
  private readonly listeners = new Set<StopListener>()
  private readonly anchorListeners = new Set<(a: Anchor, events: PictureEvent[]) => void>()
  private rvfc = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private ctxWasRunning = false
  /** When the video started waiting for data (null while it plays). */
  private waitingSince: number | null = null
  private detach: (() => void) | null = null
  private readonly now: () => number
  private readonly fitOptions: Partial<FitOptions>

  constructor(
    readonly video: VideoLike,
    private readonly o: PictureClockOptions = {},
  ) {
    const fps = o.fps ?? DEFAULT_FIT_OPTIONS.fps
    this.monitor = new PictureMonitor({ fps, ...o.picture })
    this.fitOptions = { fps, ...o.fit }
    this.now = o.now ?? (() => performance.now())
  }

  get stopReason(): StopReason | null {
    return this.stopped
  }

  get hasFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function'
  }

  /** Starts collecting anchors and arms the stop rules. */
  start(): this {
    if (this.detach || this.stopped) return this
    const o = this.o
    const on = (t: EventTarget | null | undefined, type: string, fn: () => void) => {
      if (!t) return () => undefined
      t.addEventListener(type, fn)
      return () => t.removeEventListener(type, fn)
    }
    const ctx = o.context
    this.ctxWasRunning = ctx?.state === 'running'
    const offs = [
      on(this.video, 'seeking', () => this.stop('seek')),
      // Waiting for data stops the take only if it lasts (tick); the video resuming clears it.
      on(this.video, 'waiting', () => {
        this.waitingSince ??= this.now()
        o.log?.('clock.waiting', { at: this.waitingSince })
      }),
      on(this.video, 'playing', () => {
        if (this.waitingSince !== null)
          o.log?.('clock.resumed', { waitedMs: Math.round(this.now() - this.waitingSince) })
        this.waitingSince = null
      }),
      on(this.video, 'ended', () => this.stop('ended')),
      on(o.doc, 'visibilitychange', () => {
        if (o.doc?.visibilityState === 'hidden') this.stop('hidden')
      }),
      // A device list change alone doesn't stop the take (Chrome fires it for devices that have nothing to do with it);
      // losing the take's own mic ends its track, which does.
      on(o.mediaDevices, 'devicechange', () => {
        const state = (o.track as { readyState?: string } | null | undefined)?.readyState ?? null
        o.log?.('clock.devicechange', { trackState: state })
        if (state === 'ended') this.stop('track-ended', 'the microphone went away')
      }),
      on(o.track, 'ended', () => this.stop('track-ended')),
      on(ctx, 'statechange', () => {
        const state = ctx?.state
        if (state === 'running') this.ctxWasRunning = true
        else if (state === 'interrupted' || this.ctxWasRunning) this.stop('context-interrupted', state)
      }),
    ]
    this.watchdog = setInterval(() => this.tick(), 100)
    this.detach = () => {
      for (const off of offs) off()
      if (this.watchdog) clearInterval(this.watchdog)
      this.watchdog = null
      if (this.rvfc) this.video.cancelVideoFrameCallback?.(this.rvfc)
      this.rvfc = 0
    }
    if (this.hasFrameCallbacks) this.rvfc = this.video.requestVideoFrameCallback?.(this.onFrame) ?? 0
    o.log?.('clock.start', { rvfc: this.hasFrameCallbacks, fps: this.fitOptions.fps })
    return this
  }

  /**
   * Starts the online fit against a take (its first captured context frame). Anchors already collected are fitted
   * too, so the recorder can call this once its start frame is known.
   */
  beginTake(input: TakeClockInput): void {
    this.take = {
      startFrame: input.startFrame,
      contextRate: input.contextRate ?? this.o.audioClock?.ctx.sampleRate ?? 48_000,
      outRate: input.outRate ?? SAMPLE_RATE,
    }
    this.fitter = new SyncFitter({ ...this.fitOptions, sampleRate: this.take.outRate })
    // The held anchors aren't released yet; observe() fits them when they are.
    const released = this.anchors.length - this.held.length
    const lookahead = lookaheadAnchors(this.anchors)
    this.anchors.slice(0, released).forEach((a, i) => {
      if (!lookahead.has(i)) this.fitAnchor(a)
    })
  }

  /** The watchdog tick (100 ms). Public for tests. */
  tick(): void {
    const now = this.now()
    const stallMs = this.monitor.options.stallMs
    if (this.waitingSince !== null && now - this.waitingSince > stallMs) {
      this.stop('stall', `the video waited ${((now - this.waitingSince) / 1000).toFixed(1)} s for data`)
      return
    }
    const s = this.monitor.checkStall(now, this.video.paused, this.anchors.at(-1) ?? null)
    if (s) this.stop('stall', `the video showed no new frame for ${(s.gapMs / 1000).toFixed(1)} s`)
  }

  /**
   * Feeds one anchor (the rVFC callback does this; tests call it directly). It joins `anchors` and the anchor
   * listeners hear it at once; the picture monitor and the online fit get it LOOKAHEAD_HOLD callbacks later, unless a
   * newer anchor showed it was a lookahead (`lookaheadAnchors`). A stop found then still ends the clean part at the
   * first breaching anchor, so the hold-back only delays it by a few frames.
   */
  observe(a: Anchor): void {
    if (this.stopped) return
    this.o.audioClock?.sample()
    this.anchors.push(a)
    this.dropLookaheads(a.mediaTime)
    this.held.push(a)
    const events: PictureEvent[] = []
    // release() may stop the take (stopReason is a getter, so this isn't narrowed away).
    while (this.held.length > LOOKAHEAD_HOLD && !this.stopReason)
      events.push(...this.release(this.held.shift() as Anchor))
    for (const l of this.anchorListeners) l(a, events)
  }

  /** Drops held anchors later than `mediaTime` (lookaheads). */
  private dropLookaheads(mediaTime: number) {
    const kept = this.held.filter((h) => h.mediaTime <= mediaTime)
    for (const h of this.held) {
      if (h.mediaTime <= mediaTime) continue
      this.lookaheads++
      // The first, then every 100th: under load Firefox gives several a second.
      if (this.lookaheads === 1 || this.lookaheads % 100 === 0)
        this.o.log?.('clock.lookahead', {
          mediaTime: h.mediaTime,
          next: mediaTime,
          presentedFrames: h.presentedFrames,
          count: this.lookaheads,
        })
    }
    this.held = kept
  }

  /** Feeds a held anchor to the picture monitor and the online fit; returns the monitor's events. */
  private release(a: Anchor): PictureEvent[] {
    const events = this.monitor.observe(a)
    for (const e of events) {
      if (e.kind === 'step') {
        const at = this.sampleAt(e.atPerf)
        if (at !== null) this.fitter?.split(at)
        this.o.log?.('clock.picture-step', { frames: e.frames, anchor: e.index, atSample: at })
      }
    }
    this.fitAnchor(a)
    return events
  }

  private readonly onFrame = (now: number, md: VideoFrameCallbackMetadata) => {
    if (this.stopped) return
    // Tests on the mock build can make the frames as uneven as real hardware's (window.__vaTestFrameJitter).
    const jitter = (
      globalThis as { __vaTestFrameJitter?: (m: VideoFrameCallbackMetadata) => VideoFrameCallbackMetadata }
    ).__vaTestFrameJitter
    const m = jitter ? jitter(md) : md
    this.observe({
      mediaTime: m.mediaTime,
      expectedDisplayTime: m.expectedDisplayTime,
      now,
      presentedFrames: m.presentedFrames,
    })
    // observe() may have stopped the take.
    if (!this.stopReason) this.rvfc = this.video.requestVideoFrameCallback?.(this.onFrame) ?? 0
  }

  private sampleAt(perf: number): number | null {
    const t = this.take
    const ck = this.o.audioClock
    if (!t || !ck) return null
    return ck.perfToTakeSample(perf, t.startFrame, t.outRate)
  }

  private fitAnchor(a: Anchor) {
    const x = this.sampleAt(a.expectedDisplayTime)
    if (!this.fitter || x === null || x < 0) return
    const ev: FitEvent = this.fitter.push({ sample: x, time: a.mediaTime })
    if (ev.type === 'step') this.o.log?.('clock.fit-step', { frames: ev.frames, atSample: ev.atSample })
    else if (ev.type === 'reanchor')
      this.o.log?.('clock.fit-reanchor', { offsetMs: ev.offsetMs, atSample: ev.atSample })
    else if (ev.type === 'stop') this.stop(ev.kind, ev.detail, ev.atSample)
  }

  /** Stops the take (Space is `user`). The first reason wins; listeners hear it once. */
  stop(kind: StopKind, detail?: string, atSample?: number): void {
    if (this.stopped) return
    const atPerf = this.now()
    const sample = atSample ?? this.sampleAt(atPerf)
    this.stopped = {
      kind,
      atPerf,
      atSample: sample === null ? null : Math.max(0, Math.floor(sample)),
      ...(detail === undefined ? {} : { detail }),
    }
    this.held = []
    this.detach?.()
    this.detach = null
    this.o.log?.('clock.stop', { ...this.stopped, anchors: this.anchors.length, lookaheads: this.lookaheads })
    for (const l of this.listeners) l(this.stopped)
  }

  onStop(fn: StopListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onAnchor(fn: (a: Anchor, events: PictureEvent[]) => void): () => void {
    this.anchorListeners.add(fn)
    return () => this.anchorListeners.delete(fn)
  }

  /**
   * The final piecewise fit for the take, with the clock maps as they are now (after stop they include the whole
   * take). `endSample` is the take's captured length; the clean part ends at the stop or the fit's own stop,
   * whichever is earlier.
   */
  fitFor(input: TakeClockInput | null = this.take, endSample?: number): TakeFit {
    const ck = this.o.audioClock
    const empty: TakeFit = {
      segments: [],
      stop: this.stopped,
      cleanSamples: 0,
      steps: [],
      reanchors: [],
      outliers: 0,
      lookaheads: this.lookaheads,
      skippedFrames: this.monitor.skipped,
      anchors: this.anchors.length,
      outputSource: ck?.outputSource ?? null,
      slopePpm: null,
    }
    if (!input || !ck) return empty
    const outRate = input.outRate ?? SAMPLE_RATE
    const points: SyncPoint[] = []
    // The final fit leaves lookaheads out, as the online fit did.
    const lookahead = lookaheadAnchors(this.anchors)
    for (const [i, a] of this.anchors.entries()) {
      if (lookahead.has(i)) continue
      const x = ck.perfToTakeSample(a.expectedDisplayTime, input.startFrame, outRate)
      if (x >= 0) points.push({ sample: x, time: a.mediaTime })
    }
    const last = points.at(-1)?.sample ?? 0
    const end = Math.min(endSample ?? Infinity, this.stopped?.atSample ?? Infinity)
    const pictureSteps = this.monitor.steps.map((s) => ({
      atSample: ck.perfToTakeSample(s.atPerf, input.startFrame, outRate),
      frames: s.frames,
    }))
    const splits = pictureSteps.map((s) => s.atSample)
    const fit = fitPiecewise(
      points,
      Number.isFinite(end) ? end : Math.ceil(last),
      {
        ...this.fitOptions,
        sampleRate: outRate,
      },
      splits,
    )
    const longest = [...fit.segments].sort(
      (p, q) => q.toSample - q.fromSample - (p.toSample - p.fromSample),
    )[0]
    return {
      ...empty,
      segments: fit.segments,
      cleanSamples: fit.cleanSamples,
      steps: [...pictureSteps, ...fit.steps].sort((p, q) => p.atSample - q.atSample),
      reanchors: fit.reanchors,
      outliers: fit.outliers,
      lookaheads: lookahead.size,
      slopePpm: longest ? slopePpm(longest.b, outRate) : null,
    }
  }

  dispose(): void {
    this.detach?.()
    this.detach = null
    this.listeners.clear()
    this.anchorListeners.clear()
  }
}
