// The Narration section as data (narration-panel.ts): the op in the draft's op list, new clips, the lanes, and the
// render dialog's overflow math (which must agree with the server's hold-frame target, src/domain/edits.ts).
import { describe, expect, it } from 'vitest'
import {
  frameStart,
  IDENTITY_FIT,
  MAX_EXTENSION_SAMPLES,
  POST_ROLL_SAMPLES,
  SAMPLE_RATE,
  type NarrationClip,
  type NarrationOp,
} from '../../../src/lib/timeline'
import {
  DEFAULT_TRACKS,
  emptyNarration,
  freshClipId,
  isEmptyNarration,
  narrationOf,
  narrationToSave,
  renderPreview,
  sameOps,
  stableJson,
  takeClip,
  timelineComposition,
  voicesFromHtml,
  withNarration,
} from './narration-panel'

const S = SAMPLE_RATE
const FPS = 30
const clip = (id: string, start: number, len: number, o: Partial<NarrationClip> = {}): NarrationClip => ({
  id,
  mediaId: 'm1',
  srcStart: 0,
  srcEnd: len,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})
const withClips = (clips: NarrationClip[]): NarrationOp => ({ ...emptyNarration(), clips })

describe('the narration op in the draft', () => {
  it('a new track is empty and not saved; any clip or setting makes it an op', () => {
    const op = emptyNarration()
    expect(isEmptyNarration(op)).toBe(true)
    expect(narrationToSave(op)).toBeNull()
    expect(narrationToSave(null)).toBeNull()
    const muted = { ...op, tracks: { ...op.tracks, original: { muteAll: true } } }
    expect(narrationToSave(muted)).toBe(muted)
    expect(narrationToSave({ ...op, cleanup: 'off' })).not.toBeNull()
    expect(narrationToSave(withClips([clip('a', 0, S)]))).not.toBeNull()
    // The defaults: your voice replaces the AI voice, the music ducks 12 dB, Light cleanup.
    expect(op.tracks).toEqual(DEFAULT_TRACKS)
    expect(op.cleanup).toBe('light')
  })

  it('is one op, last in the list, replacing any earlier one; null takes it out', () => {
    const retime = { op: 'retime', beat: 'intro', duration: 4 }
    const old = withClips([clip('a', 0, S)])
    const next = withClips([clip('a', S, S)])
    expect(withNarration([old, retime], next)).toEqual([retime, next])
    expect(withNarration([retime, old], null)).toEqual([retime])
    expect(narrationOf(withNarration([retime], next))).toBe(next)
    expect(narrationOf([retime])).toBeNull()
  })

  it('compares op lists by content, not key order (Postgres jsonb reorders keys)', () => {
    const op = withClips([clip('a', 0, S)])
    const reordered = JSON.parse(stableJson([op])) as unknown[]
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify([op]))
    expect(sameOps(reordered, [op])).toBe(true)
    expect(sameOps([op], [withClips([clip('a', 1, S)])])).toBe(false)
  })

  it('round-trips a saved op into the panel and back unchanged', () => {
    const saved = {
      ...withClips([clip('nar_1', 2 * S, 3 * S, { gainDb: -3, fadeInSamples: 100 })]),
      tracks: { ...DEFAULT_TRACKS, aiVoice: { mode: 'under' as const, volumeDb: -18 } },
      cleanup: 'off' as const,
    }
    const fromServer = JSON.parse(stableJson(saved)) as NarrationOp
    // The panel edits {clips, tracks, cleanup} and sends the op back whole.
    const back = {
      ...fromServer,
      clips: fromServer.clips,
      tracks: fromServer.tracks,
      cleanup: fromServer.cleanup,
    }
    expect(sameOps([narrationToSave(back)], [saved])).toBe(true)
  })

  it('names new clips nar_1, nar_2, … past any id (or split piece) already used', () => {
    expect(freshClipId(emptyNarration())).toBe('nar_1')
    expect(freshClipId(withClips([clip('nar_1', 0, S), clip('nar_2~2', S, S)]))).toBe('nar_3')
  })

  it('places a whole take at the start given, with no sync fit and unity gain', () => {
    expect(takeClip('nar_1', 'med_x', 2.5 * S, 1.2 * S)).toEqual(
      clip('nar_1', 1.2 * S, 2.5 * S, { mediaId: 'med_x' }),
    )
    expect(takeClip('nar_1', 'med_x', S, -40).start).toBe(0)
  })
})

describe('lanes', () => {
  it('lays the beats back to back as they are now, with the AI voice clips the draft has', () => {
    const voice = { id: 'v1', src: 'assets/voice/demo.wav', start: 0.2, duration: 2 }
    const lanes = timelineComposition(
      {
        beats: [
          { id: 'intro', label: 'Opening', duration: 4.5 },
          { id: 'demo', label: null, duration: 3 },
        ],
        audio: [],
      },
      new Map([['demo', voice]]),
    )
    expect(lanes.duration).toBe(7.5)
    expect(lanes.beats.map((b) => [b.id, b.start, b.duration, b.voice])).toEqual([
      ['intro', 0, 4.5, null],
      ['demo', 4.5, 3, voice],
    ])
  })
  it('reads no voices from a page that is not a composition', () => {
    expect(voicesFromHtml(null).size).toBe(0)
    expect(voicesFromHtml('<p>stand-in</p>').size).toBe(0)
  })
})

describe('render dialog: duration and overflow', () => {
  const video = 9 * S

  it('narration inside the video: no overflow, the hold end is the video', () => {
    const p = renderPreview(withClips([clip('a', S, 2 * S), clip('b', 4 * S, 3 * S)]), video, FPS)
    expect(p).toMatchObject({ start: S, end: 7 * S, video, overflow: 0, holdEnd: video, holdAllowed: true })
    expect(p.overflowClipId).toBeNull()
  })

  it('an overrun: by how much, and the held-frame end is the last word plus 0.5 s in whole frames', () => {
    // b ends at 10.01 s: 1.01 s over; plus 0.5 s is 10.51 s, which is 315.3 frames, so 316 frames (10.5333 s).
    const end = 10 * S + 240
    const p = renderPreview(withClips([clip('a', 0, 2 * S), clip('b', 8 * S, end - 8 * S)]), video, FPS)
    expect(p.overflow).toBe(end - video)
    expect(p.end).toBe(end)
    expect(p.holdEnd).toBe(frameStart(316, FPS))
    expect(p.holdEnd).toBeGreaterThanOrEqual(end + POST_ROLL_SAMPLES)
    expect(p.holdAllowed).toBe(true)
    expect(p.overflowClipId).toBe('b')
  })

  it('silent clips are not heard: they neither start nor run over', () => {
    const p = renderPreview(
      withClips([
        clip('quiet', 0, S, { gainDb: null }),
        clip('a', 2 * S, S),
        clip('tail', 8 * S, 4 * S, { gainDb: null }),
      ]),
      video,
      FPS,
    )
    expect(p).toMatchObject({ start: 2 * S, end: 3 * S, overflow: 0, overflowClipId: null })
  })

  it('a hold past the limit (the video + 120 s) is not allowed', () => {
    const p = renderPreview(withClips([clip('a', video, MAX_EXTENSION_SAMPLES)]), video, FPS)
    expect(p.limit).toBe(video + MAX_EXTENSION_SAMPLES)
    expect(p.holdEnd).toBeGreaterThan(p.limit)
    expect(p.holdAllowed).toBe(false)
  })

  it('no narration: everything at 0', () => {
    expect(renderPreview(emptyNarration(), video, FPS)).toMatchObject({ start: 0, end: 0, overflow: 0 })
  })
})
