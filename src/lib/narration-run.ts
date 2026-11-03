// The one order of a render-unchanged run's steps (plan 2026-11-02 §6.3 "Ordering"): restore, re-voice (when the
// frozen bundle has lines to re-voice), mix the recorded narration and transcribe it for captions (when it has
// narration), check, render. The prompt
// builder (src/domain/prompt.ts) numbers its steps from runSteps, prepare-run keeps the frozen copies the guards need
// (frozenFilesFor), and render-job's guards (src/lib/revoice.ts checkRevoiced, src/lib/narration-guard.ts
// checkNarration) allow exactly the files those steps write (mayChange). Re-voicing runs first because it can
// lengthen beats, and the bus is mixed at the composition's final length.
import { applyBusNarration, HOLD_STILL_SRC, NARRATION_SRC, type Summary } from './contract.js'
import type { BUS_LIMITER } from './narration-bus.js'
import type { CleanupMeasured } from './narration-cleanup.js'
import { groupWords, withNarrationCues, type CueWord } from './narration-captions.js'
import { FROZEN_FILES, revoicable } from './revoice.js'
import type { RunManifest } from './run-manifest.js'
import type { NarrationOp, Span } from './timeline.js'

export type RunStep = 'prepare' | 'revoice' | 'narration' | 'transcribe' | 'check' | 'render'

type FrozenBundle = Pick<NonNullable<RunManifest['bundle']>, 'revoice' | 'narration'>

/** The steps a render-unchanged run takes for this frozen bundle (or just whether it has each), in order. */
export function runSteps(bundle: { revoice?: unknown; narration?: unknown } | null | undefined): RunStep[] {
  return [
    'prepare',
    ...(bundle?.revoice ? (['revoice'] as const) : []),
    ...(bundle?.narration ? (['narration', 'transcribe'] as const) : []),
    'check',
    'render',
  ]
}

/** The deterministic transforms' commands, run from the repo root (the model only runs them). */
export const STEP_COMMANDS = {
  revoice: 'npx tsx scripts/voice.ts revoice',
  narration: 'npx tsx scripts/narration.ts',
  transcribe: 'npx tsx scripts/narration-stt.ts',
} as const

/**
 * What scripts/narration.ts writes in video/: the bus, the composition and the held frame's still (written when the
 * composition holds its last frame, removed otherwise).
 */
export const NARRATION_WRITES: readonly string[] = ['index.html', NARRATION_SRC, HOLD_STILL_SRC]

/**
 * What scripts/narration-stt.ts writes in video/: summary.json, the frozen cues plus the narration's (outside video/
 * it writes .va-run/narration/stt.json and the receipt's `stt`).
 */
export const TRANSCRIBE_WRITES: readonly string[] = ['summary.json']

/**
 * Whether a run of this bundle may change `path` (relative to video/). The guards still recompute every changed file
 * from the frozen inputs; this only says which ones the byte-identical check leaves to them.
 */
export function mayChange(path: string, bundle: FrozenBundle | null | undefined): boolean {
  return runSteps(bundle).some((s) =>
    s === 'revoice'
      ? revoicable(path, bundle?.revoice?.beats ?? [])
      : (s === 'narration' && NARRATION_WRITES.includes(path)) ||
        (s === 'transcribe' && TRANSCRIBE_WRITES.includes(path)),
  )
}

/** The video/ files prepare-run copies to FROZEN_DIR right after restoring, for render-job to recompute from. */
export function frozenFilesFor(bundle: FrozenBundle | null | undefined): string[] {
  if (bundle?.revoice) return [...FROZEN_FILES]
  return bundle?.narration ? ['index.html', 'summary.json'] : []
}

/**
 * Files prepare-run copies too when the bundle has them: a base's held-frame still, which the narration step
 * replaces or removes, so checkNarration can put the frozen one back into the bundle's manifest hash.
 */
export const optionalFrozenFilesFor = (bundle: FrozenBundle | null | undefined): string[] =>
  bundle?.narration ? [HOLD_STILL_SRC] : []

/**
 * scripts/narration.ts's change to the composition (step 4), shared with checkNarration so the two can't disagree:
 * the narration element with its speech spans, the duck lane and the AI-voice levels (applyBusNarration). A held last
 * frame (contract applyHoldFrame) is already in the frozen composition, so it isn't part of this; its still is
 * (scripts/lib/hold-still.ts, receipt.hold). summary.json is the transcribe step's (narrationSummary).
 */
export function narrationTransform(
  html: string,
  summary: Summary,
  op: NarrationOp,
  speech: readonly Span[],
): { html: string; summary: Summary } {
  return { html: applyBusNarration(html, summary, op, speech).html, summary }
}

/** The transcript the transcribe step left in .va-run/narration/stt.json (the fields the cues come from). */
export interface NarrationTranscript {
  status: 'ok' | 'failed' | 'off' | 'timeout'
  words: CueWord[]
}

/**
 * scripts/narration-stt.ts's change to summary.json, shared with checkNarration: the frozen cues, all kept (the
 * audible rule applies when render-job writes captions.vtt), plus the narration cues grouped from the transcript's
 * words (none unless it is ok; earlier narration cues are replaced).
 */
export function narrationSummary(summary: Summary, transcript: NarrationTranscript | null): Summary {
  const cues = transcript?.status === 'ok' ? groupWords(transcript.words) : []
  return { ...summary, captions: withNarrationCues(summary.captions ?? [], cues) }
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
  /** The held frame's still the run rendered (video/assets/hold/last.png), or null without a held frame. */
  hold: { path: typeof HOLD_STILL_SRC; sha256: string; atSeconds: number; holdSeconds: number } | null
  warnings: string[]
  /** Written afterwards by scripts/narration-stt.ts: its status, provider and model, and the word count. */
  stt?: {
    status: NarrationTranscript['status']
    provider: string | null
    model: string | null
    words: number
  }
}
