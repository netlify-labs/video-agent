// Narration take cleanup (docs/spikes.md S13): the filtergraph builder and gain math, the speech gate and loudness on
// the synthetic fixtures, and, with a local ffmpeg (skipped without one), sample count, alignment and determinism.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AFFTDN_DELAY,
  LIGHT,
  cleanupFilter,
  gapRegions,
  gatedLoudness,
  preGain,
  readPcm16,
  rmsDb,
  speechRegions,
  trimGain,
} from '../src/lib/narration-cleanup.js'
import { wav } from '../src/lib/voice.js'
import { cleanTake, pcmSha256, runChain } from '../scripts/lib/narration-cleanup.js'
import { which } from '../scripts/lib/run-tools.js'

const fixture = (name: string) => new URL(`./fixtures/narration/${name}.wav`, import.meta.url).pathname
const samples = (name: string) => readPcm16(readFileSync(fixture(name))).samples

describe('cleanupFilter', () => {
  it('off is a true bypass: no graph at all', () => {
    expect(cleanupFilter('off', { noiseFloorDb: -60, preGainDb: 3, trimDb: 2 })).toBeNull()
  })

  it('light is a stable string with fixed decimals', () => {
    expect(cleanupFilter('light', { noiseFloorDb: -53.16, preGainDb: -0.8249, trimDb: 9.94 })).toBe(
      [
        'highpass=f=80',
        `apad=pad_len=${AFFTDN_DELAY}`,
        'afftdn=nr=12.0:nf=-43:tn=0',
        `atrim=start_sample=${AFFTDN_DELAY}`,
        'asetpts=N/SR/TB',
        'volume=-0.82dB:precision=double',
        'deesser=i=0.40:m=0.50:f=0.50:s=o',
        'acompressor=threshold=0.063096:ratio=2.00:attack=10.00:release=120.00:knee=4.00:makeup=1:detection=rms',
        'volume=9.94dB:precision=double',
      ].join(','),
    )
  })

  it("clamps the denoiser's noise floor into afftdn's range and never writes -0.00", () => {
    expect(cleanupFilter('light', { noiseFloorDb: -120, preGainDb: -0.001, trimDb: 0 })).toContain('nf=-80:')
    expect(cleanupFilter('light', { noiseFloorDb: -5, preGainDb: 0, trimDb: 0 })).toContain('nf=-20:')
    // No gaps to measure: afftdn gets -50 (the -60 fallback + the offset).
    const g = cleanupFilter('light', { noiseFloorDb: null, preGainDb: -0.001, trimDb: 0 })
    expect(g).toContain('nf=-50:')
    expect(g).not.toContain('-0.00')
  })
})

describe('per-take gain', () => {
  it('brings speech to the pre-compressor level, within limits; silence gets none', () => {
    expect(preGain(-38.4)).toBe(14.4)
    expect(preGain(-7.5)).toBe(LIGHT.preGainRange[0])
    expect(preGain(-70)).toBe(LIGHT.preGainRange[1])
    expect(preGain(null)).toBe(0)
  })

  it('trims toward the speech target unless the true peak would pass the ceiling', () => {
    expect(trimGain(-28, -12)).toEqual({ trimDb: 10, peakLimited: false })
    expect(trimGain(-28, -5)).toEqual({ trimDb: 4, peakLimited: true })
    expect(trimGain(null, -60)).toEqual({ trimDb: 0, peakLimited: false })
  })
})

describe('speech gate and loudness (fixtures)', () => {
  it('finds speech in every speech fixture and none in the silence-only take', () => {
    expect(speechRegions(samples('silence-only'))).toEqual([])
    for (const name of [
      'quiet-laptop',
      'noisy-room',
      'usb-hot',
      'near-clip',
      'sibilant-headset',
      'punch-quiet',
    ])
      expect(speechRegions(samples(name)).length, name).toBeGreaterThan(0)
  })

  it('matches ffmpeg ebur128 on whole takes and reads the room tone in the gaps', () => {
    // ffmpeg 9.0.2 ebur128: -40.6, -23.3 and -15.2 LUFS.
    expect(gatedLoudness(samples('quiet-laptop'))).toBeCloseTo(-40.6, 0)
    expect(gatedLoudness(samples('noisy-room'))).toBeCloseTo(-23.3, 0)
    expect(gatedLoudness(samples('usb-hot'))).toBeCloseTo(-15.2, 0)
    const s = samples('noisy-room')
    expect(rmsDb(s, gapRegions(speechRegions(s), s.length))).toBeCloseTo(-53.2, 0)
  })
})

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
describe.skipIf(!process.env.FFMPEG && !which('ffmpeg'))('cleanTake with ffmpeg', () => {
  const dirs: string[] = []
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'narration-cleanup-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('light keeps the sample count, reaches the speech target and is deterministic within a run', () => {
    const d = tmp()
    const a = cleanTake({ input: fixture('noisy-room'), output: join(d, 'a.wav'), preset: 'light', ffmpeg })
    const b = cleanTake({ input: fixture('noisy-room'), output: join(d, 'b.wav'), preset: 'light', ffmpeg })
    expect(a.outputSamples).toBe(a.inputSamples)
    expect(a.inputSamples).toBe(samples('noisy-room').length)
    expect(b.sha256).toBe(a.sha256)
    expect(b.filter).toBe(a.filter)
    const out = readPcm16(readFileSync(join(d, 'a.wav'))).samples
    expect(gatedLoudness(out, a.speech)).toBeCloseTo(LIGHT.speechTargetLufs, 0)
  })

  it('off copies the take bit for bit', () => {
    const d = tmp()
    const r = cleanTake({ input: fixture('quiet-laptop'), output: join(d, 'off.wav'), preset: 'off', ffmpeg })
    expect(r.filter).toBeNull()
    expect(r.sha256).toBe(pcmSha256(fixture('quiet-laptop')))
  })

  it('a silence-only take gets no gain and a warning', () => {
    const d = tmp()
    const r = cleanTake({ input: fixture('silence-only'), output: join(d, 's.wav'), preset: 'light', ffmpeg })
    expect(r.measured).toMatchObject({ preGainDb: 0, trimDb: 0 })
    expect(r.warnings.join()).toMatch(/^no_speech/)
    expect(r.outputSamples).toBe(r.inputSamples)
  })

  it('the light chain adds no delay (afftdn latency is compensated)', () => {
    const d = tmp()
    const pcm = new Int16Array(96_000)
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(30 * Math.sin((2 * Math.PI * 1000 * i) / 24_000))
    pcm[24_000] = 16_000
    pcm[72_000] = 16_000
    writeFileSync(join(d, 'click.wav'), wav(new Uint8Array(pcm.buffer)))
    runChain(
      join(d, 'click.wav'),
      join(d, 'out.wav'),
      cleanupFilter('light', { noiseFloorDb: -70, preGainDb: 0, trimDb: 0 }) ?? '',
      ffmpeg,
    )
    const out = readPcm16(readFileSync(join(d, 'out.wav'))).samples
    const peakAt = (a: number, b: number) => {
      let k = a
      for (let i = a; i < b; i++) if (Math.abs(out[i] ?? 0) > Math.abs(out[k] ?? 0)) k = i
      return k
    }
    expect(out.length).toBe(pcm.length)
    expect(peakAt(12_000, 48_000)).toBe(24_000)
    expect(peakAt(60_000, 90_000)).toBe(72_000)
  })
})
