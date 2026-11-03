// The narration audition (plan §5.4): chunk scheduling against the preview clock, parity of the rendered bus with the
// run's mixer, the decode window and budget, track levels and the approximate cleanup chain, on a minimal fake
// AudioContext (Node has no Web Audio).
import { describe, expect, it } from 'vitest'
import {
  IDENTITY_FIT,
  SAMPLE_RATE,
  clipEnd,
  mixToBuffer,
  segments,
  type NarrationClip,
  type NarrationOp,
} from '../../../src/lib/timeline'
import {
  APPROX_CLEANUP,
  APPROX_CLEANUP_DESCRIPTION,
  CHUNK_SAMPLES,
  NarrationAudition,
  RAW_LABEL,
  audibleChunks,
  planChunks,
  renderChunk,
  segmentStarts,
  sourceRanges,
  windowAround,
} from './narration-audition'
import { decodedTake, type TakeAudio } from './narration-decode'
import { wav } from './wav-fixture'

const S = SAMPLE_RATE

const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id'>): NarrationClip => ({
  mediaId: 'a',
  srcStart: 0,
  srcEnd: 10 * S,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})

const op = (
  clips: NarrationClip[],
  narration: Partial<NarrationOp['tracks']['narration']> = {},
): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false, ...narration },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})

/** Seeded noise, so takes have distinct samples everywhere. */
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31
    out[i] = Math.fround((x / 2 ** 31) * 2 - 1) / 2
  }
  return out
}

describe('scheduling math', () => {
  it('starts each chunk on its sample boundary, joining a playing one at a whole-sample offset', () => {
    const anchor = { sample: 2.5 * S, ctxTime: 10 }
    expect(planChunks(anchor, 10, 1.5, [0, 1, 2])).toEqual([{ chunk: 0, when: 10, offsetSamples: 2.5 * S }])
    // Two seconds later chunk 1 (starting at composition 5 s, ctx 12.5) is inside the horizon.
    expect(planChunks(anchor, 12, 1.5, [0, 1, 2])).toEqual([
      { chunk: 0, when: 12, offsetSamples: 4.5 * S },
      { chunk: 1, when: 12.5, offsetSamples: 0 },
    ])
    // A chunk that has ended, or starts past the horizon, isn't started.
    expect(planChunks(anchor, 13, 1, [0, 2])).toEqual([])
    // A fractional "now" rounds the offset up to the next whole sample and moves the start with it.
    const [late] = planChunks({ sample: 0, ctxTime: 0 }, 0.10001, 1, [0])
    expect(late?.offsetSamples).toBe(Math.ceil(0.10001 * S))
    expect(late?.when).toBeCloseTo((late?.offsetSamples ?? 0) / S, 12)
  })

  it('places segments (crossfade handles included) in chunks and context time', () => {
    const a = clip({ id: 'a', start: 2 * S, srcStart: 1000, srcEnd: 1000 + 4 * S })
    const b = clip({ id: 'b', mediaId: 'b', start: clipEnd(a), srcStart: 1000, srcEnd: 1000 + 3 * S })
    const segs = segments(
      [a, b],
      new Map([
        ['a', 20 * S],
        ['b', 20 * S],
      ]),
    )
    expect(segs.map((s) => s.tail.kind)).toEqual(['xfade', 'none'])
    expect(segmentStarts(segs, { sample: 0, ctxTime: 10 })).toEqual([
      { id: 'a', when: 12, chunk: 0, offsetInChunk: 2 * S, endsAt: 6 * S },
      // b's head handle sounds 10 ms before its start; it lands in chunk 1 at 6 s - 240 samples - 5 s.
      { id: 'b', when: 10 + (6 * S - 240) / S, chunk: 1, offsetInChunk: S - 240, endsAt: 9 * S },
    ])
    expect(audibleChunks(segs, [0, 100 * S])).toEqual([0, 1])
    // The window from 5.5 s reads a's tail handle past its srcEnd and b from its own handle.
    expect(sourceRanges(segs, [5.5 * S, 30 * S])).toEqual(
      new Map([
        ['a', [[1000 + 3.5 * S, 1000 + 4 * S + 240]]],
        ['b', [[1000 - 240, 1000 + 3 * S]]],
      ]),
    )
  })

  it('leaves silent clips out of the window', () => {
    const segs = segments([clip({ id: 'q', gainDb: null, start: 20 * S })], new Map([['a', 20 * S]]))
    expect(audibleChunks(segs, windowAround(20 * S))).toEqual([])
    expect(windowAround(5 * S)).toEqual([0, 35 * S])
  })
})

