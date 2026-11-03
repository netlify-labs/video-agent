// Speech-to-text providers for recorded narration captions (plan 2026-11-02 §6.6, docs/spikes.md S11). Each one turns
// a 16 kHz mono WAV into word timings in seconds on the composition's clock (the bus starts at 0), in the video's
// language (src/lib/language.ts).
import type { Language } from '../../../src/lib/language.js'
import type { FrozenTranscription } from '../../../src/lib/run-manifest.js'

export interface SttWord {
  text: string
  start: number
  end: number
}

export type SttProviderName = Exclude<FrozenTranscription, 'off'>

export interface SttOutput {
  words: SttWord[]
  provider: SttProviderName
  model: string
  durationMs: number
}

export interface TranscribeOptions {
  /** Epoch ms by which install, download and transcription must all be done (the outer deadline). */
  deadlineAt: number
  /** Scratch space for the provider's own files (outside video/). */
  workDir: string
  /** Where `npx hyperframes` runs (video/, which pins the version). */
  cwd: string
  language: Language
}

export interface SttProvider {
  name: SttProviderName
  model: string
  transcribe(wav16kPath: string, opts: TranscribeOptions): Promise<SttOutput>
}

/** The outer deadline passed: the caller records status 'timeout'. */
export class SttTimeout extends Error {}

/** Milliseconds left before the deadline; throws SttTimeout once it has passed. */
export function remaining(deadlineAt: number, now = Date.now()): number {
  const ms = deadlineAt - now
  if (ms <= 0) throw new SttTimeout('The transcription deadline passed.')
  return ms
}
