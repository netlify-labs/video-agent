import type { Removed } from './scrub.js'

/** What every brief builder returns. */
export interface Brief {
  /** The request for POST /api/v1/videos (or a revise or remix), at most 4,000 characters. */
  prompt: string
  /** The video's title, at most 120 characters, when the brief has one. */
  title?: string
  /** `[va-ref …]` when the brief is for a PR or release (its last line holds it). */
  reference?: string
  /** The default length in seconds for this kind of video, when it has one. */
  durationSec?: number
  /** What scrubbing removed from GitHub text, by kind (log it with describeRemoved). */
  removed: Removed
  /** Things the caller should log: text left out or trimmed, and why. */
  warnings: string[]
}