describe('rendered bus', () => {
  it('matches the run mixer sample for sample, across chunk boundaries', () => {
    const pcm = new Map([
      ['a', noise(20 * S, 1)],
      ['b', noise(8 * S, 2)],
    ])
    const c1 = clip({ id: 'c1', start: 1000, srcStart: 500, srcEnd: 500 + 5 * S, fadeInSamples: 2000 })
    const c2 = clip({
      id: 'c2',
      mediaId: 'b',
      start: clipEnd(c1),
      srcStart: 1000,
      srcEnd: 50_000,
      gainDb: -6,
    })
    const c3 = clip({ id: 'c3', start: 9 * S, srcStart: 0, srcEnd: S, gainDb: null })
    const c4 = clip({
      id: 'c4',
      start: 12 * S,
      srcStart: 2 * S,
      srcEnd: 6 * S,
      fadeOutSamples: 9000,
      gainDb: 3,
    })
    // c5 overlaps c4: resolve trims c4 exactly as the run does.
    const c5 = clip({ id: 'c5', mediaId: 'b', start: 13 * S, srcStart: 0, srcEnd: S })
    const clips = [c1, c2, c3, c4, c5]
    const lengths = new Map([...pcm].map(([id, p]) => [id, p.length]))
    const segs = segments(clips, lengths)
    const takes = new Map<string, TakeAudio>([...pcm].map(([id, p]) => [id, decodedTake(p)]))
    const n = 4
    const want = mixToBuffer(clips, pcm, n * CHUNK_SAMPLES)
    for (let k = 0; k < n; k++) {
      const got = renderChunk(segs, k, takes)
      for (let i = 0; i < CHUNK_SAMPLES; i++)
        if (got[i] !== want[k * CHUNK_SAMPLES + i])
          throw new Error(`chunk ${k} sample ${i}: ${got[i]} != ${want[k * CHUNK_SAMPLES + i]}`)
    }
    expect(audibleChunks(segs, [0, n * CHUNK_SAMPLES])).toEqual([0, 1, 2, 3])
  })
})

// ---- a minimal Web Audio fake

class Param {
  value = 0
  setTargetAtTime(v: number) {
    this.value = v
  }
}
class Node {
  out: unknown[] = []
  connect(n: unknown) {
    this.out.push(n)
    return n
  }
  disconnect() {
    this.out = []
  }
}
class Source extends Node {
  buffer: { data: Float32Array } | null = null
  started: [number, number] | null = null
  stopped = false
  onended: (() => void) | null = null
  start(when: number, offset: number) {
    this.started = [when, offset]
  }
  stop() {
    this.stopped = true
  }
}
class Ctx {
  currentTime = 100
  state = 'running'
  outputLatency = 0
  baseLatency = 0
  destination = new Node()
  sources: Source[] = []
  buses: (Node & { gain: Param })[] = []
  filters: (Node & { type: string; frequency: Param })[] = []
  compressors: (Node & Record<'ratio' | 'threshold' | 'attack' | 'release' | 'knee', Param>)[] = []
  createGain() {
    const g = Object.assign(new Node(), { gain: new Param() })
    this.buses.push(g)
    return g
  }
  createBufferSource() {
    const s = new Source()
    this.sources.push(s)
    return s
  }
  createBuffer(_ch: number, length: number, rate: number) {
    expect(rate).toBe(SAMPLE_RATE)
    const data = new Float32Array(length)
    return { data, copyToChannel: (src: Float32Array) => data.set(src) }
  }
  createBiquadFilter() {
    const f = Object.assign(new Node(), { type: '', frequency: new Param() })
    this.filters.push(f)
    return f
  }
  createDynamicsCompressor() {
    const c = Object.assign(new Node(), {
      ratio: new Param(),
      threshold: new Param(),
      attack: new Param(),
      release: new Param(),
      knee: new Param(),
    })
    this.compressors.push(c)
    return c
  }
  async resume() {
    this.state = 'running'
  }
  async close() {}
}

