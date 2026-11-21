// Record screen on New video: the edits made in setup (trim, crop, boxes over private things) are applied to the
// recording in the browser, before it uploads, so the file in the library is the edited clip and what was cut or
// hidden never leaves this device. Mediabunny in a module Worker (./recording-bake.worker.ts), in the same format as
// a conversion (./recording-convert.ts).
import { cropFromFractions } from '../../../server/lib/recording-crop'
import { ConvertError } from './recording-convert'

/** A box to hide: fractions of the whole frame, seconds of the recording. */
export interface BakeBox {
  x: number
  y: number
  w: number
  h: number
  start: number
  end: number
  solid: boolean
}

export interface BakeEdits {
  /** Seconds to keep, [in, out]; null for all of it. */
  trim: [number, number] | null
  /** The part of the picture to keep, in source pixels; null for all of it. */
  crop: { left: number; top: number; width: number; height: number } | null
  boxes: BakeBox[]
}

export type BakeMessage =
  | { type: 'progress'; progress: number }
  | { type: 'done'; file: File }
  | { type: 'error'; message: string; unsupported?: boolean }

/** What setup sends as `recording` (trim, crop and redact of the whole frame), as edits to apply to a file this size. */
export function bakeEdits(
  input: {
    trim?: [number, number]
    crop?: [number, number, number, number]
    redact?: { start: number; end: number; box: [number, number, number, number]; style?: 'solid' }[]
  },
  frame: { width: number; height: number },
): BakeEdits {
  const c = input.crop ? cropFromFractions(input.crop, frame.width, frame.height) : null
  return {
    trim: input.trim ?? null,
    crop: c ? { left: c.x, top: c.y, width: c.width, height: c.height } : null,
    boxes: (input.redact ?? []).map((r) => ({
      x: r.box[0],
      y: r.box[1],
      w: r.box[2],
      h: r.box[3],
      start: r.start,
      end: r.end,
      solid: r.style === 'solid',
    })),
  }
}

export const hasEdits = (e: BakeEdits) => Boolean(e.trim ?? e.crop) || e.boxes.length > 0

/**
 * A box as pixels of the output frame at source time `t`: [x, y, w, h], or null when it isn't showing then or lies
 * outside the crop. `out` is the output's size; `crop` and `frame` say which part of the source it shows.
 */
export function boxRect(
  b: BakeBox,
  t: number,
  frame: { width: number; height: number },
  crop: BakeEdits['crop'],
  out: { width: number; height: number },
): [number, number, number, number] | null {
  if (t < b.start - 1e-6 || t >= b.end - 1e-6) return null
  const c = crop ?? { left: 0, top: 0, width: frame.width, height: frame.height }
  const kx = out.width / c.width
  const ky = out.height / c.height
  // Outwards to whole pixels, so a box never covers less than was drawn (with a hair of slack for 768.0000001).
  const down = (n: number) => Math.floor(n + 1e-6)
  const up = (n: number) => Math.ceil(n - 1e-6)
  const x0 = Math.max(0, down((b.x * frame.width - c.left) * kx))
  const y0 = Math.max(0, down((b.y * frame.height - c.top) * ky))
  const x1 = Math.min(out.width, up(((b.x + b.w) * frame.width - c.left) * kx))
  const y1 = Math.min(out.height, up(((b.y + b.h) * frame.height - c.top) * ky))
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null
}

/** Applies the edits to `file` in a Worker and resolves with the edited MP4. */
export function bakeRecording(
  file: File,
  edits: BakeEdits,
  opts: { onProgress?: (p: number) => void } = {},
): Promise<File> {
  const worker = new Worker(new URL('./recording-bake.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<File>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<BakeMessage>) => {
      const m = e.data
      if (m.type === 'progress') opts.onProgress?.(m.progress)
      else {
        worker.terminate()
        if (m.type === 'done') resolve(m.file)
        else reject(new ConvertError(m.message, m.unsupported))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new ConvertError(e.message || "The edits couldn't be applied."))
    }
    worker.postMessage({ file, edits })
  })
}
