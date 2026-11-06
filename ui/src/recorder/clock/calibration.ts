// Input-to-picture calibration per audio route (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1, §5.3; docs/
// spikes.md S10). Mic input latency isn't reliably reported, so it is measured, and the procedure must work with
// headphones on. The candidates S10 built:
//
//   (b) clap-on-flash (the default): the person claps on each of 8 visual flashes. It measures the whole
//       perceive-and-react path the take has. Latency = median of (clap heard − flash shown) after dropping outliers
//       beyond 3 MADs.
//   (a) speaker loopback (an option): 8 scheduled clicks through the speakers, heard by the mic. Latency = render-map
//       time of the captured onset − getOutputTimestamp time of the click. It needs speakers once; the input latency it
//       measures is then reused with headphones.
//   (c) manual: the Sync offset ± slider, always available, saved per take into the clip's offsetSamples.
//
// The default is provisional until the owner hardware matrix (va-2qq.1.6) picks one from measured repeatability.
// Calibration is keyed to the route (input device, output device, sample rate) in localStorage, so a new or changed
// route prompts again; storage failures (private mode, blocked storage) fall back to memory for the session.
import { SAMPLE_RATE } from '../../../../src/lib/timeline'
import { robustMedian } from './fit'
import { OnsetDetector, type Onset } from './onsets'

export type CalibrationMethod = 'clap' | 'loopback' | 'manual'

export const DEFAULT_CALIBRATION = {
  method: 'clap' as CalibrationMethod,
  fallback: 'manual' as CalibrationMethod,
  /** Pending the owner hardware matrix (va-2qq.1.6). */
  provisional: true,
  flashes: 8,
  /** A steady beat, so the person can clap on the flash rather than react to it. */
  intervalMs: 1_200,
  leadInMs: 1_500,
  flashMs: 120,
  /** A clap counts for a flash from this long before it to this long after. */
  matchWindowMs: [-250, 600] as const,
  /** Fewer matched claps than this is a failed calibration (fall back to manual). */
  minMatched: 5,
  /** Outliers beyond max(3 MADs, this) from the median are dropped. */
  madFloorMs: 15,
  clicks: 8,
  clickIntervalMs: 600,
  /** The manual slider's range. */
  manualRangeMs: 250,
}

export interface AudioRoute {
  inputDeviceId: string
  /** 'default' when the output isn't chosen (no setSinkId). */
  outputDeviceId: string
  sampleRate: number
}

export const routeKey = (r: AudioRoute): string =>
  `${r.inputDeviceId || 'default'}|${r.outputDeviceId || 'default'}|${r.sampleRate}`

/** The route a take records on: the mic track's actual device, the context's sink and rate. */
export function routeOf(
  track: { getSettings(): MediaTrackSettings } | null,
  ctx: { sampleRate: number; sinkId?: unknown },
): AudioRoute {
  const sink = typeof ctx.sinkId === 'string' && ctx.sinkId ? ctx.sinkId : 'default'
  return {
    inputDeviceId: track?.getSettings().deviceId ?? 'default',
    outputDeviceId: sink,
    sampleRate: ctx.sampleRate,
  }
}

/** Mic hears later than the picture shows: a measured latency moves the take earlier. */
export const latencyToOffsetSamples = (latencyMs: number): number =>
  -Math.round((latencyMs * SAMPLE_RATE) / 1000)
/** The manual Sync offset (+ = later), in samples. */
export const msToOffsetSamples = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000)

export interface CalibrationResult {
  method: Exclude<CalibrationMethod, 'manual'>
  latencyMs: number
  sdMs: number
  /** Matched events kept after outliers were dropped. */
  n: number
  dropped: number[]
  matched: number
  of: number
}

export type CalibrationOutcome =
  { ok: true; result: CalibrationResult } | { ok: false; reason: 'too-few'; matched: number; of: number }

/**
 * Pairs each cue (flash or click, perf ms) with the nearest unused hit (clap or onset, perf ms) within
 * [cue + lo, cue + hi], and returns hit − cue for each pair. Nearest, so a stray late clap from the previous flash
 * doesn't take this flash's.
 */
export function matchLatencies(
  cues: readonly number[],
  hits: readonly number[],
  [lo, hi]: readonly [number, number],
) {
  const used = new Set<number>()
  const out: number[] = []
  for (const c of [...cues].sort((p, q) => p - q)) {
    let best = -1
    hits.forEach((h, j) => {
      const d = h - c
      if (used.has(j) || d < lo || d > hi) return
      if (best < 0 || Math.abs(d) < Math.abs((hits[best] ?? 0) - c)) best = j
    })
    if (best < 0) continue
    used.add(best)
    out.push((hits[best] ?? 0) - c)
  }
  return out
}

function outcome(
  method: CalibrationResult['method'],
  cues: readonly number[],
  hits: readonly number[],
  window: readonly [number, number],
  floorMs: number,
  minMatched: number,
): CalibrationOutcome {
  const lat = matchLatencies(cues, hits, window)
  if (lat.length < minMatched) return { ok: false, reason: 'too-few', matched: lat.length, of: cues.length }
  const r = robustMedian(lat, floorMs)
  if (r.kept.length < minMatched)
    return { ok: false, reason: 'too-few', matched: r.kept.length, of: cues.length }
  return {
    ok: true,
    result: {
      method,
      latencyMs: r.median,
      sdMs: r.sd,
      n: r.kept.length,
      dropped: r.dropped,
      matched: lat.length,
      of: cues.length,
    },
  }
}

