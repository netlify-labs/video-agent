// Bounded ISO-BMFF (MP4) inspection without FFmpeg. Reads box headers and the moov metadata only.

export interface Mp4Info {
  durationSec: number
  width: number
  height: number
  videoCodec: string
  /** The first audio track's sample entry (mp4a for AAC), or null with no audio. */
  audioCodec: string | null
  fastStart: boolean
  topLevel: string[]
}

export class Mp4Error extends Error {}

const LIMITS = { maxBoxes: 20_000, maxDepth: 12, maxMoovBytes: 64 * 1024 * 1024 }

interface Box {
  type: string
  start: number
  headerSize: number
  size: number
}

function readBox(view: DataView, offset: number, end: number): Box {
  if (offset + 8 > end) throw new Mp4Error(`Truncated box header at ${offset}`)
  let size = view.getUint32(offset)
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  )
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > end) throw new Mp4Error(`Truncated large box header at ${offset}`)
    const big = view.getBigUint64(offset + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4Error('Box too large')
    size = Number(big)
    headerSize = 16
  } else if (size === 0) {
    size = end - offset
  }
  if (size < headerSize) throw new Mp4Error(`Invalid box size ${size} for ${type}`)
  if (offset + size > end) throw new Mp4Error(`Box ${type} extends past its parent (truncated file?)`)
  return { type, start: offset, headerSize, size }
}

function children(view: DataView, parent: Box, counter: { n: number }, depth: number): Box[] {
  if (depth > LIMITS.maxDepth) throw new Mp4Error('Boxes nested too deeply')
  const out: Box[] = []
  let off = parent.start + parent.headerSize
  const end = parent.start + parent.size
  while (off < end) {
    if (++counter.n > LIMITS.maxBoxes) throw new Mp4Error('Too many boxes')
    const b = readBox(view, off, end)
    out.push(b)
    off += b.size
  }
  return out
}

function find(view: DataView, parent: Box, path: string[], counter: { n: number }, depth = 0): Box[] {
  const [head, ...rest] = path
  const matches = children(view, parent, counter, depth).filter((b) => b.type === head)
  if (rest.length === 0) return matches
  return matches.flatMap((m) => find(view, m, rest, counter, depth + 1))
}

function fullBoxVersion(view: DataView, b: Box): number {
  return view.getUint8(b.start + b.headerSize)
}

function timescaleDuration(view: DataView, b: Box): { timescale: number; duration: number } {
  const p = b.start + b.headerSize
  if (fullBoxVersion(view, b) === 1) {
    return { timescale: view.getUint32(p + 20), duration: Number(view.getBigUint64(p + 24)) }
  }
  return { timescale: view.getUint32(p + 12), duration: view.getUint32(p + 16) }
}

/** Reads an MP4's tracks. With `audioOnly`, a file without a video track is fine (videoCodec is then ''). */
export function inspectMp4(bytes: Uint8Array, opts: { audioOnly?: boolean } = {}): Mp4Info {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const counter = { n: 0 }
  const root: Box = { type: 'root', start: 0, headerSize: 0, size: bytes.byteLength }
  const top = children(view, root, counter, 0)
  const types = top.map((b) => b.type)
  if (types[0] !== 'ftyp') throw new Mp4Error('Missing ftyp at start')
  const moov = top.find((b) => b.type === 'moov')
  const mdatIndex = types.indexOf('mdat')
  if (!moov) throw new Mp4Error('Missing moov')
  if (mdatIndex === -1) throw new Mp4Error('Missing mdat')
  if (moov.size > LIMITS.maxMoovBytes) throw new Mp4Error('moov too large')
  const fastStart = types.indexOf('moov') < mdatIndex

  const mvhd = find(view, moov, ['mvhd'], counter)[0]
  if (!mvhd) throw new Mp4Error('Missing mvhd')
  const { timescale, duration } = timescaleDuration(view, mvhd)
  if (!timescale) throw new Mp4Error('Invalid timescale')

  let width = 0
  let height = 0
  let videoCodec = ''
  let audioCodec: string | null = null
  const sampleEntry = (trak: Box) => {
    const stsd = find(view, trak, ['mdia', 'minf', 'stbl', 'stsd'], counter)[0]
    if (!stsd) return ''
    const entry = stsd.start + stsd.headerSize + 8
    return entry + 8 <= stsd.start + stsd.size
      ? String.fromCharCode(...bytes.subarray(entry + 4, entry + 8))
      : ''
  }
  for (const trak of find(view, moov, ['trak'], counter)) {
    const hdlr = find(view, trak, ['mdia', 'hdlr'], counter)[0]
    if (!hdlr) continue
    const handler = String.fromCharCode(
      ...bytes.subarray(hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12),
    )
    if (handler === 'soun' && audioCodec === null) audioCodec = sampleEntry(trak) || null
    if (handler !== 'vide' || videoCodec) continue
    const tkhd = find(view, trak, ['tkhd'], counter)[0]
    if (tkhd) {
      const end = tkhd.start + tkhd.size
      width = Math.round(view.getUint32(end - 8) / 65536)
      height = Math.round(view.getUint32(end - 4) / 65536)
    }
    videoCodec = sampleEntry(trak)
  }
  if (!videoCodec && !opts.audioOnly) throw new Mp4Error('No video track')
  return {
    durationSec: duration / timescale,
    width,
    height,
    videoCodec,
    audioCodec,
    fastStart,
    topLevel: types,
  }
}

export function sniff(bytes: Uint8Array): 'jpeg' | 'gif' | 'vtt' | 'mp4' | 'unknown' {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a' ||
    String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF87a'
  )
    return 'gif'
  const head = new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes.subarray(0, 10))
  if (head.startsWith('WEBVTT')) return 'vtt'
  if (String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'mp4'
  return 'unknown'
}
