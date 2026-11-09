// The take's sync fit (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, docs/spikes.md S10): composition
// seconds t = a + b·sample over the take, from the picture's rVFC anchors mapped onto take samples. Pure: no DOM, no
// timers, so it runs in tests, in the page and in a worker.
//
// PIECEWISE. S10's 10-minute headless takes all stepped by exactly one frame (−33.3 ms) somewhere between 388 and
// 496 s and stayed there: the picture lost a frame against the audio clock. One line across the step has an 8.9 ms
// RMS. So the fit splits instead: when `residualRun` consecutive anchors breach the residual limit and all sit at the
// same whole-frame offset, a new segment starts at the first of them. A breach that isn't a whole-frame step stops
// the take (`residual`), as does a slope beyond tolerance (`slope`). The take keeps the clean part, up to the first
// breaching anchor. Sums are kept relative to the first point so 10-minute takes in samples (x up to 14.4 M) and
// seconds don't lose precision.
import { SAMPLE_RATE } from '../../../../server/lib/timeline'

export interface Line {
  /** y = a + b·x */
  a: number
  b: number
  n: number
}

export class OnlineLine {
  private x0 = 0
  private y0 = 0
  private n = 0
  private sx = 0
  private sy = 0
  private sxx = 0
  private sxy = 0

  add(x: number, y: number): void {
    if (this.n === 0) {
      this.x0 = x
      this.y0 = y
    }
    const dx = x - this.x0
    const dy = y - this.y0
    this.n++
    this.sx += dx
    this.sy += dy
    this.sxx += dx * dx
    this.sxy += dx * dy
  }

  get count(): number {
    return this.n
  }

  line(): Line | null {
    const { n, sx, sy, sxx, sxy } = this
    if (n < 2) return null
    const den = n * sxx - sx * sx
    if (den === 0) return null
    const b = (n * sxy - sx * sy) / den
    const aRel = (sy - b * sx) / n
    return { a: this.y0 + aRel - b * this.x0, b, n }
  }
}

export function fitLine(xs: ArrayLike<number>, ys: ArrayLike<number>): Line | null {
  const o = new OnlineLine()
  for (let i = 0; i < xs.length; i++) o.add(xs[i] ?? 0, ys[i] ?? 0)
  return o.line()
}

/** The line through the points' mean with a fixed slope: what a segment uses until it has enough points of its own. */
export function fitIntercept(xs: ArrayLike<number>, ys: ArrayLike<number>, b: number): Line | null {
  if (!xs.length) return null
  let s = 0
  for (let i = 0; i < xs.length; i++) s += (ys[i] ?? 0) - b * (xs[i] ?? 0)
  return { a: s / xs.length, b, n: xs.length }
}

export interface Residuals {
  rms: number
  max: number
  /** Index of the largest |residual|. */
  argmax: number
}

export function residuals(l: Line, xs: ArrayLike<number>, ys: ArrayLike<number>): Residuals {
  let ss = 0
  let max = 0
  let argmax = -1
  for (let i = 0; i < xs.length; i++) {
    const r = (ys[i] ?? 0) - (l.a + l.b * (xs[i] ?? 0))
    ss += r * r
    if (Math.abs(r) > max) {
      max = Math.abs(r)
      argmax = i
    }
  }
  return { rms: xs.length ? Math.sqrt(ss / xs.length) : 0, max, argmax }
}

export const median = (v: readonly number[]): number => {
  if (!v.length) return NaN
  const s = [...v].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? (s[m] ?? NaN) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

export const mean = (v: readonly number[]): number =>
  v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN

export const stddev = (v: readonly number[]): number => {
  if (v.length < 2) return 0
  const m = mean(v)
  return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / (v.length - 1))
}

export interface RobustMedian {
  median: number
  sd: number
  kept: number[]
  dropped: number[]
}

/**
 * Median after dropping outliers: values more than max(k·MAD·1.4826, floor) from the median are dropped (the floor
 * keeps a tight cluster from rejecting good values). Used for the 8-clap and loopback calibrations.
 */
