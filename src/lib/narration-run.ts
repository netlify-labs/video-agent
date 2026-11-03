// The one order of a render-unchanged run's steps (plan 2026-11-02 §6.3 "Ordering"): restore, re-voice (when the
// frozen bundle has lines to re-voice), mix the recorded narration (when it has narration), check, render. The prompt
// builder (src/domain/prompt.ts) numbers its steps from runSteps, prepare-run keeps the frozen copies the guards need
// (frozenFilesFor), and render-job's guards (src/lib/revoice.ts checkRevoiced, src/lib/narration-guard.ts
// checkNarration) allow exactly the files those steps write (mayChange). Re-voicing runs first because it can
// lengthen beats, and the bus is mixed at the composition's final length.
import { applyBusNarration, NARRATION_SRC, type Summary } from './contract.js'
import type { BUS_LIMITER } from './narration-bus.js'
import type { CleanupMeasured } from './narration-cleanup.js'
import { FROZEN_FILES, revoicable } from './revoice.js'
import type { RunManifest } from './run-manifest.js'
import type { NarrationOp, Span } from './timeline.js'

export type RunStep = 'prepare' | 'revoice' | 'narration' | 'check' | 'render'

type FrozenBundle = Pick<NonNullable<RunManifest['bundle']>, 'revoice' | 'narration'>

/** The steps a render-unchanged run takes for this frozen bundle (or just whether it has each), in order. */
export function runSteps(bundle: { revoice?: unknown; narration?: unknown } | null | undefined): RunStep[] {
  return [
    'prepare',
    ...(bundle?.revoice ? (['revoice'] as const) : []),
    ...(bundle?.narration ? (['narration'] as const) : []),
    'check',
    'render',
  ]
}

/** The deterministic transforms' commands, run from the repo root (the model only runs them). */
export const STEP_COMMANDS = {
  revoice: 'npx tsx scripts/voice.ts revoice',
  narration: 'npx tsx scripts/narration.ts',
} as const

/** What scripts/narration.ts writes in video/: the bus, the composition and (once captions land) summary.json. */
export const NARRATION_WRITES: readonly string[] = ['index.html', 'summary.json', NARRATION_SRC]

/**
 * Whether a run of this bundle may change `path` (relative to video/). The guards still recompute every changed file
 * from the frozen inputs; this only says which ones the byte-identical check leaves to them.
 */
export function mayChange(path: string, bundle: FrozenBundle | null | undefined): boolean {
  return runSteps(bundle).some((s) =>
    s === 'revoice'
      ? revoicable(path, bundle?.revoice?.beats ?? [])
      : s === 'narration' && NARRATION_WRITES.includes(path),
  )
}

/** The video/ files prepare-run copies to FROZEN_DIR right after restoring, for render-job to recompute from. */
export function frozenFilesFor(bundle: FrozenBundle | null | undefined): string[] {
  if (bundle?.revoice) return [...FROZEN_FILES]
  return bundle?.narration ? ['index.html', 'summary.json'] : []
}

/**
 * scripts/narration.ts's change to the composition (step 4), shared with checkNarration so the two can't disagree:
 * the narration element with its speech spans, the duck lane and the AI-voice levels (applyBusNarration). Captions
 * from the narration (bead va-2qq.3.13) will add their cues to `summary` here; until then it is returned unchanged.
 * TODO(hold beat): when the frozen target is longer than the visuals (holdFinalFrame), the appended data-va-hold beat
 * (contract holdBeatOf, from the hold-frame bead) is part of this transform too; add it here, before the bus layer,
 * so the script and the guard pick it up together.
 */
export function narrationTransform(
  html: string,
  summary: Summary,
  op: NarrationOp,
  speech: readonly Span[],
): { html: string; summary: Summary } {
  return { html: applyBusNarration(html, summary, op, speech).html, summary }
}

/** .va-run/narration/receipt.json, written by scripts/narration.ts step 5 and read by checkNarration. */
export interface NarrationReceipt {
  v: 1
  pipeline: number
  jobId: string
  attemptId: string
  inputs: {
    mediaId: string
    /** The stored original's sha256 (what the render froze). */
    sha256: string
    /** The hydrated 24 kHz WAV's sha256 (differs from sha256 when the upload was decoded). */
    wavSha256: string
    /** PCM sha256 of the clean take (the bypass: equal to the hydrated take's PCM). */
    cleanSha256: string
    samples: number
    filter: string | null
    measured: CleanupMeasured | null
    warnings: string[]
  }[]
  recipe: {
    pipeline: number
    cleanup: 'off' | 'light'
    /** First line of `ffmpeg -version`. */
    ffmpeg: string
    limiter: typeof BUS_LIMITER
    vad: number
  }
  /** The frozen length and the length mixed (the composition's root duration in samples). */
  target: { manifestSamples: number; samples: number }
  bus: {
    path: typeof NARRATION_SRC
    /** sha256 of video/assets/narration/bus.wav, and of its PCM alone. */
    sha256: string
    pcmSha256: string
    samples: number
    truePeakDb: number
    maxReductionDb: number
    limitedSamples: number
  }
  /** Speech in the processed bus, composition samples (before speechSeconds widens them to frames). */
  spans: Span[]
  warnings: string[]
}
