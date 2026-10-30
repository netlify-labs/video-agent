import { describe, expect, it } from 'vitest'
import { toVtt } from './captions.js'

describe('toVtt', () => {
  it('formats, sorts, clamps and drops invalid cues', () => {
    const vtt = toVtt(
      [
        { start: 3.5, end: 5, text: 'Second' },
        { start: 0, end: 1.25, text: 'First' },
        { start: 9, end: 20, text: 'Clamped' },
        { start: 2, end: 1, text: 'Backwards' },
        { text: 'No times' },
        { start: 1, end: 2, text: 'Has --> arrow' },
      ],
      12,
    )
    expect(vtt).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.250\nFirst\n\n2\n00:00:01.000 --> 00:00:02.000\nHas → arrow\n\n3\n00:00:03.500 --> 00:00:05.000\nSecond\n\n4\n00:00:09.000 --> 00:00:12.000\nClamped\n',
    )
  })
  it('produces a valid empty file when there are no cues', () => {
    expect(toVtt(undefined, 10)).toBe('WEBVTT\n')
  })
})
