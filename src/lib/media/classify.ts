// What an uploaded file really is (plan v2 §9, §14 rule 25): decided from its bytes, never from its name or the
// declared type. Images are checked for size (40 megapixels at most); fonts, SVGs, clips, audio and PDFs have their own caps.
import { ascii, AudioError, sniffAudio, u16le, u32 } from './audio.js'
import { inspectMp4, Mp4Error } from './mp4.js'
import { inspectWebm, isEbml, WebmError } from './webm.js'

export const MEDIA_KINDS = ['image', 'svg', 'video', 'font', 'audio', 'pdf'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export interface Classified {
  kind: MediaKind
  ext:
    | 'png'
    | 'jpg'
    | 'webp'
    | 'svg'
    | 'mp4'
    | 'woff2'
    | 'woff'
    | 'ttf'
    | 'otf'
    | 'mp3'
    | 'm4a'
    | 'wav'
    | 'ogg'
    | 'webm'
    | 'pdf'
  mime: string
  width: number | null
  height: number | null
  durationSec: number | null
  /** MP4 timing facts for a video (stored in meta.json), so a clip can be judged as a recording later. */
  mp4?: Mp4Facts
}

export interface Mp4Facts {
  fps: number
  cfr: boolean
  maxKeyframeGapSec: number
  sizeChanges: boolean
  fastStart: boolean
}

export class MediaError extends Error {}

export const LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  imagePixels: 40_000_000,
  svgBytes: 1024 * 1024,
  fontBytes: 2 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  videoSeconds: 120,
  audioBytes: 50 * 1024 * 1024,
  audioSeconds: 600,
  pdfBytes: 20 * 1024 * 1024,
}

/** A screen recording's limits (screen-recording plan §4.2); the UI, CLI and docs import these, never copies. */
export const RECORDING_LIMITS = {
  bytes: 150 * 1024 * 1024,
  seconds: 300,
  maxSide: 4096,
  minFps: 24,
  maxFps: 30,
  maxKeyframeGapSec: 2,
} as const

/** What to run when a recording was made by a script rather than converted by the app. */
export const RECORDING_FFMPEG_HINT =
  'ffmpeg -i in.mov -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -g 30 -keyint_min 30 -r 30 -crf 20 -movflags +faststart -an out.mp4'

const convert = `The app converts recordings for you; if you uploaded from a script, run: ${RECORDING_FFMPEG_HINT}`

/** A screen recording's rules over its MP4 facts: one message per rule, each saying what to do. */
function checkRecording(info: ReturnType<typeof inspectMp4>) {
  const v = info.video
  // Structure first: a fragmented file's moov has no samples, so its length would read as zero.
  if (info.fragmented)
    throw new MediaError(`This recording is a fragmented MP4, which can't be seeked reliably. ${convert}`)
  if (!info.fastStart)
    throw new MediaError(`This recording isn't fast start (its index is at the end of the file). ${convert}`)
  if (!(info.durationSec > 0) || info.durationSec > RECORDING_LIMITS.seconds + 0.5)
    throw new MediaError('Screen recordings must be 5 minutes or shorter. Trim it, or record a shorter take.')
  if (
    !(info.width > 0 && info.height > 0) ||
    info.width > RECORDING_LIMITS.maxSide ||
    info.height > RECORDING_LIMITS.maxSide
  )
    throw new MediaError(
      `Screen recordings must be at most ${RECORDING_LIMITS.maxSide} pixels on each side. ${convert}`,
    )
  if (!v || v.sizeChanges)
    throw new MediaError(
      `This recording changes picture size partway through, which doesn't play reliably. ${convert}`,
    )
  const fps = Math.round(v.fps * 100) / 100
  if (!v.cfr || v.fps < RECORDING_LIMITS.minFps - 0.1 || v.fps > RECORDING_LIMITS.maxFps + 0.1)
    throw new MediaError(
      `This recording needs a constant ${RECORDING_LIMITS.minFps} to ${RECORDING_LIMITS.maxFps} frames per second (it has ${v.cfr ? `${fps} fps` : 'a variable frame rate'}). ${convert}`,
    )
  if (v.maxKeyframeGapSec > RECORDING_LIMITS.maxKeyframeGapSec + 1e-6)
    throw new MediaError(
      `This recording needs a keyframe every second (its longest gap is ${Math.round(v.maxKeyframeGapSec * 10) / 10} s). ${convert}`,
    )
}

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
} as const

function audio(ext: keyof typeof AUDIO_MIME, durationSec: number | null, bytes: number): Classified {
  if (bytes > LIMITS.audioBytes) throw new MediaError('Audio files must be 50 MB or smaller.')
  if (durationSec !== null && durationSec > LIMITS.audioSeconds + 0.5)
    throw new MediaError('Audio files must be 10 minutes or shorter.')
  const d =
    durationSec !== null && Number.isFinite(durationSec) ? Math.round(durationSec * 1000) / 1000 : null
  return { kind: 'audio', ext, mime: AUDIO_MIME[ext], width: null, height: null, durationSec: d }
}

