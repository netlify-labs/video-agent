// Recorded narration's run inputs (plan 2026-11-02 §6.3 "Run inputs"). prepare-run hydrates the frozen takes into
// .va-run/narration/ at the repo root, outside video/, so they're never archived, checkpointed or previewed; the run's
// scripts/narration.ts reads them from there and writes its clean copies and receipt next to them.
//
//   .va-run/narration/manifest.json      what prepare-run hydrated (NarrationInputs below)
//   .va-run/narration/src/<mediaId>.wav  each take as 24 kHz mono PCM16 (recordings as uploaded, other uploads decoded)
//   .va-run/narration/clean/<mediaId>.wav  scripts/narration.ts: each take after the cleanup recipe
//   .va-run/narration/receipt.json       scripts/narration.ts: inputs, recipe, bus digest, spans, attempt id
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Language } from '../../app/server/lib/language.js'
import type { NarrationReceipt } from '../../app/server/lib/narration-run.js'
import type {
  CaptionPolicy,
  FrozenNarration,
  FrozenTake,
  FrozenTranscription,
} from '../../app/server/lib/run-manifest.js'

export const NARRATION_RUN_DIR = '.va-run/narration'

export const narrationPaths = (root: string) => {
  const dir = join(root, NARRATION_RUN_DIR)
  return {
    dir,
    /** Raw downloads, removed once each take is checked and in app/server/. */
    fetch: join(dir, 'fetch'),
    src: join(dir, 'src'),
    clean: join(dir, 'clean'),
    manifest: join(dir, 'manifest.json'),
    receipt: join(dir, 'receipt.json'),
    /** scripts/narration-stt.ts: transcription status and word timings (SttRecord). */
    stt: join(dir, 'stt.json'),
  }
}

/** One hydrated take: the frozen entry (sha256/bytes of the stored original) plus the local 24 kHz PCM16 copy. */
export interface HydratedTake extends FrozenTake {
  /** Relative to the repo root: .va-run/narration/src/<mediaId>.wav. */
  path: string
  /** sha256 of the local WAV file (equals `sha256` when the original already was 24 kHz mono PCM16 WAV). */
  wavSha256: string
  samples: number
  /** The original wasn't 24 kHz mono PCM16 WAV and was decoded with ffmpeg. */
  decoded: boolean
}

export interface NarrationInputs {
  v: 1
  jobId: string
  attemptId: string
  op: FrozenNarration['op']
  recipe: FrozenNarration['recipe']
  targetSamples: number
  captions: CaptionPolicy
  /** How scripts/narration-stt.ts transcribes the bus; missing: 'local'. */
  transcriptionProvider?: FrozenTranscription | undefined
  /** The language scripts/narration-stt.ts transcribes in; missing: 'en'. */
  language?: Language | undefined
  /**
   * A fit-to-narration run (author_from_frozen, plan 2026-11-02 §6.4): scripts/narration.ts mixes the bus at
   * targetSamples, the frozen target the agent fits the beats to, not at the root's length before it has.
   */
  fit?: true | undefined
  takes: HydratedTake[]
}

/** The hydrated inputs, or null when this run has no recorded narration. */
export function readNarrationInputs(root: string): NarrationInputs | null {
  const p = narrationPaths(root).manifest
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as NarrationInputs) : null
}

/** scripts/narration.ts's receipt, or null when it hasn't run (or wrote something that isn't JSON). */
export function readNarrationReceipt(root: string): NarrationReceipt | null {
  const p = narrationPaths(root).receipt
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as NarrationReceipt
  } catch {
    return null
  }
}
