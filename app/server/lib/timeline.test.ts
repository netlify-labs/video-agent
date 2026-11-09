// Narration timeline model (plan §5.5, §6.1): resolve, joins, gain/fade math, limits, frames and the bus mixer.
// Property tests use a small seeded generator (no fast-check dependency); each runs a few hundred cases.
import { describe, expect, it } from 'vitest'
import {
  altStart,
  asAlternative,
  clipEnd,
  compositionTime,
  cutAlternative,
  dbToGain,
  DUCK_RELEASE_SAMPLES,
  EDGE_FADE_SAMPLES,
  envelope,
  fadeIn,
  fadeOut,
  frameAt,
  frameStart,
  framesFor,
  gainToDb,
  IDENTITY_FIT,
  MAX_OUTPUT_SAMPLES,
  mergeSpans,
  mixToBuffer,
  MAX_CLIP_ALTERNATIVES,
  nudge,
  opTakeIds,
  outputEnd,
  outputLimit,
  placeSpans,
  placeTake,
  resolve,
  SAMPLE_RATE,
  segments,
  slotTakes,
  snapToFrame,
  sourceSampleAt,
  withAlternatives,
  withinOutputLimit,
  withoutAlternatives,
  XFADE_SAMPLES,
  type NarrationClip,
  type TakeAlternative,
} from './timeline.js'

const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id'>): NarrationClip => ({
  mediaId: 'm1',
  srcStart: 0,
  srcEnd: 1000,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})

/** mulberry32: a tiny deterministic PRNG for the property tests. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) }
}

function randomClips(seed: number): NarrationClip[] {
  const r = rng(seed)
  return Array.from({ length: r.int(1, 8) }, (_, i) => {
    const srcStart = r.int(0, 100)
    return clip({
      id: `c${i}`,
      mediaId: `m${r.int(1, 3)}`,
      srcStart,
      srcEnd: srcStart + r.int(1, 120),
      start: r.int(0, 200),
      fadeInSamples: r.int(0, 30),
      fadeOutSamples: r.int(0, 30),
    })
  })
}

/** Per composition sample: which take and source sample the topmost (last) clip plays there. */
function ownerMap(clips: readonly NarrationClip[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const c of clips)
    for (let t = c.start; t < clipEnd(c); t++) m.set(t, `${c.mediaId}@${sourceSampleAt(c, t)}`)
  return m
}

