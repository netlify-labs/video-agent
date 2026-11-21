// A demo's crop (docs/guides/screen-recordings.md "Crop"): the part of the recording's picture the demo uses, set on
// the setup page or with `recording.crop`. The request gives fractions of the frame; everything after it works in
// whole source pixels (even, so ffmpeg can cut it), kept with the frame's size so positions convert either way.
// With a crop, the cropped picture IS the frame for the rest of the pipeline: analysis runs on it, and the pointer
// trace and the hidden areas are converted into it here, once, by the same functions on the run and on the server
// (prepare-run, finalize), so the recording check compares like with like. No Node dependencies.
import type { RedactEntry, Trace } from './recording-trace.js'

export interface RecordingCrop {
  /** Source pixels, even. */
  x: number
  y: number
  width: number
  height: number
  /** The recording's own size. */
  frameWidth: number
  frameHeight: number
}

/** The least a crop may keep of the frame, each way, and in pixels. */
export const CROP_MIN_FRACTION = 0.1
export const CROP_MIN_PX = 160

const r4 = (n: number) => Math.round(n * 1e4) / 1e4
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const even = (n: number) => Math.round(n / 2) * 2

/**
 * The crop in source pixels from frame fractions [x, y, w, h]: snapped to even pixels inside the frame. Null when it
 * keeps (all but a pixel or two of) the whole frame. Throws an Error that says why for one that's too small.
 */
export function cropFromFractions(
  box: readonly [number, number, number, number],
  frameWidth: number,
  frameHeight: number,
): RecordingCrop | null {
  const [fx, fy, fw, fh] = box
  if (![fx, fy, fw, fh].every(Number.isFinite) || fx < 0 || fy < 0 || fw <= 0 || fh <= 0)
    throw new Error('crop must be [x, y, width, height] as fractions of the frame.')
  if (fx + fw > 1 + 1e-6 || fy + fh > 1 + 1e-6) throw new Error('crop must stay inside the frame.')
  const x = Math.min(even(fx * frameWidth), frameWidth - 2)
  const y = Math.min(even(fy * frameHeight), frameHeight - 2)
  const width = Math.min(even(fw * frameWidth), Math.floor((frameWidth - x) / 2) * 2)
  const height = Math.min(even(fh * frameHeight), Math.floor((frameHeight - y) / 2) * 2)
  if (x <= 2 && y <= 2 && width >= frameWidth - 4 && height >= frameHeight - 4) return null
  const minW = Math.max(CROP_MIN_PX, frameWidth * CROP_MIN_FRACTION)
  const minH = Math.max(CROP_MIN_PX, frameHeight * CROP_MIN_FRACTION)
  if (width < minW - 1e-6 || height < minH - 1e-6)
    throw new Error(
      `crop must keep at least ${String(Math.ceil(minW))}×${String(Math.ceil(minH))} px of this ${String(frameWidth)}×${String(frameHeight)} recording.`,
    )
  return { x, y, width, height, frameWidth, frameHeight }
}

/** Whether a value is a crop as the server writes it (a manifest, input.json, analysis.json). */
export function isRecordingCrop(v: unknown): v is RecordingCrop {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
  return (
    int(c.x) &&
    int(c.y) &&
    int(c.width) &&
    int(c.height) &&
    int(c.frameWidth) &&
    int(c.frameHeight) &&
    c.width >= 2 &&
    c.height >= 2 &&
    c.frameWidth <= 8192 &&
    c.frameHeight <= 8192 &&
    c.x + c.width <= c.frameWidth &&
    c.y + c.height <= c.frameHeight
  )
}

/** The crop with its keys in one order and nothing else (manifests and files keep their bytes). */
export const canonCrop = (c: RecordingCrop): RecordingCrop => ({
  x: c.x,
  y: c.y,
  width: c.width,
  height: c.height,
  frameWidth: c.frameWidth,
  frameHeight: c.frameHeight,
})

export const sameCrop = (a: RecordingCrop | null | undefined, b: RecordingCrop | null | undefined) =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.frameWidth === b.frameWidth &&
    a.frameHeight === b.frameHeight)

/** The ffmpeg filter that cuts the crop out of a frame. */
export const cropFilter = (c: RecordingCrop) =>
  `crop=${String(c.width)}:${String(c.height)}:${String(c.x)}:${String(c.y)}`

/** The crop as fractions of the frame: [x, y, w, h]. */
export const cropFractions = (c: RecordingCrop): [number, number, number, number] => [
  c.x / c.frameWidth,
  c.y / c.frameHeight,
  c.width / c.frameWidth,
  c.height / c.frameHeight,
]