const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
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

/**
 * Classifies a whole file. Videos are checked fully (length, codecs); `head` mode only sniffs the type. With the
 * screen-recording role an MP4 is held to RECORDING_LIMITS instead of the clip limits.
 */
export function classify(b: Uint8Array, opts: { head?: boolean; role?: string | null } = {}): Classified {
  const recording = opts.role === 'screen-recording'
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
  // A PDF is reference material for the agent (facts, wording), never shown in the video.
  if (ascii(b, 0, 5) === '%PDF-') {
    if (b.byteLength > LIMITS.pdfBytes) throw new MediaError('PDFs must be 20 MB or smaller.')
    return { kind: 'pdf', ext: 'pdf', mime: 'application/pdf', width: null, height: null, durationSec: null }
  }
  if (magic === 'wOF2') return font('woff2', 'font/woff2')
  if (magic === 'wOFF') return font('woff', 'font/woff')
  if (magic === 'OTTO') return font('otf', 'font/otf')
  if (u32(b, 0) === 0x00010000 || magic === 'true') return font('ttf', 'font/ttf')
  if (ascii(b, 4, 8) === 'ftyp') {
    if (recording && b.byteLength > RECORDING_LIMITS.bytes)
      throw new MediaError('Screen recordings must be 150 MB or smaller.')
    if (!recording && b.byteLength > LIMITS.videoBytes)
      throw new MediaError('Video clips must be 100 MB or smaller.')
    if (opts.head)
      return { kind: 'video', ext: 'mp4', mime: 'video/mp4', width: null, height: null, durationSec: null }
    let info
    try {
      info = inspectMp4(b, { audioOnly: true })
    } catch (e) {
      throw new MediaError(
        `The MP4 couldn't be read: ${e instanceof Mp4Error ? e.message : 'unknown error'}.`,
      )
    }
    // No video track: M4A (AAC) audio. A clip with sound stays a video.
    if (!info.videoCodec && recording) throw new MediaError('A screen recording must be a video (H.264 MP4).')
    if (!info.videoCodec) {
      if (!info.audioCodec) throw new MediaError('The MP4 has no video or audio track.')
      if (info.audioCodec !== 'mp4a')
        throw new MediaError(`M4A audio must be AAC (this file has ${info.audioCodec}).`)
      return audio('m4a', info.durationSec > 0 ? info.durationSec : null, b.byteLength)
    }
    if (info.videoCodec !== 'avc1' && info.videoCodec !== 'avc3')
      throw new MediaError(
        recording
          ? `Screen recordings must be H.264 (this one is ${info.videoCodec || 'unknown'}). ${convert}`
          : `Video clips must be H.264 (this one is ${info.videoCodec || 'unknown'}).`,
      )
    if (info.audioCodec && info.audioCodec !== 'mp4a')
      throw new MediaError(`Audio must be AAC or none (this clip has ${info.audioCodec}).`)
    const mp4: Mp4Facts | undefined = info.video
      ? {
          fps: info.video.fps,
          cfr: info.video.cfr,
          maxKeyframeGapSec: info.video.maxKeyframeGapSec,
          sizeChanges: info.video.sizeChanges,
          fastStart: info.fastStart,
        }
      : undefined
    if (recording) {
      checkRecording(info)
      return {
        kind: 'video',
        ext: 'mp4',
        mime: 'video/mp4',
        width: info.width,
        height: info.height,
        durationSec: info.durationSec,
        ...(mp4 ? { mp4 } : {}),
      }
    }
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
      ...(mp4 ? { mp4 } : {}),
    }
  }
  // WebM/Matroska is only ever audio here (one Opus or Vorbis track); a video track refuses the file.
  if (isEbml(b)) {
    if (b.byteLength > LIMITS.audioBytes) throw new MediaError('Audio files must be 50 MB or smaller.')
    let info
    try {
      info = inspectWebm(b)
    } catch (e) {
      throw new MediaError(e instanceof WebmError ? e.message : "The WebM file couldn't be read.")
    }
    return audio('webm', info.durationSec, b.byteLength)
  }
  let sound
  try {
    sound = sniffAudio(b)
  } catch (e) {
    throw new MediaError(e instanceof AudioError ? e.message : "The audio file couldn't be read.")
  }
  if (sound) return audio(sound.format, sound.durationSec, b.byteLength)
  const head = new TextDecoder()
    .decode(b.subarray(0, 2048))
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    if (b.byteLength > LIMITS.svgBytes) throw new MediaError('SVGs must be 1 MB or smaller.')
    return { kind: 'svg', ext: 'svg', mime: 'image/svg+xml', width: null, height: null, durationSec: null }
  }
  throw new MediaError(
    'Upload PNG, JPEG, WebP or SVG images, MP4 clips, MP3, M4A, WAV, Ogg or WebM audio, WOFF2, TTF or OTF fonts, or PDFs.',
  )
}
