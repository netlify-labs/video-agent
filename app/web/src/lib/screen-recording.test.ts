// The demo's browser side (screen-recording plan §4.3–4.5; va-rsk5.4.1, 4.2, 4.7), pure parts: which way this browser
// records (D4), the encoder settings, which files need converting, and the setup's request (the server's length
// formula, boxes and trim that the server accepts).
import { describe, expect, it } from 'vitest'
import {
  cropMin,
  defaultLength,
  dragCrop,
  drawCrop,
  isWhole,
  playFrom,
  recordingInput,
  WHOLE,
  type CropBox,
} from './demo-setup'
import { bakeEdits, boxRect, hasEdits } from './recording-bake'
import { convertSettings, needsConversion, type VideoFacts } from './recording-convert'
import { bitrateFor, captureMode, encodedSize } from './screen-capture'

describe('capture', () => {
  it('records the track where Mediabunny can take it (Chromium), else through a canvas, else not at all', () => {
    expect(captureMode({ displayMedia: true, avc: true, trackProcessor: true })).toBe('track')
    expect(captureMode({ displayMedia: true, avc: true, trackProcessor: false })).toBe('canvas')
    expect(captureMode({ displayMedia: true, avc: false, trackProcessor: true })).toBe('unsupported')
    expect(captureMode({ displayMedia: false, avc: true, trackProcessor: true })).toBe('unsupported')
  })

  it('the §4.3 bitrate and size: about 3.9 Mbps at 1440p, 2 to 4 Mbps, at most 2560 wide, even sides', () => {
    expect(bitrateFor(2560, 1440)).toBe(3_870_720)
    expect(bitrateFor(320, 180)).toBe(2_000_000)
    expect(bitrateFor(2560, 1600)).toBe(4_000_000)
    // Five minutes at the ceiling fit the 150 MB recording limit.
    expect((4e6 / 8) * 300).toBeLessThan(150 * 1024 * 1024)
    expect(encodedSize(3840, 2160)).toEqual({ width: 2560, height: 1440 })
    expect(encodedSize(1281, 721)).toEqual({ width: 1280, height: 720 })
  })
})

describe('conversion', () => {
  const ok: VideoFacts = {
    container: 'mp4',
    codec: 'avc',
    width: 1280,
    height: 720,
    durations: Array.from({ length: 90 }, () => 1 / 30),
    keyframes: [0, 1, 2],
    duration: 3,
  }
  it('a normalized MP4 uploads as is; anything else says why it converts', () => {
    expect(needsConversion(ok)).toBeNull()
    expect(needsConversion({ ...ok, container: 'quicktime' })).toBe('not an MP4')
    expect(needsConversion({ ...ok, codec: 'vp9' })).toBe('not H.264')
    expect(needsConversion({ ...ok, width: 3840, height: 2160 })).toMatch(/wider/)
    expect(needsConversion({ ...ok, durations: [1 / 30, 1 / 60] })).toMatch(/30 fps/)
    expect(needsConversion({ ...ok, keyframes: [0] })).toMatch(/keyframes/)
  })

  it('settings: H.264 at the §4.3 bitrate, a keyframe a second, scaled only when too wide', () => {
    expect(convertSettings(1280, 720)).toEqual({
      codec: 'avc',
      bitrate: bitrateFor(1280, 720),
      keyFrameInterval: 1,
      frameRate: 30,
      forceTranscode: true,
    })
    expect(convertSettings(3840, 2160)).toMatchObject({ width: 2560, height: 1440, fit: 'contain' })
  })
})

