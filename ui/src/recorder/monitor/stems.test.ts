// The monitor mix's stems (stems.ts): which composition <audio> plays per AI voice mode, the pre-ducked music lane
// from existing narration only, start offsets per stem at a picture time, gain automation, the armed punch range and
// speakers-mode levels. On the contract-1 voice fixture: music over 9 s (level 0.8, data-va-duck 0.3, fades 1 s and
// 1.5 s), voice-intro at 0.3-2.5 s, voice-outro at 6.2-7.7 s.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  IDENTITY_FIT,
  SAMPLE_RATE,
  dbToGain,
  type NarrationClip,
  type NarrationOp,
} from '../../../../src/lib/timeline'
import {
  ARM_RAMP_SEC,
  armedRangeEvents,
  laneAt,
  monitorLevel,
  monitorStems,
  stemGainAt,
  stemGainEvents,
  stemStart,
  type MonitorStem,
} from './stems'

const S = SAMPLE_RATE
const HTML = readFileSync(
  new URL('../../../../test/fixtures/contract1-voice/index.html', import.meta.url),
  'utf8',
)

const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id'>): NarrationClip => ({
  mediaId: 'take1',
  srcStart: 0,
  srcEnd: S,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})
const op = (clips: NarrationClip[], mode: 'replace' | 'under' | 'keep' = 'replace'): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode, volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})
const byId = (stems: MonitorStem[]) => new Map(stems.map((s) => [s.id, s]))
/** Where the lane dips below full: [start, end] pairs of its points at the ducked level. */
const dips = (lane: { t: number; v: number }[] | null) => (lane ?? []).filter((p) => p.v < 1).map((p) => p.t)

describe('stems by AI voice mode', () => {
  it('replace plays music only; keep adds every AI voice at its level; under lowers it', () => {
    const replace = monitorStems(HTML, null, { aiVoice: { mode: 'replace', volumeDb: -12 } })
    expect(replace.map((s) => [s.id, s.role])).toEqual([['music', 'music']])
    const keep = byId(monitorStems(HTML, null, { aiVoice: { mode: 'keep', volumeDb: -12 } }))
    expect([...keep.keys()]).toEqual(['music', 'voice-intro', 'voice-outro'])
    expect(keep.get('voice-intro')).toMatchObject({ role: 'voice', gain: 1, start: 0.3, duration: 2.2 })
    // A beat's audio is placed at the beat's start plus its beat-local data-start.
    expect(keep.get('voice-outro')).toMatchObject({
      start: 6.2,
      duration: 1.5,
      src: 'assets/voice/outro.wav',
    })
    const under = byId(monitorStems(HTML, null, { aiVoice: { mode: 'under', volumeDb: -12 } }))
    expect(under.get('voice-intro')?.gain).toBeCloseTo(Math.round(dbToGain(-12) * 100) / 100, 9)
  })

  it("follows the op's tracks without a take choice, and Mute all original audio leaves nothing", () => {
    expect(monitorStems(HTML, op([], 'keep')).map((s) => s.id)).toEqual([
      'music',
      'voice-intro',
      'voice-outro',
    ])
    expect(monitorStems(HTML, op([]), { aiVoice: { mode: 'keep', volumeDb: 0 }, muteAll: true })).toEqual([])
    // A track the person muted stays out.
    const muted = HTML.replace('id="music"', 'id="music" data-va-muted data-va-volume="0.8"').replace(
      'data-volume="0.8"',
      'data-volume="0"',
    )
    expect(monitorStems(muted, null, { aiVoice: { mode: 'keep', volumeDb: 0 } }).map((s) => s.id)).toEqual([
      'voice-intro',
      'voice-outro',
    ])
    expect(monitorStems('<p>not a composition</p>', null)).toEqual([])
  })
})

describe('pre-ducked music', () => {
  it('ducks only under existing narration in replace mode, never under the muted AI voice', () => {
    // No narration yet and the AI voice replaced: the music plays flat (the take being recorded never feeds it).
    const flat = monitorStems(HTML, null, { aiVoice: { mode: 'replace', volumeDb: -12 } })[0]
    expect(flat?.gain).toBe(0.8)
    expect(dips(flat?.lane ?? null)).toEqual([])
    // An existing clip at 4-5 s: one dip there, at duckDb (-12 dB), nowhere near the voices.
    const existing = op([clip({ id: 'n1', start: 4 * S })])
    const lane = monitorStems(HTML, existing)[0]?.lane ?? null
    expect(dips(lane)).toEqual([4, 5])
    expect(laneAt(lane, 4.5)).toBeCloseTo(Math.min(1, dbToGain(-12)), 9)
    expect(laneAt(lane, 1)).toBe(1)
  })

  it('ducks under the AI voices still audible in keep mode, as the render does', () => {
    const lane = monitorStems(HTML, op([clip({ id: 'n1', start: 4 * S })], 'keep'))[0]?.lane ?? null
    // The clip (4-5 s) and voice-outro (6.2 s) are closer than DUCK_RELEASE_MS: one dip, so the music doesn't pump.
    expect(dips(lane)).toEqual([0.3, 2.5, 4, 7.7])
  })

  it("keeps the layer's own lane when the op doesn't duck and the layer has no level", () => {
    const o = op([])
    o.tracks.music.duck = false
    const html = HTML.replace(' data-va-duck="0.3"', '')
    const lane = monitorStems(html, o)[0]?.lane ?? null
    // The fixture's authored lane, as written.
    expect(lane?.slice(0, 3)).toEqual([
      { t: 0, v: 1 },
      { t: 0.05, v: 1 },
      { t: 0.3, v: 0.3 },
    ])
  })
})

