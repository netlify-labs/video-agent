// View math for the narration timeline (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3, §5.5): zoom,
// sample <-> pixel mapping, the virtualization window, ruler ticks and waveform columns. Pure, so it's unit-tested
// without a DOM; ui/src/components/timeline/ renders with it. Positions are composition samples at SAMPLE_RATE;
// pixels are CSS pixels from the start of the timeline.
import { SAMPLE_RATE, type Span } from '../../../src/lib/timeline'
import { binCount, levelFor, type Peaks } from '../../../src/lib/peaks'

// ---- zoom

/** The longest output (15 minutes) in 900 px at the widest, so a whole video fits on a laptop. */
export const MIN_PX_PER_SEC = 1
/** About 33 px a frame at 30 fps: enough to trim to a frame. */
export const MAX_PX_PER_SEC = 1000
export const DEFAULT_PX_PER_SEC = 40
/** One wheel notch (deltaY 100) zooms by about 22%. */
const WHEEL_ZOOM_RATE = 0.002

export const clampZoom = (pxPerSec: number): number =>
  Math.min(
    MAX_PX_PER_SEC,
    Math.max(MIN_PX_PER_SEC, Number.isFinite(pxPerSec) ? pxPerSec : DEFAULT_PX_PER_SEC),
  )

export const sampleToX = (sample: number, pxPerSec: number): number => (sample / SAMPLE_RATE) * pxPerSec
export const xToSample = (x: number, pxPerSec: number): number => Math.round((x / pxPerSec) * SAMPLE_RATE)

export interface ZoomView {
  pxPerSec: number
  scrollLeft: number
}

/**
 * The view after zooming by `factor` around `anchorX` (pixels from the viewport's left edge): the time under the
 * anchor stays under it, and the scroll never goes negative.
 */
export function zoomBy(view: ZoomView, factor: number, anchorX: number): ZoomView {
  const pxPerSec = clampZoom(view.pxPerSec * factor)
  const t = (view.scrollLeft + anchorX) / view.pxPerSec
  return { pxPerSec, scrollLeft: Math.max(0, t * pxPerSec - anchorX) }
}

/** The view after a Cmd/Ctrl-wheel of `deltaY` (positive scrolls down, which zooms out). */
export const wheelZoom = (view: ZoomView, deltaY: number, anchorX: number): ZoomView =>
  zoomBy(view, Math.exp(-deltaY * WHEEL_ZOOM_RATE), anchorX)

/** The zoom that fits `samples` into `widthPx`. */
export const fitZoom = (samples: number, widthPx: number): number =>
  clampZoom(samples > 0 ? widthPx / (samples / SAMPLE_RATE) : DEFAULT_PX_PER_SEC)

// ---- virtualization

/** Window edges move in tiles this wide, so scrolling re-renders clips (and redraws waveforms) once a tile. */
export const WINDOW_TILE_PX = 512

/**
 * The composition range to render for a viewport at `scrollLeft` of `widthPx`: the visible part plus about one
 * viewport either side, with both edges snapped outwards to WINDOW_TILE_PX so it only changes every tile.
 */
export function visibleWindow(scrollLeft: number, widthPx: number, pxPerSec: number): Span {
  const pad = Math.max(widthPx, WINDOW_TILE_PX)
  const from = Math.max(0, Math.floor((scrollLeft - pad) / WINDOW_TILE_PX) * WINDOW_TILE_PX)
  const to = Math.ceil((scrollLeft + widthPx + pad) / WINDOW_TILE_PX) * WINDOW_TILE_PX
  return [xToSample(from, pxPerSec), xToSample(to, pxPerSec)]
}

/**
 * The items of `items` (sorted by start, not overlapping, so ends are sorted too: resolved clips, beats) that
 * overlap `window`, found by binary search.
 */
export function inWindow<T>(items: readonly T[], window: Span, span: (item: T) => Span): T[] {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const item = items[mid]
    if (item !== undefined && span(item)[1] <= window[0]) lo = mid + 1
    else hi = mid
  }
  const out: T[] = []
  for (let i = lo; i < items.length; i++) {
    const item = items[i]
    if (item === undefined) continue
    const [s, e] = span(item)
    if (s >= window[1]) break
    if (e > window[0]) out.push(item)
  }
  return out
}

