// Align to AI voice's page side (narration-voice-align.ts): the voice clips placed in samples, stems fetched next to
// the preview page once per file, and a suggestion applied as one move (trimming a lead-in before 0).
import { describe, expect, it } from 'vitest'
import { IDENTITY_FIT, SAMPLE_RATE, type NarrationClip } from '../../../server/lib/timeline'
import { alignCommand, loadVoiceStems, takeOrigin, voicePlacements } from './narration-voice-align'

const clip = (o: Partial<NarrationClip> = {}): NarrationClip => ({
  id: 'nar_1',
  mediaId: 'm1',
  srcStart: 0,
  srcEnd: 4 * SAMPLE_RATE,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 6 * SAMPLE_RATE,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})

describe('Align to AI voice (page side)', () => {
  it('places the AI voice clips the timeline shows, in composition samples', () => {
    const beats = [
      {
        id: 'a',
        label: null,
        start: 0,
        duration: 3,
        voice: { id: 'v1', src: 'assets/voice/a.wav', start: 0.3, duration: 2.2 },
      },
      { id: 'b', label: null, start: 3, duration: 3, voice: null },
      {
        id: 'c',
        label: null,
        start: 6,
        duration: 3,
        voice: { id: 'v2', src: 'assets/voice/c.wav', start: 0.2, duration: 1.5 },
      },
    ]
    expect(voicePlacements({ beats })).toEqual([
      {
        src: 'assets/voice/a.wav',
        start: Math.round(0.3 * SAMPLE_RATE),
        length: Math.round(2.2 * SAMPLE_RATE),
      },
      {
        src: 'assets/voice/c.wav',
        start: Math.round(6.2 * SAMPLE_RATE),
        length: Math.round(1.5 * SAMPLE_RATE),
      },
    ])
  })

  it('fetches each stem once next to the preview page, cuts it to its length, and skips one that fails', async () => {
    const urls: string[] = []
    const get = (u: string) => {
      urls.push(u)
      return Promise.resolve(
        new Response(u.endsWith('bad.wav') ? null : new Uint8Array(8), {
          status: u.endsWith('bad.wav') ? 404 : 200,
        }),
      )
    }
    const decode = () => Promise.resolve(new Float32Array(1000).fill(0.5))
    const stems = await loadVoiceStems(
      'https://x.example/p/vid/1/e/ed/123.sig/index.html',
      [
        { src: 'assets/voice/a.wav', start: 10, length: 400 },
        { src: 'assets/voice/a.wav', start: 2000, length: 5000 },
        { src: 'assets/voice/bad.wav', start: 0, length: 100 },
      ],
      decode,
      get,
    )
    expect(urls).toEqual([
      'https://x.example/p/vid/1/e/ed/123.sig/assets/voice/a.wav',
      'https://x.example/p/vid/1/e/ed/123.sig/assets/voice/bad.wav',
    ])
    expect(stems.map((s) => [s.start, s.samples.length])).toEqual([
      [10, 400],
      [2000, 1000],
    ])
  })

  it('applies a suggestion as one move, trimming the lead-in when the voice starts before 0', () => {
    const c = clip({ srcStart: 1200, start: 6 * SAMPLE_RATE + 1200 })
    expect(takeOrigin(c)).toBe(6 * SAMPLE_RATE)
    expect(alignCommand(c, { start: SAMPLE_RATE, score: 0.8, refined: 'envelope' })).toEqual({
      type: 'move',
      clipId: 'nar_1',
      start: SAMPLE_RATE + 1200,
    })
    expect(alignCommand(clip(), { start: -SAMPLE_RATE / 2, score: 0.8, refined: 'frame' })).toEqual({
      type: 'move',
      clipId: 'nar_1',
      start: 0,
      srcStart: SAMPLE_RATE / 2,
    })
  })
})