/**
 * (b) Flash times (when each flash was shown) and clap times (when each clap was captured), both perf ms. The match
 * window is held within half the flash interval, so a late clap can't be taken for the next flash's.
 */
export function clapCalibration(
  flashes: readonly number[],
  claps: readonly number[],
  o: Partial<
    Pick<typeof DEFAULT_CALIBRATION, 'matchWindowMs' | 'madFloorMs' | 'minMatched' | 'intervalMs'>
  > = {},
): CalibrationOutcome {
  const d = { ...DEFAULT_CALIBRATION, ...o }
  const half = d.intervalMs / 2
  const window = [Math.max(d.matchWindowMs[0], -half), Math.min(d.matchWindowMs[1], half)] as const
  return outcome('clap', flashes, claps, window, d.madFloorMs, d.minMatched)
}

/** (a) Click times (when each was heard, getOutputTimestamp map) and captured onsets (render map), both perf ms. */
export function loopbackCalibration(
  clicks: readonly number[],
  onsets: readonly number[],
  o: { minMatched?: number } = {},
): CalibrationOutcome {
  return outcome('loopback', clicks, onsets, [-50, 600], 2, o.minMatched ?? DEFAULT_CALIBRATION.minMatched)
}

/** Clap onsets in a mono signal at `sampleRate` (sample indices). */
export function detectClaps(x: Float32Array, sampleRate: number): Onset[] {
  const d = new OnsetDetector({ sampleRate, refractoryMs: 250 })
  d.push(x)
  d.push(new Float32Array(Math.round(0.02 * sampleRate)))
  return d.onsets
}

// ---- the per-route store

export interface StoredCalibration {
  method: Exclude<CalibrationMethod, 'manual'>
  latencyMs: number
  sdMs: number
  n: number
  /** ISO time it was measured. */
  at: string
  provisional: boolean
}

export interface RouteCalibration {
  calibration: StoredCalibration | null
  /** The last manual Sync offset used on this route (the take's own offset is in its clip). */
  manualMs: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

interface Saved {
  v: 1
  routes: Record<string, RouteCalibration>
  lastRoute?: string
}

export const CALIBRATION_STORAGE_KEY = 'va-voiceover-calibration:v1'

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class CalibrationStore {
  private mem: Saved = { v: 1, routes: {} }

  constructor(private readonly storage: StorageLike | null = defaultStorage()) {
    try {
      const raw = storage?.getItem(CALIBRATION_STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as Partial<Saved>) : null
      if (parsed?.v === 1 && parsed.routes && typeof parsed.routes === 'object') this.mem = parsed as Saved
    } catch {
      // Unreadable or corrupt: start empty (and overwrite it on the next save).
    }
  }

  private write() {
    try {
      this.storage?.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(this.mem))
    } catch {
      // Private mode or quota: the session keeps the in-memory copy.
    }
  }

  get(route: AudioRoute): RouteCalibration {
    return this.mem.routes[routeKey(route)] ?? { calibration: null, manualMs: 0 }
  }

  /** A first take on a route with no calibration prompts for one. */
  needsCalibration(route: AudioRoute): boolean {
    return !this.get(route).calibration
  }

  save(route: AudioRoute, r: CalibrationResult, now = new Date()): StoredCalibration {
    const calibration: StoredCalibration = {
      method: r.method,
      latencyMs: r.latencyMs,
      sdMs: r.sdMs,
      n: r.n,
      at: now.toISOString(),
      provisional: DEFAULT_CALIBRATION.provisional,
    }
    this.mem.routes[routeKey(route)] = { ...this.get(route), calibration }
    this.write()
    return calibration
  }

  setManual(route: AudioRoute, ms: number): void {
    this.mem.routes[routeKey(route)] = { ...this.get(route), manualMs: ms }
    this.write()
  }

  invalidate(route: AudioRoute): void {
    const key = routeKey(route)
    this.mem.routes = Object.fromEntries(Object.entries(this.mem.routes).filter(([k]) => k !== key))
    this.write()
  }

  /**
   * Records the route a take is about to use. When it differs from the last one, the caller re-checks
   * `needsCalibration` (a new device, output or rate has its own calibration or none).
   */
  noteRoute(route: AudioRoute): { changed: boolean; previous: string | null } {
    const key = routeKey(route)
    const previous = this.mem.lastRoute ?? null
    if (previous === key) return { changed: false, previous }
    this.mem.lastRoute = key
    this.write()
    return { changed: previous !== null, previous }
  }

  /** placeRecordedTake's offsets for a take on this route, with the take's manual offset (ms). */
  offsetsFor(route: AudioRoute, manualMs = this.get(route).manualMs) {
    const c = this.get(route).calibration
    return {
      calibrationOffsetSamples: c ? latencyToOffsetSamples(c.latencyMs) : 0,
      manualOffsetSamples: msToOffsetSamples(manualMs),
    }
  }
}