function engine(files: Record<string, ArrayBuffer>, extra: { budgetBytes?: number } = {}) {
  const ctx = new Ctx()
  const events: { event: string; fields: Record<string, unknown> }[] = []
  let decodes = 0
  const e = new NarrationAudition({
    loadTake: async (id) => {
      const f = files[id]
      if (!f) throw new Error(`no ${id}`)
      return f
    },
    createContext: () => ctx as unknown as AudioContext,
    decode: async (b) => {
      decodes++
      return new Float32Array(b.byteLength * 100)
    },
    log: (event, fields) => events.push({ event, fields }),
    setInterval: () => 1,
    clearInterval: () => undefined,
    ...extra,
  })
  return { e, ctx, events, decodes: () => decodes }
}

/** A mono 24 kHz PCM16 take of `seconds`, a constant level. */
const take = (seconds: number, level = 1000) => wav([new Array<number>(seconds * S).fill(level)])

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('engine', () => {
  it('loads the window, schedules chunks on the preview clock and re-anchors on a seek', async () => {
    const { e, ctx, events, decodes } = engine({ a: take(20) })
    e.setOp(op([clip({ id: 'c', start: 2 * S })]), new Map([['a', 20 * S]]))
    await e.ready(0)
    // The clip sounds 2-12 s: chunks 0, 1 and 2 (to 15 s) are rendered; the WAV was sliced, not decoded.
    expect(e.stats()).toMatchObject({ takes: 1, slicedTakes: 1, chunks: 3, fetches: 1, decodes: 0 })
    expect(decodes()).toBe(0)

    await e.play(0)
    const first = ctx.sources[0]
    // Composition 0 is on screen now (ctx 100); 50 ms later the picture is at 0.05 s, so chunk 0 starts there.
    expect(first?.started?.[0]).toBeCloseTo(100.05, 9)
    expect(first?.started?.[1]).toBeCloseTo(0.05, 9)
    expect(first?.buffer?.data[2 * S]).toBeCloseTo(1000 / 32768, 6)
    expect(first?.buffer?.data[2 * S - 1]).toBe(0)

    ctx.currentTime = 104.5
    e.clock(4.5) // in step: chunk 1 (5 s) now falls inside the schedule horizon
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1]?.started?.[0]).toBeCloseTo(105, 9)
    expect(ctx.sources[1]?.started?.[1]).toBe(0)

    e.clock(11) // the person seeked: everything playing stops and restarts from 11 s
    expect(events.map((x) => x.event)).toContain('audition.resync')
    expect(ctx.sources.slice(0, 2).every((s) => s.stopped)).toBe(true)
    const again = ctx.sources[2]
    expect(again?.started?.[1]).toBeCloseTo(((11.05 * S) % CHUNK_SAMPLES) / S, 9)

    e.pause()
    expect(ctx.sources.every((s) => s.stopped)).toBe(true)
  })

  it('applies narration volume and mute live, without re-rendering', async () => {
    const { e, ctx } = engine({ a: take(5) })
    const lengths = new Map([['a', 5 * S]])
    e.setOp(op([clip({ id: 'c', srcEnd: 5 * S })], { volumeDb: -6 }), lengths)
    await e.play(0)
    const bus = ctx.buses[0]
    expect(bus?.gain.value).toBeCloseTo(10 ** (-6 / 20), 9)
    await e.ready(0)
    const chunks = e.stats().chunks
    e.setOp(op([clip({ id: 'c', srcEnd: 5 * S })], { muted: true }), lengths)
    expect(bus?.gain.value).toBe(0)
    expect(e.stats().chunks).toBe(chunks)
  })

  it('keeps memory under the budget, evicting what the window no longer needs', async () => {
    const tenSeconds = take(10).byteLength
    const budget = tenSeconds + 2 * CHUNK_SAMPLES * 4 + 1024
    const { e } = engine({ a: take(10), b: take(10) }, { budgetBytes: budget })
    const lengths = new Map([
      ['a', 10 * S],
      ['b', 10 * S],
    ])
    e.setOp(op([clip({ id: 'x' }), clip({ id: 'y', mediaId: 'b', start: 120 * S })]), lengths)
    await e.ready(0)
    expect(e.stats()).toMatchObject({ takes: 1, chunks: 2, evictions: 0 })
    await e.ready(121)
    const s = e.stats()
    expect(s).toMatchObject({ takes: 1, chunks: 2, evictions: 3, overBudgetBytes: 0 })
    expect(s.usedBytes).toBeLessThanOrEqual(budget)
    await e.ready(0) // back again: a is fetched once more
    expect(e.stats().fetches).toBe(3)
  })

  it('decodes a take that is not 24 kHz PCM16 WAV', async () => {
    const { e, decodes } = engine({ a: new Uint8Array(4800).buffer })
    e.setOp(op([clip({ id: 'c', srcEnd: S })]), new Map([['a', 480_000]]))
    await e.ready(0)
    expect(decodes()).toBe(1)
    expect(e.stats()).toMatchObject({ takes: 1, slicedTakes: 0, decodes: 1 })
  })

  it('re-renders when the clips change and plays nothing for a null op', async () => {
    const { e } = engine({ a: take(5) })
    const lengths = new Map([['a', 5 * S]])
    e.setOp(op([clip({ id: 'c', srcEnd: 5 * S })]), lengths)
    await e.ready(0)
    e.setOp(op([clip({ id: 'c', srcEnd: 5 * S, start: 7 * S })]), lengths)
    await flush()
    await e.ready(0)
    expect(e.stats().chunks).toBe(2) // 7-12 s: chunks 1 and 2, the old chunk 0 dropped
    e.setOp(null, lengths)
    expect(e.stats().chunks).toBe(0)
  })

  it('routes the bus through the approximate cleanup chain and back', async () => {
    const { e, ctx } = engine({ a: take(5) })
    e.setOp(op([clip({ id: 'c', srcEnd: 5 * S })]), new Map([['a', 5 * S]]))
    await e.play(0)
    const bus = ctx.buses[0]
    expect(bus?.out).toEqual([ctx.destination])
    await e.setApproxCleanup(true)
    expect(e.approxCleanup).toBe(true)
    const [hp] = ctx.filters
    const [comp] = ctx.compressors
    expect(bus?.out).toEqual([hp])
    expect(hp?.type).toBe('highpass')
    expect(hp?.frequency.value).toBe(80)
    expect(hp?.out).toEqual([comp])
    expect({
      ratio: comp?.ratio.value,
      threshold: comp?.threshold.value,
      attack: comp?.attack.value,
      release: comp?.release.value,
      knee: comp?.knee.value,
    }).toEqual(APPROX_CLEANUP.compressor)
    // No AudioWorklet here: the expander is left out and the compressor goes straight out.
    expect(comp?.out).toEqual([ctx.destination])
    await e.setApproxCleanup(false)
    expect(bus?.out).toEqual([ctx.destination])
    expect(RAW_LABEL).toBe('raw, before cleanup')
    expect(APPROX_CLEANUP_DESCRIPTION).toMatch(/approximate/i)
  })
})