export function robustMedian(v: readonly number[], floor = 5, k = 3): RobustMedian {
  const m = median(v)
  const mad = median(v.map((x) => Math.abs(x - m))) * 1.4826
  const lim = Math.max(k * mad, floor)
  const kept = v.filter((x) => Math.abs(x - m) <= lim)
  return { median: median(kept), sd: stddev(kept), kept, dropped: v.filter((x) => Math.abs(x - m) > lim) }
}

// ---- stop reasons

/** Why a take stopped. Every kind but `user` and `ended` keeps the clean part and shows its message. */
export type StopKind =
  | 'user'
  | 'ended'
  | 'seek'
  | 'stall'
  | 'hidden'
  | 'devicechange'
  | 'track-ended'
  | 'context-interrupted'
  | 'residual'
  | 'slope'

export interface StopReason {
  kind: StopKind
  /** performance.now() when it was detected. */
  atPerf: number
  /** Take sample the clean part ends at (exclusive), when a take was running. */
  atSample: number | null
  detail?: string
}

export const STOP_MESSAGES: Record<StopKind, string> = {
  user: 'Stopped.',
  ended: 'The video ended.',
  seek: 'The video was moved while recording, so the take stopped there.',
  stall: 'The video stalled while recording, so the take stopped there.',
  hidden:
    'The tab was hidden while recording, so the take stopped there. Keep this tab in front while you record.',
  devicechange: 'An audio device was connected or removed, so the take stopped there.',
  'track-ended': 'The microphone stopped, so the take stopped there.',
  'context-interrupted': 'The browser interrupted audio (another app or a call), so the take stopped there.',
  residual: 'The picture and the recording drifted out of sync, so the take stopped there.',
  slope: 'The audio clock ran at the wrong speed against the picture, so the take stopped there.',
}

/** Kinds whose detail is written for people (the numbers that made the clock stop), shown with the message. */
const SAYS_WHY: ReadonlySet<StopKind> = new Set(['residual', 'slope', 'stall'])

/** Why a take stopped, in plain words, with the numbers when the clock has them ("…out of sync (the picture jumped 2400 ms…)"). */
export function stopMessage(reason: Pick<StopReason, 'kind' | 'detail'>): string {
  const base = STOP_MESSAGES[reason.kind]
  if (!reason.detail || !SAYS_WHY.has(reason.kind)) return base
  return base.replace(/, so the take stopped there\.$/, ` (${reason.detail}), so the take stopped there.`)
}

// ---- piecewise fit

/**
 * Residual above which an anchor breaches, in ms. S10's 10 ms default was the headless pipeline's own error (0.005 ms)
 * with room to spare, and it stopped real takes early (a take stopped at 8.7 s of 13 s). On a real screen a frame is
 * presented on a vsync, so an anchor can sit up to one display interval off the line: 16.7 ms at 60 Hz. 20 ms clears
 * that, stays under a whole frame at 30 fps (33.3 ms, so frame steps still show as steps) and well inside lip-sync
 * tolerance (EBU R37: audio within +40/−60 ms of the picture). S10b's real-hardware run never happened; when it does,
 * its residuals replace this reasoning.
 */
export const RESIDUAL_LIMIT_MS = 20
/**
 * A jump larger than this isn't re-anchored: the take stops. A short buffering pause or a long main-thread block moves
 * the picture against the audio by its length, and the picture clock stops a take that stalls longer (stallMs), so
 * this matches it.
 */
export const REANCHOR_MAX_MS = 2000
/** Anchors in a row out of sync both ways (no steady offset to re-anchor on) before the take stops: about 1 s. */
export const SCATTER_RUN = 30
/** In-limit anchors in a row past SHIFT_FROM_MS, one side, before a re-anchor (real jitter rarely gives 10). */
export const SHIFT_RUN = 10
/** Re-anchors in one take before it stops instead (a picture that keeps jumping isn't one take any more). */
export const MAX_REANCHORS = 40
/**
 * A steady shift smaller than the residual limit still re-anchors once it's beyond this: left in the segment, a 15 ms
 * jump would tilt the line until the slope rule stopped the take.
 */
export const SHIFT_FROM_MS = 8
/** Slope tolerance against 1/SAMPLE_RATE, in ppm (S10's default; real clocks measured about 33 ppm apart). */
export const SLOPE_TOLERANCE_PPM = 1000