describe('resolve', () => {
  it('trims an older clip under a later one and splits it around a punch-in', () => {
    const base = clip({ id: 'a', srcEnd: 1000, fadeInSamples: 50, fadeOutSamples: 60 })
    const punch = clip({ id: 'b', mediaId: 'm2', srcStart: 0, srcEnd: 200, start: 400 })
    expect(resolve([base, punch])).toEqual([
      { ...base, srcEnd: 400, fadeOutSamples: 0 },
      punch,
      { ...base, id: 'a~2', start: 600, srcStart: 600, srcEnd: 1000, fadeInSamples: 0 },
    ])
  })

  it('lets the later clip win even when it starts earlier, and drops a fully covered one', () => {
    const a = clip({ id: 'a', start: 100, srcEnd: 100 })
    const b = clip({ id: 'b', mediaId: 'm2', start: 50, srcEnd: 300 })
    expect(resolve([a, b]).map((c) => c.id)).toEqual(['b'])
    // The trimmed head keeps its id when only the tail survives.
    const c = clip({ id: 'c', start: 0, srcEnd: 100 })
    const d = clip({ id: 'd', mediaId: 'm2', start: 0, srcEnd: 40 })
    expect(resolve([c, d]).map((x) => [x.id, x.start, x.srcStart, x.srcEnd])).toEqual([
      ['d', 0, 0, 40],
      ['c', 40, 40, 100],
    ])
  })

  it('names split pieces with the first free ~n and is idempotent', () => {
    const a = clip({ id: 'a', srcEnd: 1000 })
    const taken = clip({ id: 'a~2', mediaId: 'm9', start: 5000, srcEnd: 10 })
    const p1 = clip({ id: 'p1', mediaId: 'm2', start: 100, srcEnd: 10 })
    const p2 = clip({ id: 'p2', mediaId: 'm2', start: 500, srcEnd: 10 })
    const once = resolve([a, taken, p1, p2])
    expect(once.map((c) => c.id)).toEqual(['a', 'p1', 'a~3', 'p2', 'a~4', 'a~2'])
    expect(resolve(once)).toEqual(once)
  })

  it('clamps fades to half the surviving piece', () => {
    const a = clip({ id: 'a', srcEnd: 100, fadeInSamples: 40 })
    const b = clip({ id: 'b', mediaId: 'm2', start: 30, srcEnd: 100 })
    expect(resolve([a, b])[0]).toMatchObject({ id: 'a', srcEnd: 30, fadeInSamples: 15 })
  })

  it('property: no overlaps, sorted, and every surviving sample keeps its take and composition time', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const clips = randomClips(seed)
      const out = resolve(clips)
      for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(clipEnd(out[i - 1]!))
      expect(new Set(out.map((c) => c.id)).size).toBe(out.length)
      // The same composition samples play the same source samples as "last clip on top" would.
      expect(ownerMap(out)).toEqual(ownerMap(clips))
      for (const c of out) {
        expect(c.srcEnd).toBeGreaterThan(c.srcStart)
        expect(c.fadeInSamples).toBeLessThanOrEqual(Math.floor((c.srcEnd - c.srcStart) / 2))
      }
      expect(resolve(out)).toEqual(out)
    }
  })

  it('property: moving a clip moves its samples rigidly and leaves the others where they were', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const clips = randomClips(seed)
      const r = rng(seed * 7)
      const k = r.int(0, clips.length - 1)
      const moved = clips.map((c, i) => (i === k ? { ...c, start: c.start + r.int(-50, 50) } : c))
      const out = resolve(moved)
      const target = moved[k]!
      for (const c of out.filter((x) => x.id === target.id || x.id.startsWith(`${target.id}~`))) {
        if (c.mediaId !== target.mediaId) continue
        // Every surviving source sample is where start + (s - srcStart) of the moved clip puts it.
        for (let s = c.srcStart; s < c.srcEnd; s++)
          expect(compositionTime(c, s)).toBe(compositionTime(target, s))
      }
      expect(ownerMap(out)).toEqual(ownerMap(moved))
    }
  })
})

