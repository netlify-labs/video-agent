// Audio files known by their bytes: MP3 (MPEG audio frames, with or without an ID3v2 tag), WAV (RIFF/WAVE PCM) and
// Ogg (Vorbis or Opus). MP4 audio (M4A/AAC) is read by mp4.ts. Durations come from headers only (Xing/VBRI or the
// bitrate for MP3, the data chunk for WAV, the last page's granule for Ogg); null when a header doesn't say.

export type AudioFormat = 'mp3' | 'wav' | 'ogg'

export interface AudioInfo {
  format: AudioFormat
  /** Opus or Vorbis, for Ogg. */
  codec: string
  durationSec: number | null
}

export class AudioError extends Error {}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const u32 = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u32le = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0

// ───────── MP3 ─────────

// Kbps by [MPEG-1?][layer 1..3][index].
const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

interface Frame {
  mpeg1: boolean
  layer: number
  bitrate: number
  rate: number
  mono: boolean
  length: number
  samples: number
}

/** An MPEG audio frame header at o, or null. Free-format and reserved values don't count. */
function frameAt(b: Uint8Array, o: number): Frame | null {
  if (o + 4 > b.length || b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xe0) !== 0xe0) return null
  const h1 = b[o + 1] ?? 0
  const h2 = b[o + 2] ?? 0
  const version = (h1 >> 3) & 3
  const layerBits = (h1 >> 1) & 3
  if (version === 1 || layerBits === 0) return null
  const layer = 4 - layerBits
  const mpeg1 = version === 3
  const bitrate = BITRATES[`${mpeg1 ? 1 : 2}-${layer}`]?.[h2 >> 4] ?? 0
  const rate = RATES[version]?.[(h2 >> 2) & 3] ?? 0
  if (!bitrate || !rate) return null
  const pad = (h2 >> 1) & 1
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152
  const length =
    layer === 1
      ? (Math.floor((12 * bitrate * 1000) / rate) + pad) * 4
      : Math.floor(((samples / 8) * bitrate * 1000) / rate) + pad
  return { mpeg1, layer, bitrate, rate, mono: (b[o + 3] ?? 0) >> 6 === 3, length, samples }
}

function mp3(b: Uint8Array): AudioInfo | null {
  let start = 0
  if (ascii(b, 0, 3) === 'ID3') {
    // Syncsafe size, plus the 10-byte header and an optional 10-byte footer.
    const size = ((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0)
    start = 10 + size + ((b[5] ?? 0) & 0x10 ? 10 : 0)
    // Some encoders pad after the tag: look a little further for the first frame.
    const limit = Math.min(b.length - 4, start + 4096)
    while (start < limit && !frameAt(b, start)) start++
  }
  const f = frameAt(b, start)
  if (!f) return null
  // A second frame right after the first, when the file is long enough, so a stray 0xFFE isn't taken for MP3.
  if (start + f.length + 4 <= b.length && !frameAt(b, start + f.length)) return null
  const side = f.mpeg1 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17
  const xing = start + 4 + side
  const tag = ascii(b, xing, xing + 4)
  let frames: number | null = null
  let trim = 0
  if ((tag === 'Xing' || tag === 'Info') && u32(b, xing + 4) & 1) {
    const flags = u32(b, xing + 4)
    frames = u32(b, xing + 8)
    // The LAME tag after the Xing fields holds the encoder delay and padding, which aren't part of the audio.
    const lame =
      xing + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0)
    if (/^(LAME|Lavc|Lavf)/.test(ascii(b, lame, lame + 4)))
      trim =
        ((b[lame + 21] ?? 0) << 4) +
        ((b[lame + 22] ?? 0) >> 4) +
        (((b[lame + 22] ?? 0) & 0xf) << 8) +
        (b[lame + 23] ?? 0)
  } else if (ascii(b, start + 36, start + 40) === 'VBRI') frames = u32(b, start + 36 + 14)
  let end = b.length
  // An ID3v1 tag at the end isn't audio.
  if (end - 128 > start && ascii(b, end - 128, end - 125) === 'TAG') end -= 128
  const durationSec =
    frames !== null && frames > 0
      ? Math.max(0, frames * f.samples - trim) / f.rate
      : ((end - start) * 8) / (f.bitrate * 1000)
  return { format: 'mp3', codec: f.layer === 3 ? 'mp3' : `mp${f.layer}`, durationSec }
}

