// Naming a take's download (take-download.ts): the video's title, the version and the take's number on the track.
import { describe, expect, it } from 'vitest'
import { takeBaseName, takeExt, takeFileName, takeNumber } from './take-download'

describe('take downloads', () => {
  it('names the file after the video, the version and the take', () => {
    expect(takeFileName('Lumen', 1, 3, 'wav')).toBe('lumen-v1-take-3.wav')
    expect(takeFileName('Ship faster with preview deploys!', 2, 1, '.WAV')).toBe(
      'ship-faster-with-preview-deploys-v2-take-1.wav',
    )
    expect(takeBaseName('Café: año nuevo', 4, 2)).toBe('cafe-ano-nuevo-v4-take-2')
    expect(takeBaseName('???', 1, 1)).toBe('video-v1-take-1')
  })

  it('keeps the stored file’s format', () => {
    expect(takeExt('take-rec_1.wav', 'audio/wav')).toBe('wav')
    expect(takeExt('My voice.MP3', 'audio/mpeg')).toBe('mp3')
    expect(takeExt(null, 'audio/mpeg')).toBe('mp3')
    expect(takeExt(undefined, 'audio/mp4')).toBe('m4a')
    expect(takeExt(undefined, undefined)).toBe('wav')
  })

  it('numbers takes by their order on the track; a new one comes next', () => {
    const ids = ['med_a', 'med_a', 'med_b', 'med_c']
    expect(takeNumber(ids, 'med_a')).toBe(1)
    expect(takeNumber(ids, 'med_c')).toBe(3)
    expect(takeNumber(ids, 'review_rec_9')).toBe(4)
  })
})