describe('take alternatives', () => {
  const fit = { a: -2, b: 1 / SAMPLE_RATE, residualMs: 1 }
  /** Take `mediaId` sounding source [srcStart, srcEnd) from composition `at`. */
  const take = (mediaId: string, srcStart: number, srcEnd: number, at: number): TakeAlternative => ({
    mediaId,
    srcStart,
    srcEnd,
    fit,
    offsetSamples: at - placeTake(fit, 0, srcStart),
  })

  it('an alternative sounds where its alignment puts it; a clip as one sounds where the clip is now', () => {
    const t = take('m2', 5000, 9000, 3000)
    expect(altStart(t)).toBe(3000)
    // Moved since it was recorded: its offset follows the move, so it comes back where it is.
    const c = clip({ id: 'a', fit, offsetSamples: 7, srcStart: 100, srcEnd: 600, start: 4321 })
    expect(altStart(asAlternative(c))).toBe(4321)
    expect(asAlternative(c)).toMatchObject({ mediaId: 'm1', srcStart: 100, srcEnd: 600, fit })
  })

  it('cuts an alternative to a composition range, keeping each sample at its time', () => {
    const t = take('m2', 5000, 9000, 3000)
    const cut = cutAlternative(t, 4000, 5000)
    expect(cut).toMatchObject({ srcStart: 6000, srcEnd: 7000 })
    expect(cut && altStart(cut)).toBe(4000)
    expect(cutAlternative(t, 0, 3000)).toBeNull()
    expect(cutAlternative(t, 0, 99_999)).toEqual(t)
  })

  it("lists a slot's takes oldest first with the clip's own at its take number; counts every take", () => {
    const [t1, t2] = [take('m1', 0, 500, 1000), take('m2', 0, 500, 1000)]
    const c = clip({ id: 'a', mediaId: 'm3', start: 1000, srcEnd: 500, alternatives: [t1, t2] })
    expect(slotTakes(c)).toEqual({ takes: [t1, t2, asAlternative(c)], own: 2 })
    expect(slotTakes({ ...c, take: 1 })).toEqual({ takes: [asAlternative(c), t1, t2], own: 0 })
    expect(opTakeIds([c, clip({ id: 'b', mediaId: 'm2', start: 5000 })])).toEqual(['m3', 'm1', 'm2'])
    expect(withoutAlternatives({ ...c, take: 1 })).toEqual(
      clip({ id: 'a', mediaId: 'm3', start: 1000, srcEnd: 500 }),
    )
  })

  it('keeps the newest MAX_CLIP_ALTERNATIVES; none leaves the fields off', () => {
    const many = Array.from({ length: MAX_CLIP_ALTERNATIVES + 2 }, (_, i) => take(`t${i}`, 0, 100, 0))
    const c = withAlternatives(clip({ id: 'a', take: 1 }), many)
    expect(c.alternatives?.map((t) => t.mediaId)).toEqual(many.slice(2).map((t) => t.mediaId))
    expect(c.take).toBeUndefined()
    expect('alternatives' in withAlternatives(clip({ id: 'a' }), [])).toBe(false)
  })

  it("resolve cuts a trimmed or split clip's alternatives to each piece, and keeps its take number on its own", () => {
    const S = 1000
    // a (m3, take 2 of 3) at 0-6000, with m1 and m2 under the same range; b lands on 2000-4000.
    const a = clip({
      id: 'a',
      mediaId: 'm3',
      srcEnd: 6 * S,
      alternatives: [take('m1', 0, 6 * S, 0), take('m2', 3 * S, 6 * S, 3 * S)],
      take: 2,
    })
    const b = clip({ id: 'b', mediaId: 'm9', start: 2 * S, srcEnd: 2 * S })
    const [head, , tail] = resolve([a, b])
    // m2 only sounds from 3000, so the head (0-2000) has m1 alone, and a is still after it.
    expect(head?.alternatives).toEqual([take('m1', 0, 2 * S, 0)])
    expect(head?.take).toBe(2)
    expect(tail?.alternatives).toEqual([take('m1', 4 * S, 6 * S, 4 * S), take('m2', 4 * S, 6 * S, 4 * S)])
    expect(tail?.take).toBe(2)
    // The playing audio is unchanged by any of it.
    expect(segments([a, b], new Map()).map((g) => g.clip.mediaId)).toEqual(['m3', 'm9', 'm3'])
  })
})

