// Demo setup (screen-recording plan §4.4; va-rsk5.4.2): what the setup screen sends. Boxes are fractions of the frame
// with a span in seconds of the recording; a trim that keeps the whole recording isn't sent, nor a crop that keeps
// the whole picture.
import { CROP_MIN_FRACTION, CROP_MIN_PX } from '../../../server/lib/recording-crop'

export interface SetupBox {
  id: string
  x: number
  y: number
  w: number
  h: number
  start: number
  end: number
  /** blur (the default) or solid. */
  style?: 'blur' | 'solid'
}

/** The server's default length (app/server/domain/demo-recording.ts demoDuration): about 0.4 of what's used, 20 to 90 s. */
export const defaultLength = (usedSec: number) => Math.min(90, Math.max(20, Math.round(usedSec * 0.4)))

export const MIN_TRIM = 2
const r3 = (n: number) => Math.round(n * 1000) / 1000
const floor3 = (n: number) => Math.floor(n * 1000) / 1000
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** A box kept inside the frame, at least 1% each way. */
export function fitBox(b: SetupBox): SetupBox {
  const w = Math.min(1, Math.max(0.01, b.w))
  const h = Math.min(1, Math.max(0.01, b.h))
  return { ...b, w, h, x: Math.min(1 - w, clamp01(b.x)), y: Math.min(1 - h, clamp01(b.y)) }
}

/** The crop on the setup screen: [x, y, w, h] as fractions of the frame. */
export type CropBox = [number, number, number, number]
export const WHOLE: CropBox = [0, 0, 1, 1]
/** Where a crop is grabbed: a corner or an edge (compass points), or the whole box. */
export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'
export const CROP_HANDLES: Exclude<CropHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The least a crop may keep, each way, as fractions of this frame (the server's rule: a tenth and 160 px). */
export const cropMin = (frame: { width: number | null; height: number | null }): [number, number] => [
  Math.min(1, Math.max(CROP_MIN_FRACTION, CROP_MIN_PX / (frame.width ?? 1920))),
  Math.min(1, Math.max(CROP_MIN_FRACTION, CROP_MIN_PX / (frame.height ?? 1080))),
]

export const isWhole = (c: CropBox) => c[0] <= 0.002 && c[1] <= 0.002 && c[2] >= 0.996 && c[3] >= 0.996

/** A crop after its handle moved by (dx, dy): inside the frame, never smaller than `min`. */
export function dragCrop(
  c: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  min: [number, number],
): CropBox {
  let [x0, y0, x1, y1] = [c[0], c[1], c[0] + c[2], c[1] + c[3]]
  if (handle === 'move') {
    const mx = Math.min(1 - x1, Math.max(-x0, dx))
    const my = Math.min(1 - y1, Math.max(-y0, dy))
    return [x0 + mx, y0 + my, c[2], c[3]]
  }
  if (handle.includes('w')) x0 = Math.min(x1 - min[0], Math.max(0, x0 + dx))
  if (handle.includes('e')) x1 = Math.max(x0 + min[0], Math.min(1, x1 + dx))
  if (handle.includes('n')) y0 = Math.min(y1 - min[1], Math.max(0, y0 + dy))
  if (handle.includes('s')) y1 = Math.max(y0 + min[1], Math.min(1, y1 + dy))
  return [x0, y0, x1 - x0, y1 - y0]
}

/** A crop drawn from one corner to another, grown to `min` and kept inside the frame. */
export function drawCrop(ax: number, ay: number, bx: number, by: number, min: [number, number]): CropBox {
  const w = Math.max(min[0], Math.abs(bx - ax))
  const h = Math.max(min[1], Math.abs(by - ay))
  return [
    Math.min(1 - w, Math.max(0, Math.min(ax, bx))),
    Math.min(1 - h, Math.max(0, Math.min(ay, by))),
    w,
    h,
  ]
}

/** Where playback starts: where it is when that's inside the trim (and not at its end), else the trim's start. */
export const playFrom = (t: number, trim: [number, number]) =>
  t >= trim[0] - 0.05 && t < trim[1] - 0.1 ? t : trim[0]

export interface SetupState {
  mediaId: string
  duration: number
  trim: [number, number]
  boxes: SetupBox[]
  /** The whole frame when left out. */
  crop?: CropBox | null
}

/** A recording set up and added to the New video form: Create video sends `input` as the request's `recording`. */
export interface AttachedRecording {
  input: ReturnType<typeof recordingInput> & { privacy?: true; hideStrings?: string[] }
  filename: string
  poster: string | null
  /** Seconds of the recording used, after the trim. */
  usedSec: number
  cropped: boolean
  /** Anything hidden (boxes, privacy mode, hide words): the video starts private. */
  hides: boolean
}

/** The crop as it's sent: to 4 places, inside the frame. */
function cropInput(c: CropBox): CropBox {
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4
  const x = r4(clamp01(c[0]))
  const y = r4(clamp01(c[1]))
  return [x, y, Math.min(r4(c[2]), r4(1 - x)), Math.min(r4(c[3]), r4(1 - y))]
}

/** The `recording` field of POST /api/v1/videos. */
export function recordingInput(s: SetupState) {
  const whole = s.trim[0] <= 0.05 && s.trim[1] >= s.duration - 0.05
  return {
    mediaId: s.mediaId,
    ...(s.crop && !isWhole(s.crop) ? { crop: cropInput(s.crop) } : {}),
    ...(whole
      ? {}
      : { trim: [r3(s.trim[0]), Math.min(r3(s.trim[1]), floor3(s.duration))] as [number, number] }),
    ...(s.boxes.length
      ? {
          redact: s.boxes.map((b) => {
            // Down for the corner, and the size capped, so rounding never pushes a box past the frame.
            const x = floor3(b.x)
            const y = floor3(b.y)
            return {
              start: r3(b.start),
              end: r3(Math.max(b.end, b.start + 0.1)),
              ...(b.style === 'solid' ? { style: 'solid' as const } : {}),
              box: [x, y, Math.min(r3(b.w), floor3(1 - x)), Math.min(r3(b.h), floor3(1 - y))] as [
                number,
                number,
                number,
                number,
              ],
            }
          }),
        }
      : {}),
  }
}
