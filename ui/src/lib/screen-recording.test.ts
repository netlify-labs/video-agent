// The demo's browser side (screen-recording plan §4.3–4.5; va-rsk5.4.1, 4.2, 4.7), pure parts: which way this browser
// records (D4), the encoder settings, which files need converting, and the setup's request (the server's length
// formula, boxes and trim that the server accepts).
import { describe, expect, it } from 'vitest'
import { defaultLength, recordingInput } from './demo-setup'
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
    // src/domain/demo-recording.ts demoDuration (not imported: it pulls the server into the UI's typecheck).
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
})
