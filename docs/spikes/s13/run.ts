// S13: raw vs light vs heavy vs off on the synthetic narration fixtures (docs/spikes.md S13). Prints JSON.
//   npx tsx docs/spikes/s13/run.ts                       # the table, with the local ffmpeg (or FFMPEG=...)
//   RNNOISE_ALT=/path/to/bd.rnnn npx tsx docs/spikes/s13/run.ts   # also runs heavy with another RNNoise model
//   FFMPEG_ALT=/path/to/ffmpeg-6 npx tsx docs/spikes/s13/run.ts   # also runs light with a second ffmpeg and compares
//   npx tsx docs/spikes/s13/run.ts --sweep               # parameter variants, averaged over the speech fixtures
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIGHT,
  bestLag,
  gapRegions,
  gatedLoudness,
  readPcm16,
  rmsDb,
  sibilanceDb,
  type CleanupPreset,
  type LightParams,
  type Region,
} from '../../../app/server/lib/narration-cleanup.js'
import { cleanTake, ebur128, ffmpegVersion, pcmSha256 } from '../../../scripts/lib/narration-cleanup.js'

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const alt = process.env.FFMPEG_ALT
const altModel = process.env.RNNOISE_ALT
const dir = new URL('../../../app/test/fixtures/narration/', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 's13-'))
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.wav'))
  .sort()
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

/** Metrics of a file over the raw take's speech regions and gaps (outputs are sample-aligned with the input). */
function metrics(path: string, speech: Region[], gaps: Region[], ff = ffmpeg) {
  const s = readPcm16(readFileSync(path)).samples
  const e = ebur128(path, ff)
  const speechLufs = speech.length ? gatedLoudness(s, speech) : null
  return {
    samples: s.length,
    speechLufs: r1(speechLufs),
    wholeLufs: r1(e.integratedLufs),
    truePeakDb: r1(e.truePeakDb),
    plrDb: speechLufs === null ? null : r1(e.truePeakDb - speechLufs),
    gapFloorDb: r1(rmsDb(s, gaps)),
    sibilanceDb: speech.length ? r1(sibilanceDb(s, speech)) : null,
    pcmSha256: pcmSha256(path).slice(0, 16),
  }
}

function runOne(
  f: string,
  preset: CleanupPreset,
  params: LightParams = LIGHT,
  ff = ffmpeg,
  tag = '',
  rnnoiseModel?: string,
) {
  const input = join(dir, f)
  const out = join(tmp, `${f}.${preset}${tag}.wav`)
  const t0 = performance.now()
  const r = cleanTake({ input, output: out, preset, ffmpeg: ff, params, rnnoiseModel })
  return { r, out, ms: Math.round(performance.now() - t0) }
}

/** A processed take against the raw one: level, floor, SNR and 4-9 kHz changes, shift and determinism. */
function processed(
  f: string,
  preset: 'light' | 'heavy',
  raw: Int16Array,
  rawM: ReturnType<typeof metrics>,
  speech: Region[],
  gaps: Region[],
  rnnoiseModel?: string,
) {
  const tag = rnnoiseModel ? '.altmodel' : ''
  const a = runOne(f, preset, LIGHT, ffmpeg, tag, rnnoiseModel)
  const b = runOne(f, preset, LIGHT, ffmpeg, `${tag}.again`, rnnoiseModel)
  const m = metrics(a.out, speech, gaps)
  const firstSpeech = speech[0]
  const lag = firstSpeech
    ? bestLag(
        raw,
        readPcm16(readFileSync(a.out)).samples,
        { start: firstSpeech.start, end: Math.min(firstSpeech.end, firstSpeech.start + 48_000) },
        2000,
      )
    : null
  const change = (x: number | null, y: number | null) => (x === null || y === null ? null : r1(y - x))
  return {
    a,
    m: {
      ...m,
      samplesEqual: m.samples === rawM.samples,
      lagSamples: lag,
      gapFloorChangeDb: change(rawM.gapFloorDb, m.gapFloorDb),
      snrChangeDb:
        rawM.speechLufs === null || m.speechLufs === null || rawM.gapFloorDb === null || m.gapFloorDb === null
          ? null
          : r1(m.speechLufs - m.gapFloorDb - (rawM.speechLufs - rawM.gapFloorDb)),
      sibilanceChangeDb: change(rawM.sibilanceDb, m.sibilanceDb),
      deterministic: a.r.sha256 === b.r.sha256,
      ms: a.ms,
    },
  }
}

