// The stem monitor (stem-monitor.ts) on a minimal fake AudioContext (Node has no Web Audio): a start from the picture
// anchors starts each stem at its offset, replace mode schedules no AI voice, existing narration plays as rendered
// chunks through a bus the armed range mutes, a drifting picture restarts everything seamlessly, and speakers mode
// sets the master level.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IDENTITY_FIT, SAMPLE_RATE, dbToGain, type NarrationOp } from '../../../../server/lib/timeline'
import { wav } from '../../lib/wav-fixture'
import type { OutputMap } from '../clock/monitor-schedule'
import type { Anchor } from '../clock/picture'
import { createStemMonitor, type StemMonitorOptions } from './stem-monitor'

const S = SAMPLE_RATE
const HTML = readFileSync(
  new URL('../../../../test/fixtures/contract1-voice/index.html', import.meta.url),
  'utf8',
)
const FRAME_MS = 1000 / 30

class Param {
  value = 0
  events: { kind: string; at: number; value: number }[] = []
  setValueAtTime(value: number, at: number) {
    this.events.push({ kind: 'set', at, value })
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push({ kind: 'ramp', at, value })
  }
  cancelScheduledValues() {
    this.events = []
  }
}
class Node {
  out: unknown[] = []
  connect<T>(n: T): T {
    this.out.push(n)
    return n
  }
  disconnect() {
    this.out = []
  }
}
class Source extends Node {
  buffer: { duration: number; tag?: string } | null = null
  started: number[] | null = null
  stoppedAt: number | undefined | null = null
  onended: (() => void) | null = null
  start(...args: number[]) {
    this.started = args
  }
  stop(at?: number) {
    this.stoppedAt = at
  }
}
class Ctx {
  currentTime = 50
  sampleRate = 48_000
  destination = new Node()
  sources: Source[] = []
  gains: (Node & { gain: Param })[] = []
  createGain() {
    const g = Object.assign(new Node(), { gain: new Param() })
    this.gains.push(g)
    return g
  }
  createBufferSource() {
    const s = new Source()
    this.sources.push(s)
    return s
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length)
    return {
      duration: length / rate,
      tag: 'chunk',
      data,
      copyToChannel: (src: Float32Array) => data.set(src),
    }
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    const tag = new TextDecoder().decode(bytes)
    return { duration: 20, length: 20 * 48_000, numberOfChannels: 1, tag }
  }
}

/** Context time ct is heard at perf 1000·ct (no output latency), drifting `ppm`. */
const out = (ppm = 0): OutputMap => ({
  outputContextToPerf: (ct) => 1000 * ct * (1 + ppm * 1e-6),
  perfToOutputContext: (p) => p / (1000 * (1 + ppm * 1e-6)),
})
/** Frames of a picture showing composition `from + k/30` at perf `perf0 + k·frame`. */
const anchors = (n: number, from: number, perf0: number): Anchor[] =>
  Array.from({ length: n }, (_, k) => {
    const e = perf0 + k * FRAME_MS
    return { mediaTime: from + k / 30, expectedDisplayTime: e, now: e, presentedFrames: k + 1 }
  })

