// Recorded narration for a run (plan 2026-11-02 §6.3 steps 1-5, §6.5; NARRATION_PIPELINE = 1). Deterministic code the
// run invokes, never the model: after prepare-run (which hydrated the takes into .va-run/narration/) and after any
// re-voice (npx tsx scripts/voice.ts revoice, which can lengthen beats), from the repo root:
//   npx tsx scripts/narration.ts
// Runs standalone in any prepared workspace (FFMPEG=<path> picks the ffmpeg binary). Steps, each logged as a JSON line
// with its duration:
//   1. verify   each hydrated take against the manifest prepare-run wrote (WAV sha256, 24 kHz mono, sample count)
//   2. clean    each take with the frozen recipe (light = S13 chain, off = bit-exact bypass) into
//               .va-run/narration/clean/<mediaId>.wav; the sample count must not change
//   3. mix      the bus with timeline.mixToBuffer at exactly the composition's FINAL root duration in samples (after a
//               re-voice that can differ from the frozen targetSamples: the bus is padded or cut to the root, and both
//               lengths are logged), then pre-limited to -2 dBTP (src/lib/narration-bus.ts)
//   4. write    video/assets/narration/bus.wav (24 kHz mono PCM16), data-va-speech from the processed bus's VAD and the
//               duck lane (contract applyBusNarration), validated with the bus's sample count
//   5. receipt  .va-run/narration/receipt.json: input and clean digests, recipe (with ffmpeg's version line), bus
//               digest and samples, speech spans and the attempt id. The guard reads it instead of redoing cleanup.
// Silence-only takes get no gain and a no_speech warning. Same inputs give the same bus within a run; across ffmpeg
// builds that is best-effort (the receipt records the version). Exits non-zero on any failure: stop and report it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, NARRATION_SRC, read, validate, type Summary } from '../src/lib/contract.js'
import { BUS_LIMITER, floatToPcm16, limitBus, pcm16ToFloat } from '../src/lib/narration-bus.js'
import { NARRATION_PIPELINE } from '../src/lib/narration-cleanup.js'
import { narrationTransform, type NarrationReceipt } from '../src/lib/narration-run.js'
import { detectSpeech, VAD_VERSION } from '../src/lib/peaks.js'
import type { RunManifest } from '../src/lib/run-manifest.js'
import { MAX_OUTPUT_SAMPLES, SAMPLE_RATE, mixToBuffer } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'
import { cleanTake, pcmSha256, readTake } from './lib/narration-cleanup.js'
import { narrationPaths, readNarrationInputs } from './lib/narration-inputs.js'
import { StepError, assertNoTakesInVideo, log, repoRoot, run, sha256File } from './lib/run-tools.js'

/** The receipt's shape lives with the guard that reads it (src/lib/narration-run.ts). */
export type { NarrationReceipt }

const r2 = (n: number) => Math.round(n * 100) / 100

/** PCM16 little-endian bytes, whatever the host's byte order. */
function le16(s: Int16Array): Uint8Array {
  const out = new Uint8Array(s.length * 2)
  const v = new DataView(out.buffer)
  for (let i = 0; i < s.length; i++) v.setInt16(i * 2, s[i] ?? 0, true)
  return out
}