function table() {
  const rows = fixtures.map((f) => {
    const input = join(dir, f)
    const raw = readPcm16(readFileSync(input)).samples
    const off = runOne(f, 'off')
    const speech = off.r.speech
    const gaps = speech.length ? gapRegions(speech, raw.length) : [{ start: 0, end: raw.length }]
    const rawM = metrics(input, speech, gaps)
    const { a, m: light } = processed(f, 'light', raw, rawM, speech, gaps)
    const heavy = processed(f, 'heavy', raw, rawM, speech, gaps)
    const heavyAlt = altModel ? processed(f, 'heavy', raw, rawM, speech, gaps, altModel).m : undefined
    let altResult: Record<string, unknown> | undefined
    if (alt) {
      const c = runOne(f, 'light', LIGHT, alt, '.alt')
      const m = metrics(c.out, speech, gaps, alt)
      altResult = {
        version: ffmpegVersion(alt),
        filterSame: c.r.filter === a.r.filter,
        samples: m.samples,
        pcmSameAsPrimary: c.r.sha256 === a.r.sha256,
        speechLufs: m.speechLufs,
        truePeakDb: m.truePeakDb,
        gapFloorDb: m.gapFloorDb,
        ms: c.ms,
      }
    }
    return {
      fixture: f,
      speechRegions: speech.length,
      warnings: a.r.warnings,
      measured: a.r.measured,
      raw: rawM,
      off: { ...metrics(off.out, speech, gaps), bitExact: off.r.sha256 === pcmSha256(input), ms: off.ms },
      light,
      heavy: { ...heavy.m, measured: heavy.a.r.measured, warnings: heavy.a.r.warnings },
      ...(heavyAlt ? { heavyAltModel: heavyAlt } : {}),
      ...(altResult ? { alt: altResult } : {}),
    }
  })
  const q = rows.find((r) => r.fixture === 'punch-quiet.wav')
  const l = rows.find((r) => r.fixture === 'punch-loud.wav')
  const diff = (a?: number | null, b?: number | null) => (a == null || b == null ? null : r1(b - a))
  return {
    ffmpeg: ffmpegVersion(ffmpeg),
    ...(alt ? { ffmpegAlt: ffmpegVersion(alt) } : {}),
    params: LIGHT,
    rows,
    punch: {
      rawDiffLu: diff(q?.raw.speechLufs, l?.raw.speechLufs),
      lightDiffLu: diff(q?.light.speechLufs, l?.light.speechLufs),
      heavyDiffLu: diff(q?.heavy.speechLufs, l?.heavy.speechLufs),
    },
  }
}

/** Variants of the light chain, averaged over the speech fixtures. */
function sweep() {
  const variants: [string, LightParams][] = [
    ['v1 light', LIGHT],
    ['plan order (no pre-gain)', { ...LIGHT, preGainRange: [0, 0] }],
    ['afftdn nf = gap level (+0)', { ...LIGHT, noiseFloorOffsetDb: 0 }],
    ['afftdn nf = gap +15', { ...LIGHT, noiseFloorOffsetDb: 15 }],
    ['afftdn nf fixed -50 (default)', { ...LIGHT, noiseFloorRange: [-50, -50] }],
    ['afftdn nr 6', { ...LIGHT, noiseReductionDb: 6 }],
    ['afftdn nr 20', { ...LIGHT, noiseReductionDb: 20 }],
    ['deesser off', { ...LIGHT, deesser: { ...LIGHT.deesser, i: 0 } }],
    ['deesser 0.3', { ...LIGHT, deesser: { ...LIGHT.deesser, i: 0.3 } }],
    ['deesser 0.45', { ...LIGHT, deesser: { ...LIGHT.deesser, i: 0.45 } }],
    ['deesser 0.5', { ...LIGHT, deesser: { ...LIGHT.deesser, i: 0.5 } }],
    ['deesser 0.6', { ...LIGHT, deesser: { ...LIGHT.deesser, i: 0.6 } }],
    ['comp peak detection', { ...LIGHT, compressor: { ...LIGHT.compressor, detection: 'peak' } }],
    ['pre-target -20', { ...LIGHT, preTargetLufs: -20 }],
    ['target -16', { ...LIGHT, speechTargetLufs: -16 }],
  ]
  const speechFixtures = fixtures.filter((f) => f !== 'silence-only.wav')
  return variants.map(([name, params], vi) => {
    const per = speechFixtures.map((f) => {
      const input = join(dir, f)
      const raw = readPcm16(readFileSync(input)).samples
      const { r, out } = runOne(f, 'light', params, ffmpeg, `.v${vi}`)
      const gaps = gapRegions(r.speech, raw.length)
      const rawM = metrics(input, r.speech, gaps)
      const m = metrics(out, r.speech, gaps)
      return {
        f,
        snr: (m.speechLufs ?? 0) - (m.gapFloorDb ?? 0) - ((rawM.speechLufs ?? 0) - (rawM.gapFloorDb ?? 0)),
        sib: (m.sibilanceDb ?? 0) - (rawM.sibilanceDb ?? 0),
        err: Math.abs((m.speechLufs ?? 0) - params.speechTargetLufs),
        plr: m.plrDb ?? 0,
        limited: r.warnings.some((w) => w.startsWith('peak_limited')),
        chainLu:
          (rawM.speechLufs ?? 0) +
          (r.measured?.preGainDb ?? 0) +
          (r.measured?.trimDb ?? 0) -
          (m.speechLufs ?? 0),
      }
    })
    const avg = (k: 'snr' | 'sib' | 'err' | 'plr' | 'chainLu') =>
      r1(per.reduce((a, p) => a + p[k], 0) / per.length)
    return {
      variant: name,
      snrGainAvgDb: avg('snr'),
      snrGainLeastDb: r1(Math.min(...per.map((p) => p.snr))),
      noisyRoomSnrGainDb: r1(per.find((p) => p.f === 'noisy-room.wav')?.snr ?? null),
      sibilanceChangeAvgDb: avg('sib'),
      sibilantHeadsetChangeDb: r1(per.find((p) => p.f === 'sibilant-headset.wav')?.sib ?? null),
      targetErrAvgLu: avg('err'),
      targetErrMaxLu: r1(Math.max(...per.map((p) => p.err))),
      plrAvgDb: avg('plr'),
      compressionLu: avg('chainLu'),
      sibilanceByFixtureDb: Object.fromEntries(per.map((p) => [p.f.replace('.wav', ''), r1(p.sib)])),
      snrByFixtureDb: Object.fromEntries(per.map((p) => [p.f.replace('.wav', ''), r1(p.snr)])),
      peakLimited: per.filter((p) => p.limited).map((p) => p.f.replace('.wav', '')),
    }
  })
}

try {
  console.log(JSON.stringify(process.argv.includes('--sweep') ? sweep() : table(), null, 2))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
