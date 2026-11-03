// WebM (and Matroska) audio, read structurally (plan 2026-11-02 §5.2): the EBML header's DocType, then the Segment's
// Info and Tracks up to the first Cluster. One audio track (Opus or Vorbis) and nothing else; any video track refuses
// the file. Only the elements this needs are descended into, element and string sizes are bounded, and the walk
// stops at the first Cluster, so a hostile file costs a few thousand element headers at most. Unknown sizes are
// allowed only where Matroska allows them (Segment, Cluster).

export interface WebmInfo {
  codec: 'opus' | 'vorbis'
  channels: number | null
  /** From Info's Duration, else from the last Cluster's timestamps (what MediaRecorder writes); null when neither. */
  durationSec: number | null
}

export class WebmError extends Error {}

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  MaxIdLength: 0x42f2,
  MaxSizeLength: 0x42f3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  Audio: 0xe1,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const

const MAX_ELEMENTS = 4096
const MAX_DEPTH = 4
const MAX_HEADER_BYTES = 4096
const MAX_TRACKS_BYTES = 1024 * 1024
const MAX_STRING = 64
const MAX_CHANNELS = 8
/** How far back from the end the last Cluster is looked for, when Info has no Duration. */
const TAIL_BYTES = 2 * 1024 * 1024

const VIDEO = "WebM video isn't supported. Upload MP4 clips (H.264) for video."
const unreadable = (why: string) => new WebmError(`The WebM file couldn't be read (${why}).`)

interface El {
  id: number
  /** Where the body starts and ends (the end is clamped to the parent for an unknown size). */
  start: number
  end: number
  unknown: boolean
}

/** A variable-length integer at o: its length and value (marker bit removed for sizes, kept for ids). */
function vint(b: Uint8Array, o: number, keepMarker: boolean, maxLen: number): [number, number, boolean] {
  const first = b[o]
  if (first === undefined) throw unreadable('it ends early')
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > maxLen) throw unreadable('a malformed element')
  if (o + len > b.length) throw unreadable('it ends early')
  let v = keepMarker ? first : first & (0xff >> len)
  let allOnes = v === 0xff >> len
  for (let i = 1; i < len; i++) {
    const x = b[o + i] ?? 0
    if (x !== 0xff) allOnes = false
    v = v * 256 + x
  }
  return [len, v, !keepMarker && allOnes]
}

/** The element whose header is at o, inside a parent ending at `end`. */
function element(b: Uint8Array, o: number, end: number, unknownOk: boolean): El {
  const [il, id] = vint(b, o, true, 4)
  const [sl, size, unknown] = vint(b, o + il, false, 8)
  const start = o + il + sl
  if (unknown) {
    if (!unknownOk) throw unreadable('an element of unknown size')
    return { id, start, end, unknown }
  }
  if (start + size > end)
    throw unreadable(end === b.length ? 'it ends early' : 'an element overruns its parent')
  return { id, start, end: start + size, unknown }
}

const uint = (b: Uint8Array, e: El) => {
  if (e.end - e.start > 8) throw unreadable('a malformed number')
  let v = 0
  for (let o = e.start; o < e.end; o++) v = v * 256 + (b[o] ?? 0)
  return v
}
const float = (b: Uint8Array, e: El) => {
  const dv = new DataView(b.buffer, b.byteOffset + e.start, e.end - e.start)
  if (e.end - e.start === 4) return dv.getFloat32(0)
  if (e.end - e.start === 8) return dv.getFloat64(0)
  if (e.end === e.start) return 0
  throw unreadable('a malformed number')
}
const str = (b: Uint8Array, e: El) => {
  if (e.end - e.start > MAX_STRING) throw unreadable('a string is too long')
  // Strings may be padded with NULs.
  return String.fromCharCode(...b.subarray(e.start, e.end)).replace(/\0+$/, '')
}

/**
 * Walks the children of [start, end), calling `visit` for each; a budget shared across the walk bounds it. Only the
 * `unknownOk` id may have an unknown size, and the walk stops (returning where) at the first `stopAt` id, before
 * reading its size.
 */
function walk(
  b: Uint8Array,
  start: number,
  end: number,
  budget: { n: number },
  depth: number,
  visit: (e: El) => boolean | undefined,
  opts: { unknownOk?: number; stopAt?: number } = {},
): number {
  if (depth > MAX_DEPTH) throw unreadable('elements nest too deeply')
  for (let o = start; o < end;) {
    if (++budget.n > MAX_ELEMENTS) throw unreadable('too many elements')
    const [, id] = vint(b, o, true, 4)
    if (id === opts.stopAt) return o
    const e = element(b, o, end, id === opts.unknownOk)
    if (visit(e) === false || e.unknown) return e.end
    o = e.end
  }
  return end
}

interface Track {
  type: number
  codec: string
  video: boolean
  channels: number | null
}

function tracks(b: Uint8Array, t: El, budget: { n: number }): Track[] {
  if (t.end - t.start > MAX_TRACKS_BYTES) throw unreadable('the track list is too large')
  const out: Track[] = []
  walk(b, t.start, t.end, budget, 2, (e) => {
    if (e.id !== ID.TrackEntry) return
    const track: Track = { type: 0, codec: '', video: false, channels: null }
    walk(b, e.start, e.end, budget, 3, (f) => {
      if (f.id === ID.TrackType) track.type = uint(b, f)
      else if (f.id === ID.CodecID) track.codec = str(b, f)
      else if (f.id === ID.Video) track.video = true
      else if (f.id === ID.Audio)
        walk(b, f.start, f.end, budget, 4, (g) => {
          if (g.id === ID.Channels) track.channels = uint(b, g)
        })
    })
    out.push(track)
    if (out.length > 16) throw unreadable('too many tracks')
  })
  return out
}