describe('gain and fades', () => {
  it('converts dB to linear and back, with null as silence', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 6)
    expect(dbToGain(12)).toBeCloseTo(3.981072, 6)
    expect(dbToGain(null)).toBe(0)
    expect(gainToDb(0)).toBeNull()
    for (const db of [-60, -20.5, -3, 0, 6, 12]) expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9)
  })

  it('equal-power curves keep constant power across a crossfade', () => {
    for (let i = 0; i < XFADE_SAMPLES; i++) {
      const x = (i + 0.5) / XFADE_SAMPLES
      expect(fadeIn(x) ** 2 + fadeOut(x) ** 2).toBeCloseTo(1, 12)
    }
    expect(fadeIn(0)).toBe(0)
    expect(fadeOut(1)).toBeCloseTo(0, 12)
  })

  it('crossfades a join with handle audio, centred on the edit, at constant power', () => {
    const a = clip({ id: 'a', srcStart: 0, srcEnd: 2000, start: 0 })
    const b = clip({ id: 'b', mediaId: 'm2', srcStart: 1000, srcEnd: 3000, start: 2000 })
    const [sa, sb] = segments(
      [a, b],
      new Map([
        ['m1', 5000],
        ['m2', 5000],
      ]),
    )
    expect(sa!.tail).toEqual({ kind: 'xfade', samples: XFADE_SAMPLES })
    expect(sb!.head).toEqual({ kind: 'xfade', samples: XFADE_SAMPLES })
    expect([sa!.to, sb!.from]).toEqual([2000 + XFADE_SAMPLES / 2, 2000 - XFADE_SAMPLES / 2])
    for (let t = 2000 - XFADE_SAMPLES / 2; t < 2000 + XFADE_SAMPLES / 2; t++) {
      expect(envelope(sa!, t) ** 2 + envelope(sb!, t) ** 2).toBeCloseTo(1, 9)
    }
    expect(envelope(sa!, 1000)).toBe(1)
    expect(envelope(sb!, 2500)).toBe(1)
  })

  it('falls back to edge fades without handles, and plays an untouched split straight through', () => {
    const a = clip({ id: 'a', srcStart: 0, srcEnd: 2000 })
    const b = clip({ id: 'b', mediaId: 'm2', srcStart: 0, srcEnd: 2000, start: 2000 })
    const [sa, sb] = segments(
      [a, b],
      new Map([
        ['m1', 5000],
        ['m2', 5000],
      ]),
    )
    expect(sa!.tail).toEqual({ kind: 'edge', samples: EDGE_FADE_SAMPLES })
    expect(sb!.head).toEqual({ kind: 'edge', samples: EDGE_FADE_SAMPLES })
    expect([sa!.to, sb!.from]).toEqual([2000, 2000])
    expect(envelope(sa!, 1999)).toBeLessThan(0.01)
    expect(envelope(sb!, 2000)).toBeLessThan(0.01)
    // Splitting one clip in two leaves continuous audio with no join at all.
    const split = [
      clip({ id: 's', srcEnd: 1000 }),
      clip({ id: 's~2', srcStart: 1000, srcEnd: 2000, start: 1000 }),
    ]
    expect(segments(split, new Map([['m1', 5000]])).map((s) => [s.head.kind, s.tail.kind])).toEqual([
      ['none', 'none'],
      ['none', 'none'],
    ])
  })
})

describe('placement, limits and frames', () => {
  it('places a recorded take from its fit and offset', () => {
    expect(placeTake({ a: 1.5, b: 1 / SAMPLE_RATE, residualMs: 0.2 }, -120)).toBe(36_000 - 120)
    expect(placeTake(IDENTITY_FIT, 0, 4800)).toBe(4800)
  })

  it('enforces base + 120 s and 15 min', () => {
    const base = 60 * SAMPLE_RATE
    expect(outputLimit(base)).toBe(180 * SAMPLE_RATE)
    expect(withinOutputLimit(180 * SAMPLE_RATE, base)).toBe(true)
    expect(withinOutputLimit(180 * SAMPLE_RATE + 1, base)).toBe(false)
    expect(outputLimit(14 * 60 * SAMPLE_RATE)).toBe(MAX_OUTPUT_SAMPLES)
    expect(withinOutputLimit(MAX_OUTPUT_SAMPLES + 1, 14 * 60 * SAMPLE_RATE)).toBe(false)
    expect(
      outputEnd([clip({ id: 'a', start: 10, srcEnd: 90 }), clip({ id: 'b', start: 5, srcEnd: 20 })]),
    ).toBe(100)
    expect(outputEnd([])).toBe(0)
  })

  it('quantizes visuals to frames and nudges by whole frames', () => {
    expect(frameAt(799, 30)).toBe(0)
    expect(frameAt(800, 30)).toBe(1)
    expect(frameStart(30, 30)).toBe(SAMPLE_RATE)
    expect(snapToFrame(1201, 30)).toBe(1600)
    expect(snapToFrame(1199, 30)).toBe(800)
    expect(nudge(1234, 1, 30)).toBe(2034)
    expect(nudge(1234, -10, 30)).toBe(1234 - 8000)
    expect(framesFor(SAMPLE_RATE + 1, 30)).toBe(31)
    expect(framesFor(SAMPLE_RATE, 25)).toBe(25)
  })
})