const op = (mode: 'replace' | 'keep'): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips: [
    {
      id: 'n1',
      mediaId: 'take1',
      srcStart: 0,
      srcEnd: S,
      fit: IDENTITY_FIT,
      offsetSamples: 0,
      start: 4 * S,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ],
  tracks: {
    narration: { volumeDb: -6, muted: false, solo: false },
    aiVoice: { mode, volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})

function monitor(extra: Partial<StemMonitorOptions> = {}) {
  const ctx = new Ctx()
  const events: string[] = []
  const take = wav([Array.from({ length: S }, (_, i) => Math.round(Math.sin(i / 10) * 8000))])
  const m = createStemMonitor({
    context: ctx as unknown as AudioContext,
    clock: out(),
    html: HTML,
    op: op('replace'),
    takeSamples: new Map([['take1', S]]),
    takeLoader: async () => take,
    stemLoader: async (src) => new TextEncoder().encode(src).buffer,
    outputMode: 'headphones',
    log: (e) => events.push(e),
    now: () => ctx.currentTime * 1000,
    setInterval: () => 1,
    clearInterval: () => undefined,
    ...extra,
  })
  return { ctx, m, events }
}
const stemSources = (ctx: Ctx) => ctx.sources.filter((s) => s.buffer?.tag !== 'chunk')
const tags = (ctx: Ctx) => stemSources(ctx).map((s) => s.buffer?.tag)

describe('stem monitor', () => {
  it('starts each stem at its offset from the anchors, with no AI voice in replace mode', async () => {
    const { ctx, m, events } = monitor()
    await m.prepare(0)
    expect(m.start(anchors(9, 0, 50_000))).toBeNull()
    // The picture showed composition 0 at perf 50000 (= context 50): planned 0.25 s ahead, at composition 0.25.
    const a = anchors(10, 0, 50_000)
    ctx.currentTime = 50.4
    const plan = m.start(a)!
    expect(plan.when).toBeCloseTo(50.65, 9)
    expect(plan.offset).toBeCloseTo(0.65, 9)
    expect(tags(ctx)).toEqual(['assets/media/med_theme01.mp3'])
    const [music] = stemSources(ctx)
    expect(music?.started?.[0]).toBeCloseTo(50.65, 9)
    expect(music?.started?.[1]).toBeCloseTo(0.65, 9)
    expect(music?.started?.[2]).toBeCloseTo(9 - 0.65, 9)
    expect(events).toContain('monitor.start')
    expect(m.stats()).toMatchObject({ running: true, level: 1, failures: 0 })
  })

  it('plays every AI voice in keep mode, each at its own time', async () => {
    const { ctx, m } = monitor({ op: op('keep') })
    await m.prepare(0)
    m.start(anchors(10, 0, 50_000))
    ctx.currentTime = 50
    const started = new Map(stemSources(ctx).map((s) => [s.buffer?.tag, s.started]))
    expect([...started.keys()]).toEqual([
      'assets/media/med_theme01.mp3',
      'assets/voice/intro.wav',
      'assets/voice/outro.wav',
    ])
    // Composition 0.25 is heard at context 50.25 (this plan): voice-outro (6.2 s) starts 5.95 s later.
    expect(started.get('assets/voice/outro.wav')?.[0]).toBeCloseTo(50.25 + 5.95, 9)
    expect(started.get('assets/voice/intro.wav')?.[0]).toBeCloseTo(50.25 + 0.05, 9)
  })

  it('plays existing narration as rendered chunks through its track level, muted inside the armed range', async () => {
    const { ctx, m } = monitor()
    await m.prepare(3)
    // Start with the picture at composition 3.0: the clip at 4 s is in chunk 0, joined 3.25 s in.
    const plan = m.start(anchors(10, 3, 50_000))!
    const chunk = ctx.sources.find((s) => s.buffer?.tag === 'chunk')
    expect(chunk?.started?.[0]).toBeCloseTo(plan.when, 9)
    expect(chunk?.started?.[1]).toBeCloseTo(plan.offset, 4)
    // The bus carries the narration track's -6 dB; the arm gain after it starts open.
    const [, bus, arm] = ctx.gains
    expect(bus?.gain.value).toBeCloseTo(dbToGain(-6), 12)
    expect(arm?.gain.events).toEqual([{ kind: 'set', at: 50, value: 1 }])
    m.setArmedRange([4 * S, Infinity])
    expect(arm?.gain.events.at(-1)).toEqual({
      kind: 'ramp',
      at: expect.closeTo(plan.when + (4 - plan.offset), 9),
      value: 0,
    })
    m.setArmedRange(null)
    expect(arm?.gain.events).toEqual([{ kind: 'set', at: 50, value: 1 }])
  })

  it('restarts every source on drift, the old ones stopping exactly when the new ones start', async () => {
    const { ctx, m, events } = monitor({ clock: out(0) })
    await m.prepare(0)
    const a = anchors(10, 0, 50_000)
    m.start(a)
    const first = stemSources(ctx)[0]!
    // The picture runs 8 ms ahead of the monitor from now on: a resync once 10 anchors agree.
    const late = anchors(30, 0, 50_000).map((x, k) => (k < 10 ? x : { ...x, mediaTime: x.mediaTime + 0.008 }))
    let check = null
    let seen: Anchor[] = []
    for (let k = 11; k <= 30 && !check?.resync; k++) {
      ctx.currentTime = late[k - 1]!.expectedDisplayTime / 1000
      seen = late.slice(0, k)
      check = m.resync(seen)
    }
    expect(check?.why).toBe('drift')
    const second = stemSources(ctx)[1]!
    expect(first.stoppedAt).toBeCloseTo(second.started![0]!, 12)
    expect(events).toContain('monitor.resync')
    expect(m.stats().resyncs).toBe(1)
    // The same anchor again isn't a new measurement.
    expect(m.resync(seen)).toBeNull()
  })

  it('ducks the whole monitor to -30 dB on speakers, or mutes it, and stops cleanly', async () => {
    expect(monitor({ outputMode: 'speakers' }).ctx.gains[0]?.gain.value).toBeCloseTo(dbToGain(-30), 12)
    expect(monitor({ outputMode: 'speakers', speakersLevelDb: null }).ctx.gains[0]?.gain.value).toBe(0)
    const { ctx, m } = monitor()
    await m.prepare(0)
    m.start(anchors(10, 0, 50_000))
    m.stop()
    expect(stemSources(ctx).every((s) => s.stoppedAt === undefined)).toBe(true)
    expect(m.stats().running).toBe(false)
  })

  it('logs a stem that fails to load and plays the rest', async () => {
    const { ctx, m, events } = monitor({
      op: op('keep'),
      stemLoader: async (src) => {
        if (src.includes('intro')) throw new Error('403')
        return new TextEncoder().encode(src).buffer
      },
    })
    await m.prepare(0)
    m.start(anchors(10, 0, 50_000))
    expect(tags(ctx)).toEqual(['assets/media/med_theme01.mp3', 'assets/voice/outro.wav'])
    expect(events).toContain('monitor.load_failed')
    expect(m.stats().failures).toBe(1)
  })
})
