// Scheduling the monitor mix against the picture (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, docs/spikes.md
// S10). Pure: the stem monitor (va-2qq.4.7) owns the AudioBufferSourceNodes and asks this where to start them and when
// to restart them.
//
// - Start from about 10 anchors, not the first. Frames just after play() are presented late: scheduling from the
//   third anchor put S10's monitor 28.8 ms off for the whole take; the median of mediaTime − expectedDisplayTime over
//   10 anchors brought it to −0.5 ms.
// - Resync. The picture and the AudioContext drift about 33 ppm apart (18-21 ms over 10 minutes in S10), which the
//   take's fit absorbs but a running monitor doesn't. `MonitorSync` measures the monitor's error at every anchor
//   (where the stem is heard vs what is on screen) and asks for a restart when the median error over the last 10
//   anchors passes MAX_DRIFT_MS, or every RESYNC_PERIOD_MS when it has drifted at least MIN_RESYNC_MS (so a steady
//   monitor isn't restarted for nothing).
import { median } from './fit'
import type { Anchor } from './picture'

export const MONITOR_ANCHORS = 10
export const RESYNC_PERIOD_MS = 2_000
export const MAX_DRIFT_MS = 5
export const MIN_RESYNC_MS = 1
/** How far ahead of the context's current time a (re)start is scheduled. */
export const MONITOR_LEAD_SEC = 0.25

/** The output map the schedule needs (AudioClock's): when context time ct is heard, and its inverse. */
export interface OutputMap {
  outputContextToPerf(ct: number): number
  perfToOutputContext(perf: number): number
}

/**
 * The picture's offset in seconds, so composition time on screen at perf p is p/1000 + offset: the median of
 * mediaTime − expectedDisplayTime over the last `n` anchors. Null with fewer than `n` anchors.
 */
export function pictureOffsetFrom(anchors: readonly Anchor[], n = MONITOR_ANCHORS): number | null {
  if (anchors.length < n) return null
  return median(anchors.slice(-n).map((a) => a.mediaTime - a.expectedDisplayTime / 1000))
}

/** A monitor start: begin the stems at context time `when`, at composition seconds `offset`. */
export interface MonitorPlan {
  when: number
  offset: number
}

/** Where to (re)start the stems: `lead` seconds after `contextNow`, at what will be on screen when that is heard. */
export function planMonitorStart(
  anchors: readonly Anchor[],
  out: OutputMap,
  contextNow: number,
  { lead = MONITOR_LEAD_SEC, n = MONITOR_ANCHORS }: { lead?: number; n?: number } = {},
): MonitorPlan | null {
  const offset = pictureOffsetFrom(anchors, n)
  if (offset === null) return null
  const when = contextNow + lead
  return { when, offset: Math.max(0, out.outputContextToPerf(when) / 1000 + offset) }
}

/** The monitor's error at an anchor, in ms: + means the stem is ahead of the picture. */
export function monitorError(plan: MonitorPlan, a: Anchor, out: OutputMap): number {
  const heard = plan.offset + (out.perfToOutputContext(a.expectedDisplayTime) - plan.when)
  return (heard - a.mediaTime) * 1000
}

export interface ResyncCheck {
  errMs: number
  /** Median error over the last MONITOR_ANCHORS anchors. */
  driftMs: number
  resync: boolean
  why: 'drift' | 'period' | null
}

export interface MonitorSyncOptions {
  periodMs: number
  maxDriftMs: number
  minResyncMs: number
  n: number
}

export class MonitorSync {
  private plan: MonitorPlan | null = null
  private plannedAt = 0
  private errs: number[] = []
  resyncs = 0
  readonly options: MonitorSyncOptions

  constructor(options: Partial<MonitorSyncOptions> = {}) {
    this.options = {
      periodMs: RESYNC_PERIOD_MS,
      maxDriftMs: MAX_DRIFT_MS,
      minResyncMs: MIN_RESYNC_MS,
      n: MONITOR_ANCHORS,
      ...options,
    }
  }

  get current(): MonitorPlan | null {
    return this.plan
  }

  /** Records a (re)start the monitor made, at perf `nowPerf`. */
  started(plan: MonitorPlan, nowPerf: number): void {
    if (this.plan) this.resyncs++
    this.plan = plan
    this.plannedAt = nowPerf
    this.errs = []
  }

  /** Measures the monitor at an anchor and says whether to restart it. Null before the first start. */
  observe(a: Anchor, out: OutputMap): ResyncCheck | null {
    const plan = this.plan
    if (!plan) return null
    const o = this.options
    const errMs = monitorError(plan, a, out)
    this.errs.push(errMs)
    if (this.errs.length > o.n) this.errs.shift()
    const driftMs = median(this.errs)
    // Too few anchors since the last start: one late frame shouldn't trigger a restart.
    if (this.errs.length < o.n) return { errMs, driftMs, resync: false, why: null }
    if (Math.abs(driftMs) > o.maxDriftMs) return { errMs, driftMs, resync: true, why: 'drift' }
    if (a.now - this.plannedAt >= o.periodMs && Math.abs(driftMs) >= o.minResyncMs)
      return { errMs, driftMs, resync: true, why: 'period' }
    return { errMs, driftMs, resync: false, why: null }
  }
}