// ───────── WAV ─────────

function wav(b: Uint8Array): AudioInfo {
  let o = 12
  let byteRate = 0
  let format = 0
  let dataBytes: number | null = null
  for (let n = 0; o + 8 <= b.length && n < 64; n++) {
    const id = ascii(b, o, o + 4)
    const size = u32le(b, o + 4)
    if (id === 'fmt ') {
      format = u16le(b, o + 8)
      byteRate = u32le(b, o + 16)
    } else if (id === 'data') {
      // Streamed WAVs leave the size unset (0 or 0xFFFFFFFF): count what's there.
      const left = b.length - (o + 8)
      dataBytes = size === 0 || size > left ? left : size
      break
    }
    o += 8 + size + (size & 1)
  }
  // PCM, IEEE float or WAVE_FORMAT_EXTENSIBLE (which wraps one of them).
  if (![1, 3, 0xfffe].includes(format))
    throw new AudioError('WAV files must be uncompressed PCM (this one uses another codec).')
  return {
    format: 'wav',
    codec: format === 3 ? 'pcm_float' : 'pcm',
    durationSec: byteRate > 0 && dataBytes !== null ? dataBytes / byteRate : null,
  }
}

// ───────── Ogg ─────────

/** The page at o: header type, granule position (low 53 bits), serial and where its body starts and ends. */
function oggPage(b: Uint8Array, o: number) {
  if (ascii(b, o, o + 4) !== 'OggS' || o + 27 > b.length) return null
  const segments = b[o + 26] ?? 0
  let body = 0
  for (let i = 0; i < segments; i++) body += b[o + 27 + i] ?? 0
  const lo = u32le(b, o + 6)
  const hi = u32le(b, o + 10)
  return {
    type: b[o + 5] ?? 0,
    // Granules past 2^53 samples aren't real audio lengths; -1 (unset) reads as huge and is ignored.
    granule: hi >= 0x200000 ? -1 : hi * 2 ** 32 + lo,
    serial: u32le(b, o + 14),
    bodyStart: o + 27 + segments,
    end: o + 27 + segments + body,
  }
}

function ogg(b: Uint8Array): AudioInfo {
  const first = oggPage(b, 0)
  if (!first) throw new AudioError("The Ogg file couldn't be read.")
  // Every stream opens with a BOS page at the start; any of them being video makes this a video file.
  let codec = ''
  let rate = 0
  let preSkip = 0
  for (let o = 0, n = 0; n < 16; n++) {
    const p = oggPage(b, o)
    if (!p || !(p.type & 0x02)) break
    const head = ascii(b, p.bodyStart, p.bodyStart + 8)
    if (head.startsWith('OpusHead')) {
      if (!codec) {
        codec = 'opus'
        rate = 48000
        preSkip = u16le(b, p.bodyStart + 10)
      }
    } else if (head.startsWith('\x01vorbis')) {
      if (!codec) {
        codec = 'vorbis'
        rate = u32le(b, p.bodyStart + 12)
      }
    } else if (head.startsWith('\x80theora') || head.startsWith('\x80daala') || head.startsWith('fishead')) {
      throw new AudioError("Ogg video isn't supported. Upload MP4 clips (H.264) for video.")
    } else throw new AudioError('Ogg audio must be Vorbis or Opus.')
    o = p.end
  }
  if (!codec) throw new AudioError('Ogg audio must be Vorbis or Opus.')
  // The last page of the first stream carries its total length in samples.
  let durationSec: number | null = null
  const from = Math.max(0, b.length - 65_536 - 27)
  for (let o = b.length - 27; o >= from; o--) {
    if (b[o] !== 0x4f || ascii(b, o, o + 4) !== 'OggS') continue
    const p = oggPage(b, o)
    if (p && p.serial === first.serial && p.granule > 0 && rate > 0) {
      durationSec = Math.max(0, p.granule - preSkip) / rate
      break
    }
  }
  return { format: 'ogg', codec, durationSec }
}

/** Audio by magic bytes, or null when the bytes aren't MP3, WAV or Ogg. Throws for audio this app can't use. */
export function sniffAudio(b: Uint8Array): AudioInfo | null {
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return wav(b)
  if (ascii(b, 0, 4) === 'OggS') return ogg(b)
  if (ascii(b, 0, 3) === 'ID3' || b[0] === 0xff) return mp3(b)
  return null
}
