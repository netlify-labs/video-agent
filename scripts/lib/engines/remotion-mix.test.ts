// `engine.ts mix` on Remotion: the music level from the track's measured loudness (ffmpeg, as in CI), no render.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_VOLUME } from '../../../src/lib/contract.js'
import { measure } from '../mastering.js'
import { mixMusic, musicVolume } from './remotion-mix.js'

const tone = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'audio', 'tone.wav')

/** A project whose music is the fixture tone at this gain (dB), and a beat of `seconds`. */
function project(gainDb: number | null, seconds = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'va-mix-'))
  mkdirSync(join(dir, 'assets', 'music'), { recursive: true })
  const props = {
    contract: 1,
    beats: [{ id: 'intro', duration: seconds }],
    layers: [],
    audio: {
      music:
        gainDb === null
          ? null
          : {
              id: 'music',
              label: null,
              src: 'assets/music/bed.wav',
              volume: 0.8,
              muted: false,
              fadeIn: 0,
              fadeOut: 0,
            },
    },
  }
  if (gainDb !== null)
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      tone,
      '-af',
      `volume=${gainDb}dB`,
      join(dir, 'assets/music/bed.wav'),
    ])
  writeFileSync(join(dir, 'props.json'), JSON.stringify(props, null, 2))
  return { dir, props }
}
const propsOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'props.json'), 'utf8')) as ReturnType<typeof project>['props']

describe('Remotion music level', () => {
  it('brings a quiet track up toward -14 LUFS, and changes nothing else in props.json', () => {
    const { dir, props } = project(-20)
    const before = measure(join(dir, 'assets/music/bed.wav'))
    const r = mixMusic(dir)
    expect(r?.lufsSrc).toBe(before.integratedLufs)
    expect(r?.volume).toBeGreaterThan(1)
    expect(r?.truePeakAtGain).toBeLessThanOrEqual(-1)
    const after = propsOf(dir)
    expect(after.audio.music?.volume).toBe(r?.volume)
    expect({ ...after, audio: { music: { ...after.audio.music, volume: 0.8 } } }).toEqual(props)
  })

  it('brings a loud track down, under the true-peak ceiling', () => {
    const { dir } = project(12)
    const r = mixMusic(dir)
    expect(r?.volume).toBeLessThan(1)
    expect(r?.truePeakAtGain).toBeLessThanOrEqual(-1)
  })

  it('lowers the level when the peak would pass -1 dBTP before the loudness target', () => {
    // A peaky track: -24 LUFS integrated but a -2 dBTP peak wants +10 dB and has room for +1 dB.
    expect(musicVolume(-24, -2)).toEqual({ volume: 1.122, truePeakAtGain: -1, clamped: false })
  })

  it('never goes past the contract’s volume range', () => {
    expect(musicVolume(-40, -40)).toEqual({ volume: MAX_VOLUME, truePeakAtGain: -27.96, clamped: true })
  })

  it('a silent track keeps unity gain', () => {
    expect(musicVolume(null, -90).volume).toBe(1)
  })

  it('does nothing without music', () => {
    const { dir, props } = project(null)
    const logs: unknown[] = []
    expect(mixMusic(dir, { log: (step, f) => logs.push({ step, ...f }) })).toBeNull()
    expect(propsOf(dir)).toEqual(props)
    expect(logs).toEqual([{ step: 'engine.mix', skipped: 'no music' }])
  })
})
