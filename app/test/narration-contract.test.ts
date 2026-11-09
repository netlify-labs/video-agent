// Recorded narration in the editing contract (plan 2026-11-02 §6.2): the narration role, the one bus layer and its
// writer, draft vs materialized validation, speech spans, relayout and the AI voice modes.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  applyNarration,
  load,
  MAX_SPEECH_SPANS,
  NARRATION_SRC,
  read,
  speechSeconds,
  validate,
  type Summary,
} from '../server/lib/contract.js'
import {
  IDENTITY_FIT,
  SAMPLE_RATE as S,
  type NarrationClip,
  type NarrationOp,
  type NarrationTracks,
  type Span,
} from '../server/lib/timeline.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
/** Music ducked under voices in intro and outro, 9 s, three beats. */
const html = fx('index.html')
const summary = JSON.parse(fx('summary.json')) as Summary

const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id'>): NarrationClip => ({
  mediaId: 'take1',
  srcStart: 0,
  srcEnd: 2 * S,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})
const op = (clips: NarrationClip[], t: Partial<NarrationTracks> = {}): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'keep', volumeDb: -6 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
    ...t,
  },
  cleanup: 'light',
})
const one = op([clip({ id: 'a', start: S })])
const takes = new Map<string, Span[]>([['take1', [[S / 2, (3 * S) / 2]]]])
const bus = (h: string) => /<audio id="va-narration"[^>]*><\/audio>/.exec(h)?.[0] ?? ''
const speech = (h: string) =>
  JSON.parse(/data-va-speech="([^"]*)"/.exec(bus(h))?.[1]?.replace(/&quot;/g, '"') ?? 'null') as unknown
const track = (h: string, id: string) => read(load(h)).audio.find((a) => a.id === id)

