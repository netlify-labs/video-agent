// Bounded ISO-BMFF (MP4) inspection without FFmpeg. Reads box headers and the moov metadata only.

export interface Mp4Info {
  durationSec: number
  width: number
  height: number
  videoCodec: string
  /** The first audio track's sample entry (mp4a for AAC), or null with no audio. */
  audioCodec: string | null
  fastStart: boolean
  /** A top-level moof, or moov/mvex: samples live in fragments, not in the moov's tables. */
  fragmented: boolean
  /** Sample timing of the first video track (screen-recording plan §4.2), or null without one. */
  video: VideoTiming | null
}

export interface VideoTiming {
  /** The track's own timescale (mdhd). */
  timescale: number
  sampleCount: number
  /** sampleCount over the summed sample durations. */
  fps: number
  /** Every sample lasts the same, within one tick (a one-entry stts always does). */
  cfr: boolean
  /**
   * The longest time between consecutive sync samples, and from the last one to the end. With no stss every sample
   * is a sync sample (ISO/IEC 14496-12 §8.6.2), so it's one frame.
   */
  maxKeyframeGapSec: number
  syncSamples: number
  /** stsd entries: more than one means the codec or picture size changes mid-file. */
  sampleEntries: number
  /** More than one sample entry, or an entry whose picture size differs from the track header's. */
  sizeChanges: boolean
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

/** A full box's entry table: the count after version and flags, checked against the box before anything is read. */
function table(view: DataView, b: Box, entryBytes: number, skip = 0): { count: number; at: number } {
  const at = b.start + b.headerSize + 8 + skip
  const count = view.getUint32(at - 4)
  if (at + count * entryBytes > b.start + b.size)
    throw new Mp4Error(`${b.type} entry count runs past the box`)
  return { count, at }
}

/** Sample timing from the video track's stbl (see VideoTiming). */
function videoTiming(
  view: DataView,
  trak: Box,
  size: { width: number; height: number },
  counter: { n: number },
) {
  const mdhd = find(view, trak, ['mdia', 'mdhd'], counter)[0]
  const stbl = find(view, trak, ['mdia', 'minf', 'stbl'], counter)[0]
  if (!mdhd || !stbl) return null
  const { timescale } = timescaleDuration(view, mdhd)
  if (!timescale) throw new Mp4Error('Invalid track timescale')
  const boxes = children(view, stbl, counter, 4)
  const stts = boxes.find((b) => b.type === 'stts')
  const stss = boxes.find((b) => b.type === 'stss')
  const stsd = boxes.find((b) => b.type === 'stsd')

  // stts: runs of (sample_count, sample_delta).
  const runs: { count: number; delta: number }[] = []
  if (stts) {
    const t = table(view, stts, 8)
    for (let i = 0; i < t.count; i++)
      runs.push({ count: view.getUint32(t.at + i * 8), delta: view.getUint32(t.at + i * 8 + 4) })
  }
  const deltas = runs.filter((r) => r.count > 0).map((r) => r.delta)
  const sampleCount = runs.reduce((n, r) => n + r.count, 0)
  const totalTicks = runs.reduce((n, r) => n + r.count * r.delta, 0)
  const cfr = deltas.length <= 1 || Math.max(...deltas) - Math.min(...deltas) <= 1
  /** Start time, in ticks, of 1-based sample `n`. */
  const startOf = (() => {
    let run = 0
    let first = 1
    let ticks = 0
    return (n: number) => {
      for (let r = runs[run]; r && n >= first + r.count; r = runs[++run]) {
        ticks += r.count * r.delta
        first += r.count
      }
      return ticks + (n - first) * (runs[run]?.delta ?? 0)
    }
  })()

  // stss: ascending 1-based sync sample numbers; none means all.
  let maxGapTicks = deltas.length ? Math.max(...deltas) : 0
  let syncSamples = sampleCount
  if (stss) {
    const t = table(view, stss, 4)
    syncSamples = t.count
    maxGapTicks = 0
    let prev = -1
    let prevTicks = 0
    for (let i = 0; i < t.count; i++) {
      const n = view.getUint32(t.at + i * 4)
      if (n <= prev || n < 1) throw new Mp4Error('stss sample numbers are not ascending')
      if (n > sampleCount) throw new Mp4Error('stss names a sample past the end')
      const ticks = startOf(n)
      if (prev !== -1) maxGapTicks = Math.max(maxGapTicks, ticks - prevTicks)
      prev = n
      prevTicks = ticks
    }
    maxGapTicks = Math.max(maxGapTicks, totalTicks - (prev === -1 ? 0 : prevTicks))
  }

  // stsd: count entries; a visual entry's width and height sit 24 bytes into its body.
  let sampleEntries = 0
  let sizeChanges = false
  if (stsd) {
    const end = stsd.start + stsd.size
    let off = stsd.start + stsd.headerSize + 8
    sampleEntries = view.getUint32(off - 4)
    for (let i = 0; i < sampleEntries; i++) {
      const entry = readBox(view, off, end)
      if ((entry.type === 'avc1' || entry.type === 'avc3') && entry.size >= 8 + 28) {
        const w = view.getUint16(off + 8 + 24)
        const h = view.getUint16(off + 8 + 26)
        if (w !== size.width || h !== size.height) sizeChanges = true
      }
      off += entry.size
    }
    if (sampleEntries > 1) sizeChanges = true
  }

  const seconds = totalTicks / timescale
  return {
    timescale,
    sampleCount,
    fps: seconds > 0 ? sampleCount / seconds : 0,
    cfr,
    maxKeyframeGapSec: maxGapTicks / timescale,
    syncSamples,
    sampleEntries,
    sizeChanges,
  }
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
  const fragmented = types.includes('moof') || find(view, moov, ['mvex'], counter).length > 0

  const mvhd = find(view, moov, ['mvhd'], counter)[0]
  if (!mvhd) throw new Mp4Error('Missing mvhd')
  const { timescale, duration } = timescaleDuration(view, mvhd)
  if (!timescale) throw new Mp4Error('Invalid timescale')

  let width = 0
  let height = 0
  let videoCodec = ''
  let audioCodec: string | null = null
  let video: VideoTiming | null = null
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
    video = videoTiming(view, trak, { width, height }, counter)
  }
  if (!videoCodec && !opts.audioOnly) throw new Mp4Error('No video track')
  return {
    durationSec: duration / timescale,
    width,
    height,
    videoCodec,
    audioCodec,
    fastStart,
    fragmented,
    video,
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