describe('setup', () => {
  it('pre-fills the length with the server’s formula', () => {
    // app/server/domain/demo-recording.ts demoDuration (not imported: it pulls the server into the UI's typecheck).
    const cases: [number, number][] = [
      [5, 20],
      [49, 20],
      [50, 20],
      [100, 40],
      [224, 90],
      [226, 90],
      [600, 90],
    ]
    for (const [used, want] of cases) expect(defaultLength(used), String(used)).toBe(want)
  })

  it('sends the trim only when it cuts, and boxes inside the frame', () => {
    expect(recordingInput({ mediaId: 'med_a', duration: 60, trim: [0, 60], boxes: [] })).toEqual({
      mediaId: 'med_a',
    })
    const r = recordingInput({
      mediaId: 'med_a',
      duration: 60.0004,
      trim: [2.34567, 60.0004],
      boxes: [{ id: 'b', x: 0.82049, y: 0.0001, w: 0.17999, h: 0.08, start: 0, end: 60 }],
    })
    expect(r.trim).toEqual([2.346, 60])
    const [x, y, w, h] = r.redact?.[0]?.box ?? [0, 0, 0, 0]
    expect(x + w).toBeLessThanOrEqual(1)
    expect(y + h).toBeLessThanOrEqual(1)
    expect(r.redact?.[0]).toMatchObject({ start: 0, end: 60 })
    // Blur is the default and isn't sent; solid is.
    expect(r.redact?.[0]).not.toHaveProperty('style')
    const solid = recordingInput({
      mediaId: 'med_a',
      duration: 60,
      trim: [0, 60],
      boxes: [{ id: 'b', x: 0.1, y: 0.1, w: 0.2, h: 0.1, start: 0, end: 60, style: 'solid' }],
    })
    expect(solid.redact?.[0]?.style).toBe('solid')
  })

  it('sends the crop only when it cuts, to 4 places and inside the frame', () => {
    const base = { mediaId: 'med_a', duration: 60, trim: [0, 60] as [number, number], boxes: [] }
    expect(recordingInput({ ...base, crop: WHOLE })).toEqual({ mediaId: 'med_a' })
    expect(recordingInput({ ...base, crop: [0.001, 0, 0.998, 1] })).toEqual({ mediaId: 'med_a' })
    expect(recordingInput({ ...base, crop: null })).toEqual({ mediaId: 'med_a' })
    const r = recordingInput({ ...base, crop: [0.123456, 0.2, 0.876549, 0.80004] })
    expect(r.crop).toEqual([0.1235, 0.2, 0.8765, 0.8])
    const [x, y, w, h] = r.crop ?? WHOLE
    expect(x + w).toBeLessThanOrEqual(1)
    expect(y + h).toBeLessThanOrEqual(1)
  })

  it('the crop rectangle: handles resize inside the frame down to the least size; the box moves whole', () => {
    const min = cropMin({ width: 1280, height: 720 })
    // A tenth of the frame, or 160 px when that's more.
    expect(min[0]).toBeCloseTo(0.125)
    expect(min[1]).toBeCloseTo(160 / 720)
    expect(cropMin({ width: 2560, height: 1440 })).toEqual([0.1, 160 / 1440])
    const c: CropBox = [0.2, 0.2, 0.6, 0.6]
    const near = (a: CropBox, b: CropBox) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i] ?? NaN, 6))
    near(dragCrop(c, 'se', 0.1, 0.1, min), [0.2, 0.2, 0.7, 0.7])
    near(dragCrop(c, 'nw', 0.1, -0.1, min), [0.3, 0.1, 0.5, 0.7])
    near(dragCrop(c, 'e', 5, 5, min), [0.2, 0.2, 0.8, 0.6])
    near(dragCrop(c, 'n', 5, -5, min), [0.2, 0, 0.6, 0.8])
    // Never smaller than the least size: the dragged edge stops.
    near(dragCrop(c, 'w', 5, 0, min), [0.8 - min[0], 0.2, min[0], 0.6])
    near(dragCrop(c, 's', 0, -5, min), [0.2, 0.2, 0.6, min[1]])
    // Moving keeps the size and stays inside.
    near(dragCrop(c, 'move', 0.1, -0.05, min), [0.3, 0.15, 0.6, 0.6])
    near(dragCrop(c, 'move', 5, 5, min), [0.4, 0.4, 0.6, 0.6])
    near(dragCrop(c, 'move', -5, -5, min), [0, 0, 0.6, 0.6])
    // Drawing: any two corners; a tiny one grows to the least size, inside the frame.
    near(drawCrop(0.7, 0.8, 0.1, 0.2, min), [0.1, 0.2, 0.6, 0.6])
    near(drawCrop(0.99, 0.99, 1, 1, min), [1 - min[0], 1 - min[1], min[0], min[1]])
    expect(isWhole(WHOLE)).toBe(true)
    expect(isWhole(c)).toBe(false)
  })

  it('playback starts where it is inside the trim, else at its start', () => {
    expect(playFrom(0, [5, 20])).toBe(5)
    expect(playFrom(12.5, [5, 20])).toBe(12.5)
    // At (or just before) the end, and past it: from the start again.
    expect(playFrom(19.95, [5, 20])).toBe(5)
    expect(playFrom(25, [5, 20])).toBe(5)
  })

  it('Record screen: the edits setup made become pixels and seconds of the file', () => {
    const frame = { width: 1280, height: 720 }
    expect(bakeEdits({}, frame)).toEqual({ trim: null, crop: null, boxes: [] })
    expect(hasEdits(bakeEdits({}, frame))).toBe(false)
    const e = bakeEdits(
      {
        trim: [1, 4.5],
        crop: [0.2, 0.2, 0.6, 0.7],
        redact: [{ start: 2, end: 4, box: [0.4, 0.4, 0.2, 0.2], style: 'solid' }],
      },
      frame,
    )
    expect(e.trim).toEqual([1, 4.5])
    expect(e.crop).toEqual({ left: 256, top: 144, width: 768, height: 504 })
    expect(e.boxes).toEqual([{ x: 0.4, y: 0.4, w: 0.2, h: 0.2, start: 2, end: 4, solid: true }])
    expect(hasEdits(e)).toBe(true)
    expect(hasEdits(bakeEdits({ trim: [1, 3] }, frame))).toBe(true)
    const box = e.boxes[0]
    if (!box) throw new Error('no box')
    const out = { width: 768, height: 504 }
    // Inside its span: its place in the cropped picture. Outside it: nothing.
    expect(boxRect(box, 3, frame, e.crop, out)).toEqual([256, 144, 256, 144])
    expect(boxRect(box, 1.9, frame, e.crop, out)).toBeNull()
    expect(boxRect(box, 4, frame, e.crop, out)).toBeNull()
    // Without a crop, and scaled to a smaller output.
    expect(boxRect(box, 3, frame, null, { width: 640, height: 360 })).toEqual([256, 144, 128, 72])
    // Half outside the crop is cut to it; wholly outside is nothing.
    expect(boxRect({ ...box, x: 0.1, w: 0.2 }, 3, frame, e.crop, out)).toEqual([0, 144, 128, 144])
    expect(boxRect({ ...box, x: 0.85, w: 0.1 }, 3, frame, e.crop, out)).toBeNull()
  })
})
