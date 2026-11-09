// The music's duck lane under recorded narration (plan 2026-11-02 §6.3 step 4): unmuted voices plus the bus's speech
// spans, the release rule across short pauses, the point cap, and unchanged lanes without narration.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  applyNarration,
  duckPoints,
  load,
  MAX_DUCK_POINTS,
  validate,
  type Summary,
} from '../server/lib/contract.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp, type Span } from '../server/lib/timeline.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const html = fx('index.html')
const summary = JSON.parse(fx('summary.json')) as Summary
const lane = (h: string) =>
  (
    JSON.parse(
      /<audio id="music"[^>]*data-automation="([^"]*)"/.exec(h)?.[1]?.replace(/&quot;/g, '"') ?? '{}',
    ) as { lanes: { points: { t: number; v: number }[] }[] }
  ).lanes[0]?.points

/** One clip of take `t1` covering `length` s from 0, with `spans` (seconds) as the take's speech. */
function narrate(
  h: string,
  spans: [number, number][],
  {
    length = 9,
    mode = 'replace' as const,
    sum = summary,
  }: { length?: number; mode?: 'replace' | 'keep'; sum?: Summary } = {},
) {
  const op: NarrationOp = {
    op: 'narration',
    schema: 1,
    sampleRate: S,
    clips: [
      {
        id: 'a',
        mediaId: 't1',
        srcStart: 0,
        srcEnd: length * S,
        fit: IDENTITY_FIT,
        offsetSamples: 0,
        start: 0,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ],
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode, volumeDb: 0 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup: 'off',
  }
  const takes = new Map<string, Span[]>([['t1', spans.map(([s, e]): Span => [s * S, e * S])]])
  return applyNarration(h, sum, op, takes).html
}

describe('duck lane', () => {
  it('without narration, lanes are what they were (the fixture keeps its stored lane)', () => {
    expect(validate(html, summary)).toEqual([])
    expect(duckPoints(load(html), 0.3)).toEqual(lane(html))
    expect(duckPoints(load(html), 0.3)).toMatchInlineSnapshot(`
      [
        {
          "t": 0,
          "v": 1,
        },
        {
          "t": 0.05,
          "v": 1,
        },
        {
          "t": 0.3,
          "v": 0.3,
        },
        {
          "t": 2.5,
          "v": 0.3,
        },
        {
          "t": 2.9,
          "v": 1,
        },
        {
          "t": 5.95,
          "v": 1,
        },
        {
          "t": 6.2,
          "v": 0.3,
        },
        {
          "t": 7.7,
          "v": 0.3,
        },
        {
          "t": 8.1,
          "v": 1,
        },
      ]
    `)
  })

  it('leaves out muted voices; a lane written while they still counted stays valid until the next save', () => {
    const muted = html.replace(
      /(<audio id="voice-outro"[^>]*?)data-volume="1"/,
      '$1data-volume="0" data-va-volume="1" data-va-muted=""',
    )
    expect(duckPoints(load(muted), 0.3)).toEqual(lane(html)?.slice(0, 5))
    expect(validate(muted, summary)).toEqual([])
    const saved = applyEdits(muted, summary, [{ op: 'text', id: 'intro-title', text: 'Hi' }]).html
    expect(lane(saved)).toEqual(lane(html)?.slice(0, 5))
  })

  it('dips under narration speech and joins speech across pauses shorter than the release', () => {
    // AI voice replaced: only narration ducks. 1 s pause: one dip.
    const joined = narrate(html, [
      [1, 2],
      [3, 4],
    ])
    expect(validate(joined, summary)).toEqual([])
    expect(lane(joined)).toEqual([
      { t: 0, v: 1 },
      { t: 0.75, v: 1 },
      { t: 1, v: 0.3 },
      { t: 4, v: 0.3 },
      { t: 4.4, v: 1 },
    ])
  })

  it('releases the music in a 2 s pause of continuous narration', () => {
    const out = narrate(html, [
      [0.5, 3],
      [5, 8],
    ])
    expect(validate(out, summary)).toEqual([])
    const points = lane(out) ?? []
    expect(points.some((p) => p.t > 3 && p.t < 5 && p.v === 1)).toBe(true)
    expect(points.filter((p) => p.v === 0.3).map((p) => p.t)).toEqual([0.5, 3, 5, 8])
  })

  it('keeps narration and unmuted voices together, and the lane within MAX_DUCK_POINTS on a long video', () => {
    // 6 minutes, a 1 s phrase every 3 s: 120 dips would be 481 points.
    const long = applyEdits(html, summary, [
      { op: 'retime', beat: 'intro', duration: 120 },
      { op: 'retime', beat: 'demo', duration: 120 },
      { op: 'retime', beat: 'outro', duration: 120 },
    ])
    const spans = Array.from({ length: 120 }, (_, i): [number, number] => [i * 3 + 1, i * 3 + 2])
    const out = narrate(long.html, spans, { length: 360, mode: 'keep', sum: long.summary })
    expect(validate(out, long.summary)).toEqual([])
    const points = lane(out) ?? []
    expect(points.length).toBeLessThanOrEqual(MAX_DUCK_POINTS)
    expect(points.length).toBeGreaterThan(300)
    expect(points.every((p, i) => i === 0 || p.t > (points[i - 1]?.t ?? 0))).toBe(true)
    // The AI voices (kept) still duck the music where they speak: intro's at 0.3 s.
    expect(points.slice(0, 3)).toEqual([
      { t: 0, v: 1 },
      { t: 0.05, v: 1 },
      { t: 0.3, v: 0.3 },
    ])
  })
})
