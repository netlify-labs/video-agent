// classify with the screen-recording role (screen-recording plan §4.2): H.264, AAC or no audio, at most 5 minutes,
// 150 MB and 4096 px, a constant 24-30 fps, one picture size, a keyframe at least every 2 s, fast start, not
// fragmented; each refusal has its own message, and the format ones end with RECORDING_FFMPEG_HINT. Without the role
// the clip limits apply unchanged. Fixtures are app/test/fixtures/mp4/ (make.sh); frame rates, length and a second
// sample entry are patched in memory. One JSON line per case.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classify, MediaError, RECORDING_FFMPEG_HINT, RECORDING_LIMITS } from '../server/lib/media/classify.js'

const mp4 = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/mp4/${name}`, import.meta.url)))
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

/** Offsets of the boxes along `path` (ancestors first); empty when the first box isn't found. */
function chain(b: Uint8Array, path: string[], start = 0, end = b.byteLength): { at: number; size: number }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let off = start; off + 8 <= end;) {
    const size = v.getUint32(off)
    if (String.fromCharCode(...b.subarray(off + 4, off + 8)) === path[0]) {
      const here = { at: off, size }
      return path.length > 1 ? [here, ...chain(b, path.slice(1), off + 8, off + size)] : [here]
    }
    off += size
  }
  return []
}

/** gop30.mp4 with the video track's timescale scaled: x2 doubles the frame rate, x0.5 halves it. */
function withFps(factor: number) {
  const b = mp4('gop30.mp4')
  const mdhd = chain(b, ['moov', 'trak', 'mdia', 'mdhd']).at(-1)
  if (!mdhd) throw new Error('no mdhd')
  const v = new DataView(b.buffer)
  v.setUint32(mdhd.at + 20, v.getUint32(mdhd.at + 20) * factor)
  return b
}

/** gop30.mp4 claiming a movie duration (mvhd) of `seconds`. */
function withDuration(seconds: number) {
  const b = mp4('gop30.mp4')
  const mvhd = chain(b, ['moov', 'mvhd']).at(-1)
  if (!mvhd) throw new Error('no mvhd')
  const v = new DataView(b.buffer)
  v.setUint32(mvhd.at + 24, Math.round(seconds * v.getUint32(mvhd.at + 20)))
  return b
}

/** gop30.mp4 with its avc1 entry duplicated at another width (the moov is parsed only, so offsets don't matter). */
function twoEntries() {
  const b = mp4('gop30.mp4')
  const boxes = chain(b, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
  const stsd = boxes.at(-1)
  if (!stsd) throw new Error('no stsd')
  const v = new DataView(b.buffer)
  const entryAt = stsd.at + 16
  const size = v.getUint32(entryAt)
  const entry = b.slice(entryAt, entryAt + size)
  new DataView(entry.buffer).setUint16(32, v.getUint16(entryAt + 32) + 2)
  const out = new Uint8Array(b.byteLength + size)
  out.set(b.subarray(0, entryAt + size))
  out.set(entry, entryAt + size)
  out.set(b.subarray(entryAt + size), entryAt + 2 * size)
  const w = new DataView(out.buffer)
  for (const box of boxes) w.setUint32(box.at, box.size + size)
  w.setUint32(stsd.at + 12, 2)
  return out
}

const role = { role: 'screen-recording' }
const refusal = (c: string, bytes: Uint8Array) => {
  try {
    classify(bytes, role)
    return null
  } catch (e) {
    expect(e).toBeInstanceOf(MediaError)
    const message = (e as Error).message
    log({ case: c, message })
    return message
  }
}

describe('classify, screen-recording role', () => {
  it('accepts a normalized recording and an all-intra one, with their MP4 facts', () => {
    for (const name of ['gop30.mp4', 'intra.mp4']) {
      const c = classify(mp4(name), role)
      log({ case: name, mp4: c.mp4 })
      expect(c).toMatchObject({ kind: 'video', ext: 'mp4', width: 320, height: 180 })
      expect(c.mp4).toMatchObject({ fps: 30, cfr: true, sizeChanges: false, fastStart: true })
    }
  })

  it.each([
    ['long keyframe gap', () => mp4('gop300.mp4'), /keyframe every second \(its longest gap is 3 s\)/],
    ['fragmented', () => mp4('fragmented.mp4'), /fragmented MP4/],
    ['not fast start', () => mp4('slowstart.mp4'), /isn't fast start/],
    [
      'variable frame rate',
      () => mp4('vfr.mp4'),
      /constant 24 to 30 frames per second \(it has a variable frame rate\)/,
    ],
    ['60 fps', () => withFps(2), /constant 24 to 30 frames per second \(it has 60 fps\)/],
    ['15 fps', () => withFps(0.5), /constant 24 to 30 frames per second \(it has 15 fps\)/],
    ['size change', twoEntries, /changes picture size partway/],
    ['HEVC', () => fixture('hevc.mp4'), /Screen recordings must be H\.264/],
  ] as const)('refuses %s with its own message and the ffmpeg command', (c, make, message) => {
    const m = refusal(c, make())
    expect(m).toMatch(message)
    expect(m?.endsWith(RECORDING_FFMPEG_HINT)).toBe(true)
  })

  it('refuses more than 5 minutes, audio only, and more than 150 MB', () => {
    expect(refusal('5 min + 1 s', withDuration(RECORDING_LIMITS.seconds + 1))).toBe(
      'Screen recordings must be 5 minutes or shorter. Trim it, or record a shorter take.',
    )
    expect(classify(withDuration(RECORDING_LIMITS.seconds), role).kind).toBe('video')
    expect(refusal('audio only', mp4('audio.m4a'))).toBe('A screen recording must be a video (H.264 MP4).')
    const big = new Uint8Array(RECORDING_LIMITS.bytes + 1)
    big.set(mp4('gop30.mp4').subarray(0, 32))
    expect(refusal('150 MB + 1', big)).toBe('Screen recordings must be 150 MB or smaller.')
  })

  it('leaves the clip limits alone without the role (2 minutes, and recording-only rules off)', () => {
    expect(() => classify(withDuration(121))).toThrow('Video clips must be 2 minutes or shorter.')
    expect(classify(mp4('gop300.mp4')).kind).toBe('video')
    expect(classify(mp4('vfr.mp4')).mp4).toMatchObject({ cfr: false })
  })
})