/** Runs the pipeline over the prepared workspace at `root`. Throws a StepError the run should stop on. */
export function runNarration(o: { root?: string; ffmpeg?: string } = {}): NarrationReceipt {
  const root = o.root ?? repoRoot
  const ffmpeg = o.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg'
  const p = narrationPaths(root)
  const videoDir = join(root, 'video')
  const t0 = Date.now()
  const timed = <T>(step: string, fn: () => T, fields: (r: T) => Record<string, unknown> = () => ({})): T => {
    const start = Date.now()
    const r = fn()
    log(step, { ms: Date.now() - start, ...fields(r) })
    return r
  }

  // 1. Verify.
  const inputs = readNarrationInputs(root)
  if (!inputs)
    throw new StepError(`No recorded narration to mix (${p.manifest} is missing). Run prepare-run first.`)
  if (inputs.recipe.pipeline !== NARRATION_PIPELINE)
    throw new StepError(
      `This render was frozen for narration pipeline ${inputs.recipe.pipeline}; this script is ${NARRATION_PIPELINE}. Stop and report this.`,
    )
  const runManifest = join(root, '.render', 'run-manifest.json')
  if (existsSync(runManifest)) {
    const m = JSON.parse(readFileSync(runManifest, 'utf8')) as Pick<RunManifest, 'attemptId'>
    if (m.attemptId !== inputs.attemptId)
      throw new StepError(
        "The hydrated narration is from a different attempt than this run's manifest. Run prepare-run again.",
      )
  }
  const op = inputs.op
  const ids = new Set(inputs.takes.map((t) => t.mediaId))
  for (const c of op.clips)
    if (!ids.has(c.mediaId))
      throw new StepError(
        `Narration clip ${c.id} plays take ${c.mediaId}, which wasn't hydrated. Stop and report this.`,
      )
  timed(
    'narration.verify',
    () => {
      for (const t of inputs.takes) {
        const path = join(root, t.path)
        if (!existsSync(path) || sha256File(path) !== t.wavSha256)
          throw new StepError(
            `Narration take ${t.mediaId} changed since prepare-run hydrated it. Stop and report this.`,
          )
        let samples: number
        try {
          samples = readTake(path).samples.length
        } catch (e) {
          throw new StepError(`Narration take ${t.mediaId}: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (samples !== t.samples)
          throw new StepError(`Narration take ${t.mediaId} has ${samples} samples, not ${t.samples}.`)
      }
    },
    () => ({ takes: inputs.takes.length, clips: op.clips.length }),
  )
  let ffmpegLine: string
  try {
    ffmpegLine = run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 30_000 }).split('\n')[0]?.trim() ?? ''
  } catch (e) {
    if (inputs.recipe.cleanup !== 'off') throw e
    ffmpegLine = 'unavailable'
  }

  // 2. Clean each take.
  mkdirSync(p.clean, { recursive: true })
  const warnings: string[] = []
  const cleaned = inputs.takes.map((t) => {
    const output = join(p.clean, `${t.mediaId}.wav`)
    const r = timed(
      'narration.clean',
      () => {
        try {
          return cleanTake({ input: join(root, t.path), output, preset: inputs.recipe.cleanup, ffmpeg })
        } catch (e) {
          throw new StepError(
            `Cleaning take ${t.mediaId} failed: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      },
      (x) => ({
        mediaId: t.mediaId,
        preset: x.preset,
        samples: x.outputSamples,
        measured: x.measured,
        warnings: x.warnings,
      }),
    )
    if (r.outputSamples !== t.samples || r.inputSamples !== t.samples)
      throw new StepError(
        `Cleaning take ${t.mediaId} changed its length (${t.samples} -> ${r.outputSamples}).`,
      )
    for (const w of r.warnings) warnings.push(`${t.mediaId}: ${w}`)
    return { take: t, output, result: r }
  })

  // 3. Mix at the root's final length, then pre-limit.
  const indexPath = join(videoDir, 'index.html')
  const summaryPath = join(videoDir, 'summary.json')
  if (!existsSync(indexPath) || !existsSync(summaryPath))
    throw new StepError('video/index.html or video/summary.json is missing. Run prepare-run first.')
  const html = readFileSync(indexPath, 'utf8')
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
  const target = Math.round(read(load(html)).duration * SAMPLE_RATE)
  if (!(target > 0) || target > MAX_OUTPUT_SAMPLES)
    throw new StepError(`The composition's duration (${target} samples) can't take a narration bus.`)
  if (target !== inputs.targetSamples)
    log('narration.target', {
      manifestSamples: inputs.targetSamples,
      samples: target,
      change: target > inputs.targetSamples ? 'padded' : 'truncated',
      note: "The bus follows the composition's root duration (after any re-voice).",
    })
  const mixed = timed(
    'narration.mix',
    () => {
      const takes = new Map(cleaned.map((c) => [c.take.mediaId, pcm16ToFloat(readTake(c.output).samples)]))
      return mixToBuffer(op.clips, takes, target, op.tracks)
    },
    (b) => ({ samples: b.length }),
  )
  const limited = timed(
    'narration.limit',
    () => limitBus(mixed),
    (l) => ({
      ceilingDbtp: BUS_LIMITER.ceilingDbtp,
      truePeakDb: r2(l.truePeakDb),
      maxReductionDb: r2(l.maxReductionDb),
      limitedSamples: l.limitedSamples,
    }),
  )

  // 4. Write the bus, its speech spans and the duck lane.
  const busPath = join(videoDir, NARRATION_SRC)
  const spans = timed(
    'narration.write',
    () => {
      mkdirSync(join(videoDir, 'assets', 'narration'), { recursive: true })
      writeFileSync(busPath, wav(le16(floatToPcm16(limited.bus))))
      const speech = detectSpeech(limited.bus)
      // The same transform render-job's checkNarration recomputes from the frozen files and this receipt.
      const out = narrationTransform(html, summary, op, speech)
      if (Math.round(read(load(out.html)).duration * SAMPLE_RATE) !== target)
        throw new StepError("Writing the narration changed the composition's duration. Stop and report this.")
      const violations = validate(out.html, out.summary, { narration: { busSamples: target } })
      if (violations.length)
        throw new StepError(
          `The narrated composition breaks the editing contract:\n- ${violations.join('\n- ')}`,
        )
      writeFileSync(indexPath, out.html)
      if (JSON.stringify(out.summary) !== JSON.stringify(summary))
        writeFileSync(summaryPath, JSON.stringify(out.summary, null, 2))
      return speech
    },
    (s) => ({ bus: NARRATION_SRC, samples: target, spans: s.length }),
  )

  // 5. Receipt.
  const receipt: NarrationReceipt = {
    v: 1,
    pipeline: NARRATION_PIPELINE,
    jobId: inputs.jobId,
    attemptId: inputs.attemptId,
    inputs: cleaned.map(({ take, result }) => ({
      mediaId: take.mediaId,
      sha256: take.sha256,
      wavSha256: take.wavSha256,
      cleanSha256: result.sha256,
      samples: take.samples,
      filter: result.filter,
      measured: result.measured,
      warnings: result.warnings,
    })),
    recipe: {
      pipeline: inputs.recipe.pipeline,
      cleanup: inputs.recipe.cleanup,
      ffmpeg: ffmpegLine,
      limiter: BUS_LIMITER,
      vad: VAD_VERSION,
    },
    target: { manifestSamples: inputs.targetSamples, samples: target },
    bus: {
      path: NARRATION_SRC,
      sha256: sha256File(busPath),
      pcmSha256: pcmSha256(busPath),
      samples: target,
      truePeakDb: r2(limited.truePeakDb),
      maxReductionDb: r2(limited.maxReductionDb),
      limitedSamples: limited.limitedSamples,
    },
    spans,
    warnings,
  }
  writeFileSync(p.receipt, JSON.stringify(receipt, null, 2))
  assertNoTakesInVideo(root)
  log('narration.done', { ms: Date.now() - t0, bus: receipt.bus.sha256, warnings })
  return receipt
}

if (process.argv[1]?.endsWith('scripts/narration.ts'))
  try {
    const r = runNarration()
    console.log(
      `Narration bus written: ${(r.bus.samples / SAMPLE_RATE).toFixed(2)} s, ${r.spans.length} speech spans${r.warnings.length ? ` (warnings: ${r.warnings.join('; ')})` : ''}. Continue.`,
    )
  } catch (e) {
    log('failed', { error: e instanceof Error ? e.message : String(e) })
    console.error(`narration failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
