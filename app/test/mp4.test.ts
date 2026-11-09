// MP4 facts for screen recordings (screen-recording plan §4.2): the longest keyframe gap (stss over stts, in the
// track timescale; no stss means all sync samples), frame rate and CFR, sample entries and picture-size changes,
// fragmented and fast start. Fixtures come from app/test/fixtures/mp4/make.sh; expected values from expected.json. The
// two-entry, no-stss and malformed cases are patched from slowstart.mp4 in memory (its moov follows mdat, so growing the moov
// moves no chunk offsets).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectMp4, Mp4Error } from '../server/lib/media/mp4.js'

const dir = new URL('./fixtures/mp4/', import.meta.url)
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)))
const expected = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8')) as Record<
  string,
  { fastStart: boolean; fragmented: boolean; video: Record<string, number | boolean> | null }
>

/** Byte offset of the first box at `path` under [start, end) (a full walk, no limits: fixtures are trusted). */
function boxAt(b: Uint8Array, path: string[], start = 0, end = b.byteLength): { at: number; size: number }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: { at: number; size: number }[] = []
  for (let off = start; off + 8 <= end;) {
    const size = v.getUint32(off)
    const type = String.fromCharCode(...b.subarray(off + 4, off + 8))
    if (type === path[0]) {
      out.push({ at: off, size })
      if (path.length > 1) return [...out, ...boxAt(b, path.slice(1), off + 8, off + size)]
    }
    off += size
  }
  return out
}

/** The video track's stbl child of this type, or null. */
function stbl(b: Uint8Array, type: string) {
  const chain = boxAt(b, ['moov', 'trak', 'mdia', 'minf', 'stbl', type])
  return chain.length === 6 ? (chain.at(-1) ?? null) : null
}

/** slowstart.mp4 with its avc1 sample entry duplicated (a second picture size: width + 2). */
function twoEntries() {
  const b = fixture('slowstart.mp4')
  const chain = boxAt(b, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
  const stsd = chain.at(-1)!
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const entryAt = stsd.at + 16
  const entrySize = v.getUint32(entryAt)
  const entry = b.slice(entryAt, entryAt + entrySize)
  new DataView(entry.buffer).setUint16(8 + 24, v.getUint16(entryAt + 8 + 24) + 2)
  const out = new Uint8Array(b.byteLength + entrySize)
  out.set(b.subarray(0, entryAt + entrySize))
  out.set(entry, entryAt + entrySize)
  out.set(b.subarray(entryAt + entrySize), entryAt + 2 * entrySize)
  const w = new DataView(out.buffer)
  for (const box of chain) w.setUint32(box.at, box.size + entrySize)
  w.setUint32(stsd.at + 12, 2)
  return out
}

/** slowstart.mp4 with a table's entry count set past its box. */
function badCount(type: 'stts' | 'stss') {
  const b = fixture('slowstart.mp4')
  const box = stbl(b, type)
  if (!box) throw new Error(`slowstart.mp4 has no ${type}`)
  new DataView(b.buffer).setUint32(box.at + 12, 0x0fffffff)
  return b
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

describe('inspectMp4 video timing', () => {
  it.each(Object.keys(expected))('%s', (name) => {
    const want = expected[name]!
    const got = inspectMp4(fixture(name), { audioOnly: true })
    log({
      fixture: name,
      expected: want,
      actual: { fastStart: got.fastStart, fragmented: got.fragmented, video: got.video },
    })
    expect(got.fastStart).toBe(want.fastStart)
    expect(got.fragmented).toBe(want.fragmented)
    if (want.video === null) return expect(got.video).toBeNull()
    for (const [k, v] of Object.entries(want.video)) {
      const actual = got.video![k as keyof NonNullable<typeof got.video>]
      if (typeof v === 'number') expect(actual).toBeCloseTo(v, 3)
      else expect(actual).toBe(v)
    }
  })

  it('reads no stss as every sample a sync sample (gap one frame)', () => {
    // intra.mp4 has no stss (ffmpeg leaves it out when every sample is a sync sample); gop300.mp4 gets its stss
    // renamed to `free` (skipped like any unknown box).
    const intra = fixture('intra.mp4')
    expect(stbl(intra, 'stss')).toBeNull()
    const gop300 = fixture('gop300.mp4')
    const stss = stbl(gop300, 'stss')
    expect(stss).not.toBeNull()
    gop300.set([0x66, 0x72, 0x65, 0x65], (stss?.at ?? 0) + 4)
    for (const [name, b] of [
      ['intra.mp4', intra],
      ['gop300.mp4 without stss', gop300],
    ] as const) {
      const got = inspectMp4(b).video
      log({ fixture: name, actual: got })
      expect(got?.syncSamples).toBe(got?.sampleCount)
      expect(got?.maxKeyframeGapSec).toBeCloseTo(1 / 30, 6)
    }
  })

  it('flags a second sample entry as a size change', () => {
    const got = inspectMp4(twoEntries())
    log({ fixture: 'two-entries', actual: got.video })
    expect(got.video).toMatchObject({ sampleEntries: 2, sizeChanges: true, maxKeyframeGapSec: 1 })
  })

  it.each(['stts', 'stss'] as const)('throws Mp4Error when the %s count runs past its box', (type) => {
    expect(() => inspectMp4(badCount(type))).toThrow(Mp4Error)
  })

  it('leaves existing fields as they were', () => {
    expect(inspectMp4(fixture('gop30.mp4'))).toMatchObject({
      durationSec: 3,
      width: 320,
      height: 180,
      videoCodec: 'avc1',
      audioCodec: null,
      fastStart: true,
    })
  })
})
