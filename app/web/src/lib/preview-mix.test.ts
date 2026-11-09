// The audition's preview mix (plan §5.4): per-role levels for the bridge's mix command, and the music's duck lane
// from the shared duckPoints with the op's narration written in.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { duckPoints, load, writeNarration } from '../../../server/lib/contract'
import { IDENTITY_FIT, SAMPLE_RATE, dbToGain, type NarrationOp } from '../../../server/lib/timeline'
import { musicLane, previewMix } from './preview-mix'

const html = readFileSync(
  new URL('../../../test/fixtures/contract1-voice/index.html', import.meta.url),
  'utf8',
)
const S = SAMPLE_RATE

/** One clip of take "t" sounding 4-5 s (the fixture's AI voices are at 0.3-2.5 s and 6.2-7.7 s). */
const op = (tracks: Partial<NarrationOp['tracks']> = {}): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips: [
    {
      id: 'c',
      mediaId: 't',
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
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
    ...tracks,
  },
  cleanup: 'off',
})

/** The times of the lane points below full level. */
const dips = (lane: { t: number; v: number }[] | null | undefined) =>
  (lane ?? []).filter((p) => p.v < 1).map((p) => p.t)

describe('preview mix', () => {
  it('replace: the AI voice and any rendered bus are muted, the music dips under the narration only', () => {
    const mix = previewMix(html, op())
    expect(mix.voice).toEqual({ muted: true })
    expect(mix.narration).toEqual({ muted: true })
    expect(mix.sfx).toEqual({})
    const lane = mix.music?.lane
    expect(dips(lane)).toEqual([4, 5])
    expect(lane?.find((p) => p.t === 4)?.v).toBeCloseTo(dbToGain(-12), 9)
  })

  it('is the shared duckPoints on the composition with the narration written in', () => {
    const o = op({ aiVoice: { mode: 'under', volumeDb: -6 } })
    const d = load(html)
    writeNarration(d, o, [[4 * S, 5 * S]])
    expect(musicLane(html, o)).toEqual(duckPoints(d, dbToGain(-12)))
    const mix = previewMix(html, o)
    expect(mix.voice).toEqual({ gain: dbToGain(-6) })
    // Under keeps the AI voice audible, so the music dips under it too; the narration (4-5 s) and the outro voice
    // (6.2 s) are closer than the 1.5 s release, so they share one dip.
    expect(dips(mix.music?.lane)).toEqual([0.3, 2.5, 4, 7.7])
  })

  it('uses the take speech summary for the dip', () => {
    const spans = new Map([['t', [[0.25 * S, 0.5 * S] as [number, number]]]])
    // data-va-speech is widened to whole frames: 4.25 s starts in the frame at 4.2333 s.
    expect(dips(previewMix(html, op(), spans).music?.lane)).toEqual([4.233, 4.5])
  })

  it('without duck, the music keeps its own level and dips only under audible AI voices', () => {
    const keep = previewMix(
      html,
      op({ aiVoice: { mode: 'keep', volumeDb: 0 }, music: { duck: false, duckDb: -12 } }),
    )
    expect(keep.voice).toEqual({})
    expect(dips(keep.music?.lane)).toEqual([0.3, 2.5, 6.2, 7.7])
    expect(keep.music?.lane?.find((p) => p.t === 0.3)?.v).toBe(0.3)
    const replace = previewMix(html, op({ music: { duck: false, duckDb: -12 } }))
    expect(dips(replace.music?.lane)).toEqual([])
  })

  it('mute all, or narration solo, silences every composition track', () => {
    for (const o of [
      op({ original: { muteAll: true } }),
      op({ narration: { volumeDb: 0, muted: false, solo: true } }),
    ])
      expect(previewMix(html, o)).toEqual({
        narration: { muted: true },
        voice: { muted: true },
        sfx: { muted: true },
        music: { muted: true },
      })
  })

  it('leaves the music alone when the composition does not parse', () => {
    expect(previewMix('<p>no root</p>', op()).music).toEqual({})
  })
})