export interface FitOptions {
  /** Take samples per second (the x axis). */
  sampleRate: number
  /** Picture frame rate, for whole-frame step detection. */
  fps: number
  residualLimitMs: number
  /** Consecutive breaching anchors before a step or a stop. One late frame alone is only counted. */
  residualRun: number
  /** A run is a frame step when every residual is within this of the same whole number of frames. */
  stepToleranceMs: number
  /**
   * A breaching run that isn't a frame step but holds steady (every residual within `stepToleranceMs` of the run's
   * mean, and that mean within this many ms) re-anchors: a new segment starts there instead of the take stopping.
   */
  reanchorMaxMs: number
  /** Within the residual limit, a run beyond this many ms re-anchors too (see SHIFT_FROM_MS). */
  shiftFromMs: number
  /** In-limit anchors in a row past shiftFromMs, one side, that re-anchor. */
  shiftRun: number
  /** Breaching anchors in a row on both sides (scattered) before the take stops. */
  scatterRun: number
  maxReanchors: number
  slopeTolerancePpm: number
  /**
   * Anchors in the first segment before residuals are checked (the fit is still settling). When the warm-up fills,
   * anchors off the warm-up's median offset by more than the residual limit are dropped as outliers (see `trimWarmup`).
   */
  residualWarmup: number
  /** Anchors in a segment before its slope is checked. */
  slopeWarmup: number
  /** A segment fits its own slope from this many anchors; before that it keeps the previous segment's slope. */
  ownSlopeFrom: number
}

export const DEFAULT_FIT_OPTIONS: FitOptions = {
  sampleRate: SAMPLE_RATE,
  fps: 30,
  residualLimitMs: RESIDUAL_LIMIT_MS,
  residualRun: 3,
  stepToleranceMs: 4,
  reanchorMaxMs: REANCHOR_MAX_MS,
  shiftFromMs: SHIFT_FROM_MS,
  shiftRun: SHIFT_RUN,
  scatterRun: SCATTER_RUN,
  maxReanchors: MAX_REANCHORS,
  slopeTolerancePpm: SLOPE_TOLERANCE_PPM,
  residualWarmup: 60,
  slopeWarmup: 300,
  ownSlopeFrom: 30,
}

/** One anchor on the take: composition seconds `time` was on screen when take sample `sample` was captured. */
export interface SyncPoint {
  sample: number
  time: number
}

/** One piece of the fit: t = a + b·sample for take samples [fromSample, toSample). Residuals in ms. */
export interface FitSegment {
  fromSample: number
  toSample: number
  a: number
  b: number
  residualRms: number
  residualMax: number
  n: number
}

export type FitEvent =
  | { type: 'ok'; residualMs: number | null }
  | { type: 'outlier'; residualMs: number }
  | { type: 'step'; atSample: number; frames: number }
  | { type: 'reanchor'; atSample: number; offsetMs: number }
  | { type: 'stop'; kind: 'residual' | 'slope'; atSample: number; detail: string }

/**
 * What a breaching run is: a whole-frame step when every residual sits within `toleranceMs` of the same non-zero
 * number of frames, else null.
 */
export function wholeFrameStep(
  residualsMs: readonly number[],
  frameMs: number,
  toleranceMs: number,
): number | null {
  if (!residualsMs.length) return null
  const k = Math.round(mean(residualsMs) / frameMs)
  if (k === 0) return null
  return residualsMs.every((r) => Math.abs(r - k * frameMs) <= toleranceMs) ? k : null
}

interface Piece {
  xs: number[]
  ys: number[]
  /** Running least squares over xs/ys, so each anchor costs O(1) on a 10-minute take. */
  ols: OnlineLine
}

function piece(xs: number[] = [], ys: number[] = []): Piece {
  const ols = new OnlineLine()
  xs.forEach((x, i) => ols.add(x, ys[i] ?? 0))
  return { xs, ys, ols }
}