/** The last Cluster's timestamp plus its latest block's, in ticks; null when no Cluster is found near the end. */
function lastClusterTicks(b: Uint8Array, from: number): number | null {
  const floor = Math.max(from, b.length - TAIL_BYTES)
  for (let o = b.length - 4; o >= floor; o--) {
    if (b[o] !== 0x1f || b[o + 1] !== 0x43 || b[o + 2] !== 0xb6 || b[o + 3] !== 0x75) continue
    // A Cluster opens with its Timecode: anything else is a stray 1F 43 B6 75 in audio data (checked without
    // throwing, so a tail full of them stays cheap).
    const sizeByte = b[o + 4] ?? 0
    const sizeLen = sizeByte ? Math.clz32(sizeByte) - 23 : 9
    if (sizeLen > 8 || b[o + 4 + sizeLen] !== ID.Timecode) continue
    const ts: { base: number | null; rel: number } = { base: null, rel: 0 }
    try {
      // A cut-off last Cluster still counts: what's there is read, up to the element budget.
      const c = element(b, o, b.length, true)
      const budget = { n: 0 }
      walk(b, c.start, c.end, budget, 1, (e) => {
        if (ts.base === null && e.id !== ID.Timecode) return false
        if (e.id === ID.Timecode) ts.base = uint(b, e)
        let block: El | null = e.id === ID.SimpleBlock ? e : null
        if (e.id === ID.BlockGroup)
          walk(b, e.start, e.end, budget, 2, (g) => {
            if (g.id === ID.Block) block = g
          })
        if (block) {
          // The block's timestamp: a signed 16-bit offset after its track number.
          const at = block.start + vint(b, block.start, false, 8)[0]
          if (at + 2 <= block.end)
            ts.rel = Math.max(ts.rel, (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16)) >> 16)
        }
      })
    } catch {
      // A cut-off block or the budget: keep what was read.
    }
    if (ts.base !== null) return ts.base + ts.rel
  }
  return null
}

/** Whether the bytes start with an EBML header (WebM, Matroska). */
export const isEbml = (b: Uint8Array) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3

/** Checks a WebM/Matroska file as audio: one Opus or Vorbis track and no video. Throws WebmError. */
export function inspectWebm(b: Uint8Array): WebmInfo {
  const budget = { n: 0 }
  const head = element(b, 0, b.length, false)
  if (head.id !== ID.EBML) throw unreadable('no EBML header')
  if (head.end - head.start > MAX_HEADER_BYTES) throw unreadable('the header is too large')
  let docType = ''
  walk(b, head.start, head.end, budget, 1, (e) => {
    if (e.id === ID.DocType) docType = str(b, e)
    else if (e.id === ID.MaxIdLength && uint(b, e) > 4) throw unreadable('ids longer than 4 bytes')
    else if (e.id === ID.MaxSizeLength && uint(b, e) > 8) throw unreadable('sizes longer than 8 bytes')
  })
  if (docType !== 'webm' && docType !== 'matroska')
    throw new WebmError(
      `The file isn't WebM or Matroska (its type is ${JSON.stringify(docType.slice(0, 20))}).`,
    )
  let segment: El | null = null
  walk(
    b,
    head.end,
    b.length,
    budget,
    0,
    (e) => {
      if (e.id === ID.Segment) {
        segment = e
        return false
      }
    },
    { unknownOk: ID.Segment },
  )
  const seg = segment as El | null
  if (!seg) throw unreadable('no Segment')
  let scale = 1_000_000
  let duration: number | null = null
  let list: Track[] | null = null
  const clusterAt = walk(
    b,
    seg.start,
    seg.end,
    budget,
    1,
    (e) => {
      if (e.id === ID.Info)
        walk(b, e.start, e.end, budget, 2, (f) => {
          if (f.id === ID.TimecodeScale) scale = uint(b, f)
          else if (f.id === ID.Duration) duration = float(b, f)
        })
      else if (e.id === ID.Tracks) {
        if (list) throw unreadable('two track lists')
        list = tracks(b, e, budget)
      }
    },
    // The tracks come before the media; everything from the first Cluster on is audio data.
    { stopAt: ID.Cluster },
  )
  const found = list as Track[] | null
  if (!found) throw unreadable('no track list before the audio')
  if (found.some((t) => t.type === 1 || t.video || t.codec.startsWith('V_'))) throw new WebmError(VIDEO)
  const audio = found.filter((t) => t.type === 2)
  if (audio.length !== 1 || found.length !== 1)
    throw new WebmError('WebM audio must have exactly one audio track and nothing else.')
  const [a] = audio as [Track]
  const codec = a.codec === 'A_OPUS' ? 'opus' : a.codec === 'A_VORBIS' ? 'vorbis' : null
  if (!codec)
    throw new WebmError(`WebM audio must be Opus or Vorbis (this file has ${a.codec || 'no codec'}).`)
  if (a.channels !== null && (a.channels < 1 || a.channels > MAX_CHANNELS))
    throw new WebmError(`WebM audio can have at most ${MAX_CHANNELS} channels.`)
  if (!(scale > 0)) throw unreadable('a zero timestamp scale')
  const d = duration as number | null
  let durationSec: number | null = null
  if (d !== null) {
    if (!Number.isFinite(d) || d < 0) throw unreadable('a malformed duration')
    durationSec = (d * scale) / 1e9
  } else {
    const ticks = lastClusterTicks(b, clusterAt)
    if (ticks !== null) durationSec = (ticks * scale) / 1e9
  }
  return { codec, channels: a.channels, durationSec }
}