describe('speech spans', () => {
  it('merges spans within a gap and maps take spans into composition time', () => {
    expect(
      mergeSpans([
        [50, 60],
        [0, 10],
        [10, 20],
        [30, 40],
      ]),
    ).toEqual([
      [0, 20],
      [30, 40],
      [50, 60],
    ])
    expect(
      mergeSpans(
        [
          [0, 10],
          [10 + DUCK_RELEASE_SAMPLES - 1, 9e4],
        ],
        DUCK_RELEASE_SAMPLES,
      ),
    ).toEqual([[0, 9e4]])
    const clips = [
      clip({ id: 'a', mediaId: 'm1', srcStart: 100, srcEnd: 1100, start: 5000 }),
      clip({ id: 'b', mediaId: 'm2', srcStart: 0, srcEnd: 300, start: 7000 }),
      clip({ id: 'c', mediaId: 'm3', srcStart: 0, srcEnd: 300, start: 9000, gainDb: null }),
    ]
    const spans = new Map([
      [
        'm1',
        [
          [0, 200],
          [900, 2000],
        ] as [number, number][],
      ],
    ])
    // m1 spans are cut to the clip; m2 has no summary so the whole clip counts; m3 is silent.
    expect(placeSpans(clips, spans)).toEqual([
      [5000, 5100],
      [5800, 6000],
      [7000, 7300],
    ])
  })
})

describe('mixToBuffer', () => {
  it('lands known impulses at exact samples with clip and track gain', () => {
    const take = new Float32Array(10_000)
    take[3000] = 0.5
    take[7000] = -0.25
    const clips = [
      clip({ id: 'a', srcStart: 2000, srcEnd: 4000, start: 100 }),
      clip({ id: 'b', srcStart: 6000, srcEnd: 8000, start: 20_000, gainDb: -6 }),
    ]
    const out = mixToBuffer(clips, new Map([['m1', take]]), 30_000)
    const nonzero = [...out.entries()].filter(([, v]) => v !== 0)
    expect(nonzero.map(([i]) => i)).toEqual([1100, 21_000])
    expect(out[1100]).toBe(0.5)
    expect(out[21_000]).toBeCloseTo(-0.25 * dbToGain(-6), 6)
    const quiet = mixToBuffer(clips, new Map([['m1', take]]), 30_000, {
      narration: { volumeDb: -6, muted: false, solo: false },
    })
    expect(quiet[1100]).toBeCloseTo(0.5 * dbToGain(-6), 6)
    const muted = mixToBuffer(clips, new Map([['m1', take]]), 30_000, {
      narration: { volumeDb: 0, muted: true, solo: false },
    })
    expect(muted.every((v) => v === 0)).toBe(true)
  })

  it('keeps a constant level through a handle crossfade of two equal tones, and cuts at the target length', () => {
    const dc = new Float32Array(5000).fill(0.5)
    const clips = [
      clip({ id: 'a', mediaId: 'x', srcStart: 0, srcEnd: 2000 }),
      clip({ id: 'b', mediaId: 'y', srcStart: 1000, srcEnd: 3000, start: 2000 }),
    ]
    const out = mixToBuffer(
      clips,
      new Map([
        ['x', dc],
        ['y', dc],
      ]),
      3000,
    )
    expect(out.length).toBe(3000)
    // Equal-power on correlated audio peaks at +3 dB at the centre and is unity at the ends.
    expect(out[1000]).toBe(0.5)
    expect(out[2000 - XFADE_SAMPLES / 2 - 1]).toBe(0.5)
    expect(out[2000]!).toBeCloseTo(0.5 * Math.SQRT2, 2)
    expect(out[2999]).toBe(0.5)
  })

  it('is deterministic and throws on a missing take', () => {
    const r = rng(42)
    const take = Float32Array.from({ length: 4000 }, () => r.next() * 2 - 1)
    const clips = randomClips(9).map((c) => ({
      ...c,
      mediaId: 'm1',
      srcStart: c.srcStart * 10,
      srcEnd: c.srcEnd * 10,
    }))
    const a = mixToBuffer(clips, new Map([['m1', take]]), 3000)
    const b = mixToBuffer(structuredClone(clips), new Map([['m1', take.slice()]]), 3000)
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true)
    expect(() => mixToBuffer([clip({ id: 'z', mediaId: 'nope' })], new Map(), 100)).toThrow(/nope/)
  })
})
