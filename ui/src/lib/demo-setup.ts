// Demo setup (screen-recording plan §4.4; va-rsk5.4.2): what the setup screen sends. Boxes are fractions of the frame
// with a span in seconds of the recording; a trim that keeps the whole recording isn't sent.

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

/** The server's default length (src/domain/demo-recording.ts demoDuration): about 0.4 of what's used, 20 to 90 s. */
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

export interface SetupState {
  mediaId: string
  duration: number
  trim: [number, number]
  boxes: SetupBox[]
}

/** The `recording` field of POST /api/v1/videos. */
export function recordingInput(s: SetupState) {
  const whole = s.trim[0] <= 0.05 && s.trim[1] >= s.duration - 0.05
  return {
    mediaId: s.mediaId,
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
