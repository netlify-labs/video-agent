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
  /**
   * In context mode (servers that list `context`): the GitHub text, sent beside a short prompt and given to the run in
   * its own fence as data.
   */
  context?: ContextField
}

export interface ContextField {
  source: 'github_pr' | 'github_release' | 'changelog' | 'text'
  /** At most 120 characters. */
  label: string
  url?: string
  /** At most 12,000 characters here (the API takes 16,000). */
  text: string
}