/** The online piecewise fitter. Push anchors in order; it answers with what each one did to the fit. */
export class SyncFitter {
  readonly options: FitOptions
  private readonly pieces: Piece[] = [piece()]
  private run: { x: number; r: number }[] = []
  /** Consecutive in-limit anchors beyond shiftFromMs, which re-anchor when they hold steady. */
  private shift: { x: number; r: number }[] = []
  /** Anchors in the breaching run, not yet in a segment. */
  private pending: SyncPoint[] = []
  private stopped: Extract<FitEvent, { type: 'stop' }> | null = null
  private trimmed = false
  readonly outliers: { sample: number; residualMs: number }[] = []
  readonly steps: { atSample: number; frames: number }[] = []
  /** Steady offsets that started a new segment instead of stopping the take. */
  readonly reanchors: { atSample: number; offsetMs: number }[] = []

  constructor(options: Partial<FitOptions> = {}) {
    this.options = { ...DEFAULT_FIT_OPTIONS, ...options }
  }

  get stop(): Extract<FitEvent, { type: 'stop' }> | null {
    return this.stopped
  }

  get count(): number {
    return this.pieces.reduce((n, p) => n + p.xs.length, 0)
  }

  private get piece(): Piece {
    return this.pieces[this.pieces.length - 1] as Piece
  }

  /** The current segment's line: its own least squares once it has `ownSlopeFrom` anchors, else the previous slope. */
  private lineOf(i: number): Line | null {
    const p = this.pieces[i]
    if (!p) return null
    if (p.xs.length >= this.options.ownSlopeFrom || i === 0) {
      const own = p.ols.line()
      if (own) return own
    }
    const prev = i > 0 ? this.lineOf(i - 1) : null
    return fitIntercept(p.xs, p.ys, prev?.b ?? 1 / this.options.sampleRate)
  }

  /** The current segment's line, or null before it has two anchors. */
  currentLine(): Line | null {
    return this.lineOf(this.pieces.length - 1)
  }

  push(p: SyncPoint): FitEvent {
    if (this.stopped) return this.stopped
    const o = this.options
    if (!this.trimmed && this.pieces.length === 1 && this.piece.xs.length >= o.residualWarmup)
      this.trimWarmup()
    const line = this.currentLine()
    const checking = line && (this.pieces.length > 1 || this.piece.xs.length >= o.residualWarmup)
    if (!line || !checking) {
      this.add(p)
      return { type: 'ok', residualMs: null }
    }
    const r = (p.time - (line.a + line.b * p.sample)) * 1000
    if (Math.abs(r) <= o.residualLimitMs) {
      this.run = []
      this.add(p)
      const moved = this.checkShift(p.sample, r)
      if (moved) return moved
      return this.checkSlope(p) ?? { type: 'ok', residualMs: r }
    }
    this.shift = []
    // Breaching: held back from the segment until the run says whether it's a step, a stop or a one-off.
    this.run.push({ x: p.sample, r })
    this.pending.push(p)
    if (this.run.length < o.residualRun) {
      this.outliers.push({ sample: p.sample, residualMs: r })
      return { type: 'outlier', residualMs: r }
    }
    const rs = this.run.map((q) => q.r)
    const from = this.run[0]?.x ?? p.sample
    // Real anchors jitter by several ms (a frame shows on a vsync), so a run is judged by its side and its median, not
    // by every anchor sitting within a few ms of each other.
    const oneSide = rs.every((v) => Math.sign(v) === Math.sign(rs[0] ?? 0))
    if (!oneSide) {
      // Out of sync both ways: dropped as outliers while it lasts; only a second of it stops the take.
      if (this.run.length < o.scatterRun) {
        this.outliers.push({ sample: p.sample, residualMs: r })
        return { type: 'outlier', residualMs: r }
      }
      const worst = rs.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
      return this.halt(
        'residual',
        from,
        `the picture's timing scattered up to ${worst.toFixed(0)} ms either way for ${this.run.length} frames`,
      )
    }
    const m = median(rs)
    const k = wholeFrameStep(rs, 1000 / o.fps, Math.max(o.stepToleranceMs, this.jitterMs()))
    if (Math.abs(m) > o.reanchorMaxMs)
      return this.halt('residual', from, `the picture jumped ${m.toFixed(0)} ms against the recording`)
    if (this.reanchors.length + this.steps.length >= o.maxReanchors)
      return this.halt('residual', from, `the picture kept jumping (${o.maxReanchors} times)`)
    // The run's first anchors were counted as outliers before it turned out to be a jump.
    this.outliers.splice(this.outliers.length - (this.run.length - 1))
    this.split(from)
    if (k !== null) {
      this.steps.push({ atSample: from, frames: k })
      return { type: 'step', atSample: from, frames: k }
    }
    this.reanchors.push({ atSample: from, offsetMs: m })
    return { type: 'reanchor', atSample: from, offsetMs: m }
  }

