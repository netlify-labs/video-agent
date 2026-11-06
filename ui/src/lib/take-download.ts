// Downloading a take's audio (owner, 2026-11-06): the file as stored (a recorded take is a 24 kHz mono 16-bit WAV, an
// uploaded one is whatever was uploaded), named after the video and the take, and, where the browser can encode AAC
// (WebCodecs), a smaller M4A made here from those bytes. No server-side transcoding.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    // Accents off first (año → ano), so they don't split words.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-') || 'video'

/** `lumen-v1-take-3`: the video's title, the version and the take's number on the track. */
export const takeBaseName = (title: string, versionN: number, take: number): string =>
  `${slug(title)}-v${versionN}-take-${take}`

/** `lumen-v1-take-3.wav`: the base name and the file's extension. */
export const takeFileName = (title: string, versionN: number, take: number, ext: string): string =>
  `${takeBaseName(title, versionN, take)}.${ext.replace(/^\./, '').toLowerCase() || 'wav'}`

/** The extension a stored take's file has: from its filename, else its type. */
export function takeExt(filename: string | null | undefined, mime: string | null | undefined): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(filename ?? '')
  if (m?.[1]) return m[1].toLowerCase()
  if (mime?.includes('mpeg')) return 'mp3'
  if (mime?.includes('mp4') || mime?.includes('aac')) return 'm4a'
  if (mime?.includes('ogg')) return 'ogg'
  return 'wav'
}

/** A take's number on the narration track: its order among the distinct takes there (1 for the first). */
export function takeNumber(mediaIds: readonly string[], mediaId: string): number {
  const order = [...new Set(mediaIds)]
  const i = order.indexOf(mediaId)
  return i < 0 ? order.length + 1 : i + 1
}

/** Saves `blob` as `name` (an object URL on a link, clicked and revoked). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Whether this browser can make the smaller M4A (AAC through WebCodecs). */
export async function canCompress(): Promise<boolean> {
  try {
    return (
      typeof AudioEncoder !== 'undefined' &&
      (await canEncodeAudio('aac', { numberOfChannels: 1, sampleRate: 24_000 }))
    )
  } catch {
    return false
  }
}

/** The audio as an AAC M4A at `bitrate` (bits per second), made in this browser; null when it can't. */
export async function compressAudio(blob: Blob, bitrate = 96_000): Promise<Blob | null> {
  if (!(await canCompress())) return null
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const conversion = await Conversion.init({ input, output, audio: { codec: 'aac', bitrate } })
  if (!conversion.isValid) return null
  await conversion.execute()
  return target.buffer ? new Blob([target.buffer], { type: 'audio/mp4' }) : null
}