/** The scene markup's data-va-crop: "x,y,width,height,frameWidth,frameHeight" in source pixels. */
export const cropAttr = (c: RecordingCrop) =>
  [c.x, c.y, c.width, c.height, c.frameWidth, c.frameHeight].map(String).join(',')

/** data-va-crop read back; null when it's absent or isn't a crop. */
export function parseCropAttr(raw: string | null | undefined): RecordingCrop | null {
  if (!raw || !/^\d+(,\d+){5}$/.test(raw)) return null
  const [x, y, width, height, frameWidth, frameHeight] = raw.split(',').map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const c = { x, y, width, height, frameWidth, frameHeight }
  return isRecordingCrop(c) ? c : null
}

/** A frame point as a point of the cropped picture, held at its edge when it's outside. */
export function cropPoint(x: number, y: number, c: RecordingCrop): [number, number] {
  const [cx, cy, cw, ch] = cropFractions(c)
  return [r4(clamp01((x - cx) / cw)), r4(clamp01((y - cy) / ch))]
}

/** Whether a frame point is inside the crop. */
export function inCrop(x: number, y: number, c: RecordingCrop) {
  const [cx, cy, cw, ch] = cropFractions(c)
  return x >= cx - 1e-9 && x <= cx + cw + 1e-9 && y >= cy - 1e-9 && y <= cy + ch + 1e-9
}

/** A frame box [x, y, w, h] as the part of it inside the cropped picture; [0, 0, 0, 0] when none of it is. */
export function cropBox(
  box: readonly [number, number, number, number],
  c: RecordingCrop,
): [number, number, number, number] {
  const [cx, cy, cw, ch] = cropFractions(c)
  const x0 = clamp01((box[0] - cx) / cw)
  const y0 = clamp01((box[1] - cy) / ch)
  const x1 = clamp01((box[0] + box[2] - cx) / cw)
  const y1 = clamp01((box[1] + box[3] - cy) / ch)
  // Rounded outwards (the corner down, the far edge up) so an area never covers less than it did; inside the frame.
  // (A hair of slack, so 0.1 that arrives as 0.09999999999999998 stays 0.1.)
  const down = (n: number) => Math.floor(n * 1e4 + 1e-6) / 1e4
  const up = (n: number) => Math.ceil(n * 1e4 - 1e-6) / 1e4
  const x = down(x0)
  const y = down(y0)
  const w = Math.min(up(x1 - x), r4(1 - x))
  const h = Math.min(up(y1 - y), r4(1 - y))
  if (x1 - x0 <= 1e-6 || y1 - y0 <= 1e-6) return [0, 0, 0, 0]
  return [x, y, r4(w), r4(h)]
}

/**
 * Hidden areas in the cropped picture: every key's box cut to the crop (a key outside it hides nothing, as a
 * zero-size key does). An area that is never inside the crop is left out.
 */
export function cropRedact(
  entries: readonly RedactEntry[],
  c: RecordingCrop | null | undefined,
): RedactEntry[] {
  if (!c) return [...entries]
  return entries.flatMap((e) => {
    const boxes = e.boxes.map(
      ([t, x, y, w, h]) => [t, ...cropBox([x, y, w, h], c)] as [number, number, number, number, number],
    )
    return boxes.some((k) => k[3] > 0 && k[4] > 0) ? [{ ...e, boxes }] : []
  })
}

/**
 * The pointer trace in the cropped picture: the cursor held at the edge while it's outside, clicks outside dropped,
 * typing, focus and target boxes cut to the crop (dropped when nothing is left), hidden areas as cropRedact.
 */
export function cropTrace(trace: Trace, c: RecordingCrop | null | undefined): Trace {
  if (!c) return trace
  const events: Trace['events'] = []
  for (const e of trace.events) {
    if (e.kind === 'click') {
      if (!inCrop(e.x, e.y, c)) continue
      const [x, y] = cropPoint(e.x, e.y, c)
      events.push({
        ...e,
        x,
        y,
        ...(e.target ? { target: { ...e.target, box: cropBox(e.target.box, c) } } : {}),
      })
    } else if (e.kind === 'type' || e.kind === 'focus') {
      const box = cropBox(e.box, c)
      if (box[2] > 0 && box[3] > 0) events.push({ ...e, box })
    } else if (e.kind === 'drag') {
      if (!inCrop(...e.from, c) && !inCrop(...e.to, c)) continue
      events.push({ ...e, from: cropPoint(...e.from, c), to: cropPoint(...e.to, c) })
    } else events.push(e)
  }
  return {
    ...trace,
    frame: { ...trace.frame, width: c.width, height: c.height },
    moves: trace.moves.map(([t, x, y]) => [t, ...cropPoint(x, y, c)] as [number, number, number]),
    events,
    redact: cropRedact(trace.redact, c),
  }
}