  /** The current segment's residual spread (ms), for telling a frame step from jitter around one. */
  private jitterMs(): number {
    const line = this.currentLine()
    const p = this.piece
    if (!line || p.xs.length < 10) return 0
    return residuals(line, p.xs.slice(-60), p.ys.slice(-60)).rms * 1000 * 2
  }

  private halt(
    kind: 'residual' | 'slope',
    atSample: number,
    detail: string,
  ): Extract<FitEvent, { type: 'stop' }> {
    this.stopped = { type: 'stop', kind, atSample, detail }
    this.pending = []
    this.run = []
    this.shift = []
    return this.stopped
  }

  /**
   * Warm-up anchors go into the fit unchecked, so one bad anchor there skews the line every later anchor is checked
   * against. Firefox's rVFC reports a frame 8-12 frames ahead in up to one callback in five (docs/spikes.md S10,
   * Firefox): 12 of the first 60 anchors sat 233-317 ms ahead, the least-squares line sat ~77 ms off, and the good anchors
   * after the warm-up all breached. So once the warm-up fills, the anchors are checked against a robust reference
   * instead: the median of their offsets t − x/sampleRate (the nominal slope; over a warm-up of 2 s the slope tolerance
   * is ~2 ms, which the limit allows for). Anchors beyond the residual limit of it are outliers and leave the fit.
   * Needs a majority of good anchors; a real step inside the warm-up keeps the majority side and the step shows after.
   */
  private trimWarmup() {
    this.trimmed = true
    const o = this.options
    const { xs, ys } = this.piece
    if (xs.length < 3) return
    const x0 = xs[0] ?? 0
    const nominal = 1 / o.sampleRate
    const offsets = xs.map((x, i) => (ys[i] ?? 0) - (x - x0) * nominal)
    const ref = median(offsets)
    const spanS = ((xs.at(-1) ?? x0) - x0) / o.sampleRate
    const limit = (o.residualLimitMs + spanS * o.slopeTolerancePpm * 1e-3) / 1000
    const keep = offsets.map((d) => Math.abs(d - ref) <= limit)
    const kept = keep.filter(Boolean).length
    if (kept === xs.length || kept < 2) return
    keep.forEach((k, i) => {
      if (!k) this.outliers.push({ sample: xs[i] ?? 0, residualMs: ((offsets[i] ?? 0) - ref) * 1000 })
    })
    this.pieces[0] = piece(
      xs.filter((_, i) => keep[i]),
      ys.filter((_, i) => keep[i]),
    )
  }

  private add(p: SyncPoint) {
    // A run that ended before reaching residualRun was one-off outliers (a late or repeated frame): they are counted
    // and left out of the fit.
    this.pending = []
    this.piece.xs.push(p.sample)
    this.piece.ys.push(p.time)
    this.piece.ols.add(p.sample, p.time)
  }

  /**
   * Starts a new segment at `fromSample`: anchors at or after it (including a pending run) move to the new segment.
   * Called on a detected step here, and by the picture when it sees a frame step on its own clock.
   */
  split(fromSample: number): void {
    if (this.stopped) return
    const cur = this.piece
    const at = cur.xs.findIndex((x) => x >= fromSample)
    const cut = at < 0 ? cur.xs.length : at
    const next = piece(
      [...cur.xs.slice(cut), ...this.pending.map((q) => q.sample)],
      [...cur.ys.slice(cut), ...this.pending.map((q) => q.time)],
    )
    this.pending = []
    this.run = []
    this.shift = []
    // Nothing before the split point: the current segment simply carries on with the moved anchors.
    if (cut === 0) this.pieces[this.pieces.length - 1] = next
    else {
      this.pieces[this.pieces.length - 1] = piece(cur.xs.slice(0, cut), cur.ys.slice(0, cut))
      this.pieces.push(next)
    }
  }

