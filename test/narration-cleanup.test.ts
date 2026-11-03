// Narration take cleanup (docs/spikes.md S13): the filtergraph builder and gain math, the speech gate and loudness on
// the synthetic fixtures, and, with a local ffmpeg (skipped without one), sample count, alignment and determinism.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AFFTDN_DELAY,
  ARNNDN_DELAY,
  ARNNDN_PAD,
  LIGHT,
  RNNOISE_MODEL,
  bestLag,
  cleanupFilter,
  rnnoiseStage,
  gapRegions,
  gatedLoudness,
  preGain,
  readPcm16,
  rmsDb,
  speechRegions,
  trimGain,
} from '../src/lib/narration-cleanup.js'
import { wav } from '../src/lib/voice.js'
import { cleanTake, pcmSha256, rnnoiseModelPath, runChain } from '../scripts/lib/narration-cleanup.js'
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

describe('heavy cleanupFilter', () => {
  const m = { noiseFloorDb: -53.16, preGainDb: -0.8249, trimDb: 9.94 }

  it("declicks, runs light's afftdn, then RNNoise at 48 kHz, padded and cut back to the take", () => {
    expect(
      cleanupFilter('heavy', m, LIGHT, { model: '/repo/scripts/lib/rnnoise/sh.rnnn', samples: 1000 }),
    ).toBe(
      [
        'highpass=f=80',
        'adeclick',
        `apad=pad_len=${AFFTDN_DELAY}`,
        'afftdn=nr=12.0:nf=-43:tn=0',
        `atrim=start_sample=${AFFTDN_DELAY}`,
        'asetpts=N/SR/TB',
        `apad=pad_len=${ARNNDN_PAD}`,
        'aresample=48000',
        'arnndn=m=/repo/scripts/lib/rnnoise/sh.rnnn',
        'aresample=24000',
        `atrim=start_sample=${ARNNDN_DELAY}:end_sample=${ARNNDN_DELAY + 1000}`,
        'asetpts=N/SR/TB',
        'volume=-0.82dB:precision=double',
        'deesser=i=0.40:m=0.50:f=0.50:s=o',
        'acompressor=threshold=0.063096:ratio=2.00:attack=10.00:release=120.00:knee=4.00:makeup=1:detection=rms',
        'volume=9.94dB:precision=double',
      ].join(','),
    )
  })

  it('needs a model path that is safe in a filtergraph and a take length', () => {
    expect(() => cleanupFilter('heavy', m)).toThrow(/RNNoise model/)
    for (const model of ['/a b/sh.rnnn', '/a:b.rnnn', "/a'b.rnnn", '/a,b.rnnn', ''])
      expect(() => cleanupFilter('heavy', m, LIGHT, { model, samples: 10 }), model).toThrow(/filtergraph/)
    expect(() => rnnoiseStage('/m.rnnn', 0)).toThrow(/take length/)
    expect(() => rnnoiseStage('/m.rnnn', 1.5)).toThrow(/take length/)
  })

  it('the vendored model matches its pinned sha256', () => {
    expect(rnnoiseModelPath()).toMatch(new RegExp(`scripts/lib/rnnoise/${RNNOISE_MODEL.file}$`))
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

  it(
    'heavy keeps the sample count, reaches the target, is deterministic and gains SNR over light',
    { timeout: 60_000 },
    () => {
      const d = tmp()
      const runs = ['a', 'b', 'c'].map((k) =>
        cleanTake({ input: fixture('noisy-room'), output: join(d, `${k}.wav`), preset: 'heavy', ffmpeg }),
      )
      const [a] = runs
      if (!a) throw new Error('no run')
      expect(a.outputSamples).toBe(samples('noisy-room').length)
      // arnndn's last frame holds uninitialised memory: without the three-frame pad these differed about 1 run in 8.
      expect(new Set(runs.map((r) => r.sha256)).size).toBe(1)
      expect(a.filter).toContain(`arnndn=m=${rnnoiseModelPath()}`)
      const out = readPcm16(readFileSync(join(d, 'a.wav'))).samples
      expect(gatedLoudness(out, a.speech)).toBeCloseTo(LIGHT.speechTargetLufs, 0)
      const l = cleanTake({ input: fixture('noisy-room'), output: join(d, 'l.wav'), preset: 'light', ffmpeg })
      const lout = readPcm16(readFileSync(join(d, 'l.wav'))).samples
      const gaps = gapRegions(a.speech, out.length)
      // Same speech level, so a lower gap floor is the SNR gain (S13: +12.3 dB heavy vs +7.4 light).
      expect((rmsDb(out, gaps) ?? 0) - (rmsDb(lout, gaps) ?? 0)).toBeLessThan(-3)
      expect(l.outputSamples).toBe(a.outputSamples)
    },
  )

  it("heavy keeps every take length, on or off arnndn's 10 ms frame grid", { timeout: 60_000 }, () => {
    const d = tmp()
    for (const name of ['punch-quiet', 'silence-only', 'near-clip']) {
      const r = cleanTake({ input: fixture(name), output: join(d, `${name}.wav`), preset: 'heavy', ffmpeg })
      expect(r.outputSamples, name).toBe(samples(name).length)
    }
  })

  it('the RNNoise stage adds no delay: an impulse lands on its own sample', () => {
    const d = tmp()
    const pcm = new Int16Array(96_000)
    let seed = 7
    for (let i = 0; i < pcm.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      pcm[i] = Math.round(300 * (seed / 0x7fffffff - 0.5))
    }
    pcm[24_000] = 20_000
    pcm[72_000] = 20_000
    writeFileSync(join(d, 'imp.wav'), wav(new Uint8Array(pcm.buffer)))
    runChain(
      join(d, 'imp.wav'),
      join(d, 'out.wav'),
      rnnoiseStage(rnnoiseModelPath(), pcm.length).join(','),
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

  it(
    'the whole heavy chain adds no delay (a chirp burst lines up; adeclick would take a bare impulse)',
    { timeout: 60_000 },
    () => {
      const d = tmp()
      const pcm = new Int16Array(96_000)
      for (const at of [24_000, 60_000])
        for (let k = 0; k < 4800; k++) {
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 4800)
          pcm[at + k] = Math.round(
            8000 * w * Math.sin((2 * Math.PI * (200 * k + (1300 * k * k) / 4800)) / 24_000),
          )
        }
      writeFileSync(join(d, 'chirp.wav'), wav(new Uint8Array(pcm.buffer)))
      const filter = cleanupFilter(
        'heavy',
        { noiseFloorDb: -70, preGainDb: 0, trimDb: 0 },
        { ...LIGHT, highpassHz: 20 },
        { model: rnnoiseModelPath(), samples: pcm.length },
      )
      runChain(join(d, 'chirp.wav'), join(d, 'out.wav'), filter ?? '', ffmpeg)
      const out = readPcm16(readFileSync(join(d, 'out.wav'))).samples
      expect(out.length).toBe(pcm.length)
      expect(bestLag(pcm, out, { start: 24_000, end: 28_800 }, 2000)).toBe(0)
      expect(bestLag(pcm, out, { start: 60_000, end: 64_800 }, 2000)).toBe(0)
    },
  )
})