// ---- ruler

/** Labelled tick steps in seconds: frames when zoomed right in, minutes when zoomed out. */
const STEPS = [1 / 30, 1 / 10, 1 / 5, 1 / 2, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** The smallest labelled step at least `minPx` wide at this zoom, and how many minor ticks divide it. */
export function tickStep(pxPerSec: number, minPx = 72): { step: number; minor: number } {
  const step = STEPS.find((s) => s * pxPerSec >= minPx) ?? STEPS[STEPS.length - 1] ?? 600
  const minor = step === 1 / 30 ? 1 : [15, 30, 120, 300].includes(step) ? 3 : step === 1 / 10 ? 2 : 5
  return { step, minor }
}

export interface Tick {
  /** Seconds. */
  t: number
  major: boolean
}

/** Ticks inside [fromSec, toSec), majors on multiples of the step. */
export function ticks(fromSec: number, toSec: number, pxPerSec: number): Tick[] {
  const { step, minor } = tickStep(pxPerSec)
  const sub = step / minor
  const out: Tick[] = []
  for (let i = Math.max(0, Math.floor(fromSec / sub)); i * sub < toSec; i++)
    out.push({ t: i * sub, major: i % minor === 0 })
  return out
}

/** m:ss, with tenths (or frames) when the step needs them: "1:05", "0:12.5", "0:03+12f". */
export function formatTime(seconds: number, step = 1): string {
  const s = Math.max(0, seconds)
  if (step < 1 / 15) {
    const whole = Math.floor(s + 1e-9)
    const frame = Math.round((s - whole) * 30)
    return `${formatTime(whole)}${frame ? `+${frame}f` : ''}`
  }
  const tenths = step < 1
  const total = tenths ? Math.round(s * 10) / 10 : Math.round(s)
  const m = Math.floor(total / 60)
  const rest = total - m * 60
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.round(rest)).padStart(2, '0')
  return `${m}:${sec}`
}

/** "1 minute 5 seconds"-style text for screen readers. */
export function spokenTime(seconds: number): string {
  const s = Math.round(Math.max(0, seconds) * 10) / 10
  const m = Math.floor(s / 60)
  const rest = Math.round((s - m * 60) * 10) / 10
  const secs = `${rest} ${rest === 1 ? 'second' : 'seconds'}`
  return m ? `${m} ${m === 1 ? 'minute' : 'minutes'} ${secs}` : secs
}

// ---- waveforms

/**
 * The peaks level to draw at this zoom: the coarsest whose bins are no wider than a device pixel, so a column is
 * built from a few bins at most (levelFor picks the finest when zoomed in past level 0).
 */
export function peaksLevelFor(peaks: Peaks, pxPerSec: number, devicePixelRatio = 1) {
  return levelFor(peaks, peaks.sampleRate / (pxPerSec * devicePixelRatio))
}

/**
 * Interleaved (min, max) per column, -127..127, for source samples [srcFrom, srcTo) of a take drawn into `columns`
 * device-pixel columns at this zoom. Columns past the take's end are 0.
 */
export function waveformColumns(
  peaks: Peaks,
  srcFrom: number,
  srcTo: number,
  columns: number,
  pxPerSec: number,
  devicePixelRatio = 1,
): Int8Array {
  const out = new Int8Array(Math.max(0, columns) * 2)
  if (columns <= 0 || srcTo <= srcFrom) return out
  const level = peaksLevelFor(peaks, pxPerSec, devicePixelRatio)
  const bins = binCount(level)
  const per = (srcTo - srcFrom) / columns
  for (let i = 0; i < columns; i++) {
    const s0 = srcFrom + per * i
    const b0 = Math.max(0, Math.floor(s0 / level.samplesPerBin))
    const b1 = Math.min(bins, Math.max(b0 + 1, Math.ceil((s0 + per) / level.samplesPerBin)))
    let lo = 127
    let hi = -127
    for (let b = b0; b < b1; b++) {
      lo = Math.min(lo, level.data[2 * b] ?? 0)
      hi = Math.max(hi, level.data[2 * b + 1] ?? 0)
    }
    if (b1 > b0) {
      out[2 * i] = lo
      out[2 * i + 1] = hi
    }
  }
  return out
}
