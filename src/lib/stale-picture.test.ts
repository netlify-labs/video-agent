// Stale picture (plan 2026-11-02 §5.3): which pending ops block recording. Retime, reorder and delete move time; a
// voice op does when its re-spoken line may no longer fit its beat; audio, text, colour, media and narration don't.
import { describe, expect, it } from 'vitest'
import { minBeatSeconds, VOICE_TAIL as RUN_TAIL } from './voice.js'
import {
  REVOICE_HEADROOM,
  timingChanged,
  VOICE_TAIL,
  voiceMovesTime,
  type PictureBase,
} from './stale-picture.js'

// Two voiced beats and one silent one. "intro" has 1.2 s of slack after its voice (3 s beat, 0.3 s lead, 1.1 s
// voice, 0.4 s tail); "demo" fits its voice exactly.
const base: PictureBase = {
  beats: [
    { id: 'intro', duration: 3, voice: { start: 0.3, duration: 1.1 } },
    { id: 'demo', duration: 4, voice: { start: 0.3, duration: 3.3 } },
    { id: 'outro', duration: 2, voice: null },
  ],
  narration: [
    { beat: 'intro', text: 'Meet the new deploys.' },
    { beat: 'demo', text: 'Roll back any deploy in one click, from the list.' },
  ],
}

describe('timingChanged', () => {
  const cases: [string, { op: string; [k: string]: unknown }[], boolean][] = [
    ['no ops', [], false],
    ['a retime', [{ op: 'retime', beat: 'intro', duration: 4 }], true],
    ['a retime to the same frame', [{ op: 'retime', beat: 'intro', duration: 3.01 }], false],
    ['a reorder', [{ op: 'reorder', order: ['demo', 'intro', 'outro'] }], true],
    ['a reorder in the same order', [{ op: 'reorder', order: ['intro', 'demo', 'outro'] }], false],
    ['a delete', [{ op: 'delete', beat: 'outro' }], true],
    ['music volume', [{ op: 'audio', id: 'music', volume: 0.4 }], false],
    ['music muted', [{ op: 'audio', id: 'music', muted: true }], false],
    ['music replaced', [{ op: 'audio', id: 'music', src: 'assets/media/med_x.mp3' }], false],
    ['text', [{ op: 'text', id: 'title', text: 'Hello' }], false],
    ['colour', [{ op: 'color', role: 'accent', value: '#fff' }], false],
    ['media', [{ op: 'media', slot: 'shot', src: 'assets/media/a.png', kind: 'image', fit: 'cover' }], false],
    ['the narration op', [{ op: 'narration', clips: [] }], false],
    [
      'a voice line back to the spoken one',
      [{ op: 'voice', beat: 'demo', text: ' Roll back any deploy in one click,  from the list. ' }],
      false,
    ],
    ['a shorter voice line', [{ op: 'voice', beat: 'demo', text: 'Roll back in one click.' }], false],
    [
      'a longer line that still fits its slack',
      [{ op: 'voice', beat: 'intro', text: 'Meet the brand new deploys.' }],
      false,
    ],
    [
      'a longer line in a beat with no slack',
      [
        {
          op: 'voice',
          beat: 'demo',
          text: 'Roll back any deploy in one click, straight from the deploy list.',
        },
      ],
      true,
    ],
    [
      'a much longer line',
      [
        {
          op: 'voice',
          beat: 'intro',
          text: 'Meet the new deploys: faster builds, instant rollbacks and previews for every branch.',
        },
      ],
      true,
    ],
    ['a voice op on a beat without a known line', [{ op: 'voice', beat: 'outro', text: 'Bye.' }], true],
    [
      'audio plus a retime',
      [
        { op: 'audio', id: 'music', volume: 0.4 },
        { op: 'retime', beat: 'demo', duration: 5 },
      ],
      true,
    ],
  ]
  it.each(cases)('%s', (_name, ops, want) => {
    expect(timingChanged(ops, base)).toBe(want)
  })

  it('estimates from the old pace with headroom, against the run’s minimum beat', () => {
    // intro's slack: the beat can hold a voice up to 3 - 0.3 - 0.4 = 2.3 s. Its line has 17 sayable characters in
    // 1.1 s; with 25% headroom, a line of n characters is estimated at 1.1 * n * 1.25 / 17 s.
    const fits = (n: number) => minBeatSeconds(0.3, (1.1 * n * REVOICE_HEADROOM) / 17) <= 3
    const line = (n: number) => 'a'.repeat(n)
    for (const n of [18, 24, 28, 29, 30, 40]) expect(voiceMovesTime(base, 'intro', line(n))).toBe(!fits(n))
  })

  it('keeps the run’s voice tail', () => {
    expect(VOICE_TAIL).toBe(RUN_TAIL)
  })
})