describe('scheduling at a picture time', () => {
  const stems = byId(monitorStems(HTML, null, { aiVoice: { mode: 'keep', volumeDb: 0 } }))
  const music = stems.get('music')!
  const intro = stems.get('voice-intro')!
  const outro = stems.get('voice-outro')!

  it('starts each stem at its offset: playing ones join at when, later ones start later, ended ones not at all', () => {
    const plan = { when: 10, offset: 2 }
    expect(stemStart(music, plan)).toEqual({ id: 'music', when: 10, offset: 2, duration: 7 })
    expect(stemStart(intro, plan)).toEqual({
      id: 'voice-intro',
      when: 10,
      offset: expect.closeTo(1.7, 12),
      duration: expect.closeTo(0.5, 12),
    })
    expect(stemStart(outro, plan)).toEqual({ id: 'voice-outro', when: 14.2, offset: 0, duration: 1.5 })
    expect(stemStart(intro, { when: 10, offset: 3 })).toBeNull()
    // From the top, everything starts at its own composition time.
    expect([music, intro, outro].map((s) => stemStart(s, { when: 1, offset: 0 })?.when)).toEqual([
      1, 1.3, 7.2,
    ])
    // No data-duration: it plays to the end of the file.
    expect(stemStart({ ...outro, duration: Infinity }, plan)?.duration).toBeNull()
  })

  it('automates level × lane × fades with exact linear ramps in context time', () => {
    const flat = { ...music, lane: null }
    expect(stemGainAt(flat, 0.5)).toBeCloseTo(0.4, 12)
    expect(stemGainAt(flat, 4)).toBe(0.8)
    expect(stemGainAt(flat, 8.25)).toBeCloseTo(0.4, 12)
    expect(stemGainAt(flat, 9)).toBe(0)
    // From the top: 0 at the start, up to 0.8 at 1 s, held, then down to 0 at the end.
    expect(stemGainEvents(flat, { when: 20, offset: 0 })).toEqual([
      { kind: 'set', at: 20, value: 0 },
      { kind: 'ramp', at: 21, value: 0.8 },
      { kind: 'ramp', at: 27.5, value: 0.8 },
      { kind: 'ramp', at: 29, value: 0 },
    ])
    // Joining at 0.5 s: half way up the fade.
    expect(stemGainEvents(flat, { when: 20, offset: 0.5 })[0]).toEqual({
      kind: 'set',
      at: 20,
      value: expect.closeTo(0.4, 12),
    })
    // The lane's points become ramps at their composition times (here the dip at 4-5 s).
    const ducked = monitorStems(HTML, op([clip({ id: 'n1', start: 4 * S })]))[0]!
    const ev = stemGainEvents(ducked, { when: 100, offset: 2 })
    expect(ev.find((e) => Math.abs(e.at - 102) < 1e-9)?.value).toBeCloseTo(0.8 * dbToGain(-12), 9)
  })
})

describe('armed punch range', () => {
  const plan = { when: 10, offset: 1 }
  it('mutes existing narration from the punch point to the range end, with short ramps', () => {
    // Range 3-4 s composition = context 12-13.
    expect(armedRangeEvents([3 * S, 4 * S], plan, 10.5)).toEqual([
      { kind: 'set', at: 10.5, value: 1 },
      { kind: 'set', at: 12 - ARM_RAMP_SEC, value: 1 },
      { kind: 'ramp', at: 12, value: 0 },
      { kind: 'set', at: 13, value: 0 },
      { kind: 'ramp', at: 13 + ARM_RAMP_SEC, value: 1 },
    ])
  })
  it('mutes at once inside the range, until stop with an open end, and not at all without one', () => {
    expect(armedRangeEvents([3 * S, Infinity], plan, 12.5)).toEqual([
      { kind: 'set', at: 12.5, value: 0 },
      { kind: 'ramp', at: 12.5, value: 0 },
    ])
    expect(armedRangeEvents([0, S], plan, 12.5)).toEqual([{ kind: 'set', at: 12.5, value: 1 }])
    expect(armedRangeEvents(null, plan, 12.5)).toEqual([{ kind: 'set', at: 12.5, value: 1 }])
  })
})

describe('output mode levels', () => {
  it('plays at full level on headphones; ducks to -30 dB on speakers, or mutes', () => {
    expect(monitorLevel('headphones')).toBe(1)
    expect(monitorLevel('speakers')).toBeCloseTo(dbToGain(-30), 12)
    expect(monitorLevel('speakers', -20)).toBeCloseTo(0.1, 12)
    expect(monitorLevel('speakers', null)).toBe(0)
  })
})
