// What an uploaded file really is (plan v2 §9, §14 rule 25): decided from its bytes, never from its name or the
// declared type. Images are checked for size (40 megapixels at most); fonts and SVGs have their own caps.
import { inspectMp4, Mp4Error } from './mp4.js'

export type MediaKind = 'image' | 'svg' | 'video' | 'font'

export interface Classified {
  kind: MediaKind
  ext: 'png' | 'jpg' | 'webp' | 'svg' | 'mp4' | 'woff2' | 'woff' | 'ttf' | 'otf'
  mime: string
  width: number | null
  height: number | null
  durationSec: number | null
}

export class MediaError extends Error {}

export const LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  imagePixels: 40_000_000,
  svgBytes: 1024 * 1024,
  fontBytes: 2 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  videoSeconds: 120,
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const u32 = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)

function jpegSize(b: Uint8Array): [number, number] | null {
  let o = 2
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null
    const marker = b[o + 1] ?? 0
    const len = u16(b, o + 2)
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return [u16(b, o + 7), u16(b, o + 5)]
    o += 2 + len
  }
  return null
}

function webpSize(b: Uint8Array): [number, number] | null {
  const chunk = ascii(b, 12, 16)
  if (chunk === 'VP8 ') return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff]
  if (chunk === 'VP8L') {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1]
  return null
}

function image(
  ext: 'png' | 'jpg' | 'webp',
  mime: string,
  size: [number, number] | null,
  bytes: number,
): Classified {
  if (!size || !(size[0] > 0 && size[1] > 0)) throw new MediaError("The image couldn't be read.")
  if (bytes > LIMITS.imageBytes) throw new MediaError('Images must be 5 MB or smaller.')
  if (size[0] * size[1] > LIMITS.imagePixels) throw new MediaError('Images must be 40 megapixels or smaller.')
  return { kind: 'image', ext, mime, width: size[0], height: size[1], durationSec: null }
}

/** Classifies a whole file. Videos are checked fully (length, codecs); `head` mode only sniffs the type. */
export function classify(b: Uint8Array, opts: { head?: boolean } = {}): Classified {
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG')
    return image(
      'png',
      'image/png',
      ascii(b, 12, 16) === 'IHDR' ? [u32(b, 16), u32(b, 20)] : null,
      b.byteLength,
    )
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return image('jpg', 'image/jpeg', jpegSize(b), b.byteLength)
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return image('webp', 'image/webp', webpSize(b), b.byteLength)
  const font = (ext: 'woff2' | 'woff' | 'ttf' | 'otf', mime: string): Classified => {
    if (b.byteLength > LIMITS.fontBytes) throw new MediaError('Fonts must be 2 MB or smaller.')
    return { kind: 'font', ext, mime, width: null, height: null, durationSec: null }
  }
  const magic = ascii(b, 0, 4)
  if (magic === 'wOF2') return font('woff2', 'font/woff2')
  if (magic === 'wOFF') return font('woff', 'font/woff')
  if (magic === 'OTTO') return font('otf', 'font/otf')
  if (u32(b, 0) === 0x00010000 || magic === 'true') return font('ttf', 'font/ttf')
  if (ascii(b, 4, 8) === 'ftyp') {
    if (b.byteLength > LIMITS.videoBytes) throw new MediaError('Video clips must be 100 MB or smaller.')
    if (opts.head)
      return { kind: 'video', ext: 'mp4', mime: 'video/mp4', width: null, height: null, durationSec: null }
    let info
    try {
      info = inspectMp4(b)
    } catch (e) {
      throw new MediaError(
        `The MP4 couldn't be read: ${e instanceof Mp4Error ? e.message : 'unknown error'}.`,
      )
    }
    if (info.videoCodec !== 'avc1' && info.videoCodec !== 'avc3')
      throw new MediaError(`Video clips must be H.264 (this one is ${info.videoCodec || 'unknown'}).`)
    if (info.audioCodec && info.audioCodec !== 'mp4a')
      throw new MediaError(`Audio must be AAC or none (this clip has ${info.audioCodec}).`)
    if (!(info.durationSec > 0) || info.durationSec > LIMITS.videoSeconds + 0.5)
      throw new MediaError('Video clips must be 2 minutes or shorter.')
    if (!(info.width > 0 && info.height > 0) || info.width > 4096 || info.height > 4096)
      throw new MediaError('Video clips must be at most 4096 pixels on each side.')
    return {
      kind: 'video',
      ext: 'mp4',
      mime: 'video/mp4',
      width: info.width,
      height: info.height,
      durationSec: info.durationSec,
    }
  }
  const head = new TextDecoder()
    .decode(b.subarray(0, 2048))
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    if (b.byteLength > LIMITS.svgBytes) throw new MediaError('SVGs must be 1 MB or smaller.')
    return { kind: 'svg', ext: 'svg', mime: 'image/svg+xml', width: null, height: null, durationSec: null }
  }
  throw new MediaError('Upload PNG, JPEG, WebP or SVG images, MP4 clips, or WOFF2, TTF or OTF fonts.')
}