  /** A steady in-limit shift (residualRun anchors beyond shiftFromMs, one side, within stepToleranceMs): re-anchor. */
  private checkShift(x: number, r: number): FitEvent | null {
    const o = this.options
    if (
      Math.abs(r) <= o.shiftFromMs ||
      (this.shift.length && Math.sign(this.shift[0]?.r ?? 0) !== Math.sign(r))
    ) {
      this.shift = Math.abs(r) > o.shiftFromMs ? [{ x, r }] : []
      return null
    }
    this.shift.push({ x, r })
    if (this.shift.length < o.shiftRun) return null
    if (this.reanchors.length + this.steps.length >= o.maxReanchors) return null
    const m = median(this.shift.map((q) => q.r))
    const from = this.shift[0]?.x ?? x
    this.shift = []
    this.split(from)
    this.reanchors.push({ atSample: from, offsetMs: m })
    return { type: 'reanchor', atSample: from, offsetMs: m }
  }

  private checkSlope(p: SyncPoint): FitEvent | null {
    const o = this.options
    if (this.piece.xs.length < o.slopeWarmup) return null
    const line = this.currentLine()
    if (!line) return null
    const ppm = slopePpm(line.b, o.sampleRate)
    if (Math.abs(ppm) <= o.slopeTolerancePpm) return null
    return this.halt(
      'slope',
      p.sample,
      `the audio ran ${Math.abs(ppm).toFixed(0)} ppm ${ppm > 0 ? 'slow' : 'fast'} against the picture (more than ${o.slopeTolerancePpm} ppm)`,
    )
  }

  /**
   * The segments, each fitted by least squares over its own anchors (or the previous slope while it has fewer than
   * `ownSlopeFrom`). The last segment ends at `endSample` (the take's clean length); each other ends where the next
   * begins.
   */
  segments(endSample: number): FitSegment[] {
    const out: FitSegment[] = []
    this.pieces.forEach((p, i) => {
      const line = this.lineOf(i)
      if (!line || !p.xs.length) return
      const res = residuals(line, p.xs, p.ys)
      const fromSample = i === 0 ? 0 : (p.xs[0] ?? 0)
      out.push({
        fromSample,
        toSample: 0,
        a: line.a,
        b: line.b,
        residualRms: res.rms * 1000,
        residualMax: res.max * 1000,
        n: p.xs.length,
      })
    })
    out.forEach((s, i) => {
      s.toSample = out[i + 1]?.fromSample ?? endSample
    })
    return out.filter((s) => s.toSample > s.fromSample)
  }
}

export const slopePpm = (b: number, sampleRate: number = SAMPLE_RATE): number => (b * sampleRate - 1) * 1e6

export interface PiecewiseFit {
  segments: FitSegment[]
  stop: Extract<FitEvent, { type: 'stop' }> | null
  steps: { atSample: number; frames: number }[]
  reanchors: { atSample: number; offsetMs: number }[]
  outliers: number
  /** Where the clean part ends: the stop's sample, else `endSample`. */
  cleanSamples: number
}

/** The whole-take fit in one pass (the final fit after stop, with the final clock maps). */
export function fitPiecewise(
  points: readonly SyncPoint[],
  endSample: number,
  options: Partial<FitOptions> = {},
  splits: readonly number[] = [],
): PiecewiseFit {
  const f = new SyncFitter(options)
  const cuts = [...splits].sort((p, q) => p - q)
  for (const p of points) {
    while (cuts.length && (cuts[0] ?? Infinity) <= p.sample) f.split(cuts.shift() ?? 0)
    if (f.push(p).type === 'stop') break
  }
  const cleanSamples = Math.max(0, Math.floor(Math.min(endSample, f.stop?.atSample ?? endSample)))
  return {
    segments: f.segments(cleanSamples),
    stop: f.stop,
    steps: f.steps,
    reanchors: f.reanchors,
    outliers: f.outliers.length,
    cleanSamples,
  }
}
