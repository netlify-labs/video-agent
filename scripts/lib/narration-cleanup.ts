// Cleans one narration take with ffmpeg (docs/spikes.md S13): measure the raw take, run the light (or heavy) chain once
// without the trim to measure what it does, then once with the trim. `off` is a true bypass (the bytes are copied).
// ffmpeg runs single-threaded so the same take gives the same PCM within a run; the output's sample count is checked.
// heavy loads the vendored RNNoise model (./rnnoise/), whose sha256 is checked first.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLEANUP_SAMPLE_RATE,
  LIGHT,
  RNNOISE_MODEL,
  cleanupFilter,
  gapRegions,
  gatedLoudness,
  preGain,
  readPcm16,
  rmsDb,
  speechRegions,
  trimGain,
  type CleanupMeasured,
  type CleanupPreset,
  type LightParams,
  type Pcm16,
  type Region,
} from '../../app/server/lib/narration-cleanup.js'

const STEP_TIMEOUT_MS = 5 * 60_000

let modelChecked: string | undefined
/** The vendored RNNoise model's path, after checking its sha256 against the pinned one (once per process). */
export function rnnoiseModelPath(): string {
  const path = fileURLToPath(new URL(`./rnnoise/${RNNOISE_MODEL.file}`, import.meta.url))
  if (modelChecked === path) return path
  const got = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (got !== RNNOISE_MODEL.sha256)
    throw new Error(`${path}: sha256 ${got} is not the pinned RNNoise model ${RNNOISE_MODEL.sha256}`)
  modelChecked = path
  return path
}

function ff(ffmpeg: string, args: string[]): string {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', ...args], {
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0)
    throw new Error(`ffmpeg failed: ${(r.stderr || r.error?.message || '').trim().slice(-1500)}`)
  return r.stderr
}

export function ffmpegVersion(ffmpeg = 'ffmpeg'): string {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' })
  return /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown'
}

/** Reads a take and checks it is 24 kHz mono PCM16 (plan §6.3 step 1 converts uploads to that first). */
export function readTake(path: string): Pcm16 {
  const pcm = readPcm16(readFileSync(path))
  if (pcm.sampleRate !== CLEANUP_SAMPLE_RATE || pcm.channels !== 1)
    throw new Error(`${path}: expected 24 kHz mono, got ${pcm.sampleRate} Hz × ${pcm.channels}`)
  return pcm
}

/** sha256 of the PCM data alone (headers may differ between ffmpeg builds). */
export function pcmSha256(path: string): string {
  const b = readFileSync(path)
  const { dataOffset, dataBytes } = readPcm16(b)
  return createHash('sha256')
    .update(b.subarray(dataOffset, dataOffset + dataBytes))
    .digest('hex')
}

/** True peak (dBTP, 4× oversampled) and whole-file integrated loudness of the first audio stream, from ffmpeg's ebur128. */
export function ebur128(
  path: string,
  ffmpeg = 'ffmpeg',
): { truePeakDb: number; integratedLufs: number | null } {
  // -vn: an MP4's picture isn't decoded just to be thrown away (mastering measures the final render with this).
  const err = ff(ffmpeg, ['-i', path, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'])
  const summary = err.slice(err.lastIndexOf('Summary:'))
  const num = (re: RegExp) => {
    const m = re.exec(summary)?.[1]
    return m === undefined || m === '-inf' ? null : Number(m)
  }
  return {
    truePeakDb: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)/) ?? -120,
    integratedLufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
  }
}

/** One ffmpeg pass of a graph, written as bitexact 24 kHz mono PCM16. */
export function runChain(input: string, output: string, filter: string, ffmpeg = 'ffmpeg'): void {
  ff(ffmpeg, [
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-i',
    input,
    '-af',
    filter,
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-threads',
    '1',
    '-c:a',
    'pcm_s16le',
    '-ar',
    String(CLEANUP_SAMPLE_RATE),
    '-ac',
    '1',
    output,
  ])
}

export interface CleanResult {
  preset: CleanupPreset
  filter: string | null
  measured: CleanupMeasured | null
  speech: Region[]
  rawSpeechLufs: number | null
  inputSamples: number
  outputSamples: number
  sha256: string
  warnings: string[]
}

export function cleanTake(o: {
  input: string
  output: string
  preset: CleanupPreset
  ffmpeg?: string
  params?: LightParams
  /** Another RNNoise model for heavy (spikes compare models); the pinned, checked one otherwise. */
  rnnoiseModel?: string | undefined
}): CleanResult {
  const ffmpeg = o.ffmpeg ?? 'ffmpeg'
  const raw = readTake(o.input)
  const speech = speechRegions(raw.samples)
  const warnings: string[] = []
  if (!speech.length) warnings.push('no_speech: the take is silence or room tone only; no gain applied')
  const rawSpeechLufs = speech.length ? gatedLoudness(raw.samples, speech) : null
  let filter: string | null = null
  let measured: CleanupMeasured | null = null
  if (o.preset === 'off') copyFileSync(o.input, o.output)
  else {
    const p = o.params ?? LIGHT
    const rnnoise =
      o.preset === 'heavy'
        ? { model: o.rnnoiseModel ?? rnnoiseModelPath(), samples: raw.samples.length }
        : undefined
    const gaps = speech.length
      ? gapRegions(speech, raw.samples.length)
      : [{ start: 0, end: raw.samples.length }]
    measured = { noiseFloorDb: rmsDb(raw.samples, gaps), preGainDb: preGain(rawSpeechLufs, p), trimDb: 0 }
    const probe = `${o.output}.probe.wav`
    try {
      runChain(o.input, probe, cleanupFilter(o.preset, measured, p, rnnoise) ?? 'anull', ffmpeg)
      const cleaned = readTake(probe).samples
      const t = trimGain(
        speech.length ? gatedLoudness(cleaned, speech) : null,
        ebur128(probe, ffmpeg).truePeakDb,
        p,
      )
      if (t.peakLimited)
        warnings.push(`peak_limited: trim held to ${t.trimDb} dB by the ${p.peakCeilingDbtp} dBTP ceiling`)
      measured = { ...measured, trimDb: t.trimDb }
    } finally {
      rmSync(probe, { force: true })
    }
    filter = cleanupFilter(o.preset, measured, p, rnnoise)
    runChain(o.input, o.output, filter ?? 'anull', ffmpeg)
  }
  const out = readTake(o.output)
  if (out.samples.length !== raw.samples.length)
    throw new Error(`cleanup changed the sample count: ${raw.samples.length} -> ${out.samples.length}`)
  return {
    preset: o.preset,
    filter,
    measured,
    speech,
    rawSpeechLufs,
    inputSamples: raw.samples.length,
    outputSamples: out.samples.length,
    sha256: pcmSha256(o.output),
    warnings,
  }
}