describe('narration role and bus layer', () => {
  it('writes one bus layer that validates as a draft and reads as narration', () => {
    const out = applyNarration(html, summary, one, takes)
    expect(bus(out.html)).toBe(
      `<audio id="va-narration" data-va-layer="narration" data-va-audio="narration" data-track-index="4" data-start="0" data-duration="9" data-volume="1" data-va-speech="[[1.5,2.5]]" src="${NARRATION_SRC}"></audio>`,
    )
    expect(out.html.match(/data-va-layer="narration"/g)).toHaveLength(1)
    // A direct child of the root, after what was there.
    expect(
      load(out.html).root.childNodes.some(
        (n) => 'tagName' in n && n.attrs.some((a) => a.value === 'va-narration'),
      ),
    ).toBe(true)
    expect(validate(out.html, summary)).toEqual([])
    expect(out.composition.layers).toContain('narration')
    expect(out.composition.audio.find((a) => a.id === 'va-narration')).toEqual({
      id: 'va-narration',
      role: 'narration',
      label: null,
      src: NARRATION_SRC,
      volume: 1,
      muted: false,
      beat: null,
    })
    // The layer alone (no data-va-audio) still reads as narration, not an effect.
    expect(track(out.html.replace(' data-va-audio="narration"', ''), 'va-narration')?.role).toBe('narration')
  })

  it('replaces the bus in place and removes it, leaving the composition as it was', () => {
    const first = applyNarration(html, summary, one, takes).html
    const second = applyNarration(first, summary, op([clip({ id: 'b', start: 5 * S })]), takes).html
    expect(second.match(/id="va-narration"/g)).toHaveLength(1)
    expect(speech(second)).toEqual([[5.5, 6.5]])
    expect(second.indexOf('va-narration')).toBe(first.indexOf('va-narration'))
    const removed = applyNarration(second, summary, null).html
    expect(removed).not.toContain('narration"')
    expect(removed).toBe(applyNarration(html, summary, null).html)
  })

  it('speech comes from each take summary; a take without one counts throughout; muted narration has none', () => {
    const two = op([
      clip({ id: 'a', start: S }),
      clip({ id: 'b', mediaId: 'take2', start: 5 * S, srcEnd: S }),
    ])
    expect(speech(applyNarration(html, summary, two, takes).html)).toEqual([
      [1.5, 2.5],
      [5, 6],
    ])
    const muted = op(one.clips, { narration: { volumeDb: 0, muted: true, solo: false } })
    expect(speech(applyNarration(html, summary, muted, takes).html)).toEqual([])
    // A silent clip (gain null) says nothing.
    expect(speech(applyNarration(html, summary, op([clip({ id: 'a', gainDb: null })]), takes).html)).toEqual(
      [],
    )
  })

  it('validates a draft without its bus file and a materialized bus to within a frame of the root', () => {
    const out = applyNarration(html, summary, one, takes).html
    expect(validate(out, summary, { narration: 'draft' })).toEqual([])
    expect(validate(out, summary, { narration: { busSamples: 9 * S } })).toEqual([])
    expect(validate(out, summary, { narration: { busSamples: 9 * S - 700 } })).toEqual([])
    expect(validate(out, summary, { narration: { busSamples: 9 * S + 801 } })).toContainEqual(
      expect.stringMatching(/bus is 9.033375s but the video is 9s/),
    )
    expect(validate(html, summary, { narration: { busSamples: 9 * S } })).toContainEqual(
      expect.stringMatching(/no narration layer/),
    )
    // Without narration, the default and draft are today's validator.
    expect(validate(html, summary)).toEqual([])
  })

  it.each([
    [
      'two buses',
      (h: string) => h.replace(bus(h), bus(h) + bus(h).replace('va-narration', 'va-narration-2')),
      /more than one narration layer/,
    ],
    [
      'another file',
      (h: string) => h.replace(NARRATION_SRC, 'assets/media/med_x.wav'),
      /must play assets\/narration\/bus\.wav/,
    ],
    ['another id', (h: string) => h.replace('id="va-narration"', 'id="vo"'), /<audio id="va-narration"/],
    ['no speech', (h: string) => h.replace(/ data-va-speech="[^"]*"/, ''), /needs data-va-speech/],
    ['speech off frames', (h: string) => h.replace('[[1.5,2.5]]', '[[1.51,2.5]]'), /whole frames/],
    ['speech out of order', (h: string) => h.replace('[[1.5,2.5]]', '[[4,5],[1.5,2.5]]'), /in order/],
    ['speech past the end', (h: string) => h.replace('[[1.5,2.5]]', '[[1.5,9.5]]'), /inside the video/],
    [
      'too many spans',
      (h: string) =>
        h.replace(
          '[[1.5,2.5]]',
          JSON.stringify(Array.from({ length: MAX_SPEECH_SPANS + 1 }, (_, i) => [i / 60, (i + 0.5) / 60])),
        ),
      /401 speech spans; 400 at most/,
    ],
    [
      'the bus in a beat',
      (h: string) => h.replace(bus(h), '').replace(/(data-va-beat="demo"[^>]*>)/, `$1${bus(h)}`),
      /in the root/,
    ],
  ])('refuses %s', (_n, mutate, msg) => {
    const out = applyNarration(html, summary, one, takes).html
    expect(validate(mutate(out).replace(/&quot;/g, '"'), summary).join(' ')).toMatch(msg)
  })

  it('relayout keeps the bus full length and cuts speech past a shorter end', () => {
    const long = op([
      clip({ id: 'a', start: S }),
      clip({ id: 'b', mediaId: 'take2', start: 7 * S, srcEnd: (19 * S) / 10 }),
    ])
    const out = applyNarration(html, summary, long, takes).html
    expect(speech(out)).toEqual([
      [1.5, 2.5],
      [7, 8.9],
    ])
    const shorter = applyEdits(out, summary, [{ op: 'retime', beat: 'outro', duration: 1.8 }])
    expect(validate(shorter.html, shorter.summary)).toEqual([])
    expect(bus(shorter.html)).toContain('data-duration="7.8"')
    expect(speech(shorter.html)).toEqual([
      [1.5, 2.5],
      [7, 7.8],
    ])
    const shortest = applyEdits(shorter.html, shorter.summary, [{ op: 'delete', beat: 'outro' }])
    expect(validate(shortest.html, shortest.summary)).toEqual([])
    expect(speech(shortest.html)).toEqual([[1.5, 2.5]])
  })
})

describe('AI voice and original audio under narration', () => {
  const mode = (m: 'replace' | 'under' | 'keep', muteAll = false) =>
    applyNarration(
      html,
      summary,
      op(one.clips, { aiVoice: { mode: m, volumeDb: -6 }, original: { muteAll } }),
      takes,
    ).html

  it('replace mutes every AI voice the way the audio op does, keeping its level', () => {
    const out = mode('replace')
    expect(validate(out, summary)).toEqual([])
    expect(out).toMatch(/<audio id="voice-intro"[^>]*data-volume="0"[^>]*data-va-muted=""/)
    expect(track(out, 'voice-intro')).toMatchObject({ muted: true, volume: 1 })
    expect(track(out, 'voice-outro')).toMatchObject({ muted: true, volume: 1 })
    expect(track(out, 'music')).toMatchObject({ muted: false, volume: 0.8 })
  })

  it('under lowers the AI voice by its dB; keep leaves it', () => {
    expect(track(mode('under'), 'voice-intro')).toMatchObject({ muted: false, volume: 0.5 })
    const kept = mode('keep')
    expect(read(load(kept)).audio.filter((a) => a.role !== 'narration')).toEqual(read(load(html)).audio)
  })

  it('muteAll mutes the music and the voices', () => {
    const out = mode('under', true)
    expect(validate(out, summary)).toEqual([])
    for (const id of ['music', 'voice-intro', 'voice-outro']) expect(track(out, id)?.muted).toBe(true)
    expect(track(out, 'music')?.volume).toBe(0.8)
  })

  it('switching mode or removing the narration restores the levels; the person’s own mutes stay', () => {
    const base = applyNarration(html, summary, null).html
    const own = applyEdits(html, summary, [{ op: 'audio', id: 'voice-outro', muted: true }]).html
    const replaced = applyNarration(
      own,
      summary,
      op(one.clips, { aiVoice: { mode: 'replace', volumeDb: 0 } }),
      takes,
    )
    const kept = applyNarration(replaced.html, summary, one, takes).html
    expect(track(kept, 'voice-intro')).toMatchObject({ muted: false, volume: 1 })
    expect(track(kept, 'voice-outro')).toMatchObject({ muted: true, volume: 1 })
    const all = applyNarration(html, summary, op(one.clips, { original: { muteAll: true } }), takes).html
    expect(applyNarration(all, summary, null).html).toBe(base)
    // Writing twice is writing once.
    expect(
      applyNarration(
        replaced.html,
        summary,
        op(one.clips, { aiVoice: { mode: 'replace', volumeDb: 0 } }),
        takes,
      ).html,
    ).toBe(replaced.html)
  })
})

describe('speech spans', () => {
  it('widens to whole frames, joins pauses under the release time and stays inside the video', () => {
    expect(speechSeconds([[1001, 1799]], 9)).toEqual([[0.033333, 0.1]])
    expect(
      speechSeconds(
        [
          [0, S],
          [2 * S, 3 * S],
          [5 * S, 6 * S],
          [8 * S, 10 * S],
        ],
        9,
      ),
    ).toEqual([
      [0, 3],
      [5, 6],
      [8, 9],
    ])
  })

  it('keeps at most MAX_SPEECH_SPANS, joining the closest first, all on frames', () => {
    // 1,000 half-second phrases 2 s apart, and every tenth pause a little longer.
    const spans: Span[] = Array.from({ length: 1000 }, (_, i) => [
      i * 2.5 * S + (i % 10 === 0 ? S / 10 : 0),
      i * 2.5 * S + S / 2,
    ])
    const out = speechSeconds(spans, 3000)
    expect(out).toHaveLength(MAX_SPEECH_SPANS)
    for (const [s, e] of out) {
      expect(Math.abs(s * 30 - Math.round(s * 30))).toBeLessThan(1e-3)
      expect(Math.abs(e * 30 - Math.round(e * 30))).toBeLessThan(1e-3)
    }
    expect(out.every(([s, e], i) => e > s && (i === 0 || s > (out[i - 1]?.[1] ?? 0)))).toBe(true)
  })
})
