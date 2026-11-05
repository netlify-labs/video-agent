// Cleans text from GitHub before it leaves the runner (docs/plans/2026-11-04-github-action.md §3.6): HTML comments
// (PR templates hide checklists there), images (they become library media instead), reference lines (so a PR
// description can't carry another PR's reference and hijack its lookup) and anything that looks like a secret.
// Counts what it removed by kind; never returns the matches.

export type ScrubKind =
  | 'html_comment'
  | 'image'
  | 'reference'
  | 'private_key'
  | 'github_token'
  | 'video_agent_key'
  | 'aws_key'
  | 'slack_token'
  | 'high_entropy'

export type Removed = Partial<Record<ScrubKind, number>>

const SECRET_KINDS: ScrubKind[] = [
  'private_key',
  'github_token',
  'video_agent_key',
  'aws_key',
  'slack_token',
  'high_entropy',
]

// Order matters: whole blocks first, so a key inside a private-key block counts once.
const PATTERNS: [ScrubKind, RegExp][] = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['video_agent_key', /\bnva_[A-Za-z0-9_]{16,}/g],
  ['aws_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack_token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/g],
]
const MARKUP: [ScrubKind, RegExp][] = [
  ['html_comment', /<!--[\s\S]*?(?:-->|$)/g],
  ['image', /!\[[^\]\n]*\]\([^)\n]*\)|<img\b[^>]*>/gi],
  ['reference', /\[\s*va-ref\b[^\]\n]*\]?/gi],
]

/** Long runs of token characters. `/` and `.` split them, so paths and file names stay whole words. */
const CANDIDATE = /[A-Za-z0-9+=_-]{32,}/g

function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length)
  return bits
}

/**
 * A random-looking token: upper and lower case, at least two digits, short lowercase runs and high entropy. Hex SHAs
 * and UUIDs have no upper case; CamelCase and snake_case words have long lowercase runs.
 */
export function looksRandom(token: string): boolean {
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token)) return false
  if ((token.match(/\d/g) ?? []).length < 2) return false
  // Words: CamelCase and snake_case identifiers have long lowercase runs; random tokens average under two.
  const runs = token.match(/[a-z]+/g) ?? []
  if (runs.join('').length / runs.length >= 3) return false
  return entropy(token) >= 4.2
}

function count(removed: Removed, kind: ScrubKind, n = 1) {
  removed[kind] = (removed[kind] ?? 0) + n
}

export interface ScrubOptions {
  /** Also remove HTML comments, images and reference lines (default). Off: secrets only (dispatch prompts). */
  markup?: boolean
}

/** Removes markup and secrets from `text`, adding what it removed to `removed`. */
export function scrub(text: string, removed: Removed = {}, opts: ScrubOptions = {}): string {
  let out = text
  const patterns = opts.markup === false ? PATTERNS : [...MARKUP, ...PATTERNS]
  for (const [kind, re] of patterns) {
    out = out.replace(re, () => {
      count(removed, kind)
      return kind === 'image' || kind === 'html_comment' || kind === 'reference' ? '' : '[removed]'
    })
  }
  out = out.replace(CANDIDATE, (token) => {
    if (!looksRandom(token)) return token
    count(removed, 'high_entropy')
    return '[removed]'
  })
  return out
}

const LABELS: Record<ScrubKind, [string, string]> = {
  html_comment: ['HTML comment', 'HTML comments'],
  image: ['image', 'images'],
  reference: ['reference line', 'reference lines'],
  private_key: ['private key', 'private keys'],
  github_token: ['GitHub token', 'GitHub tokens'],
  video_agent_key: ['Video Agent key', 'Video Agent keys'],
  aws_key: ['AWS key', 'AWS keys'],
  slack_token: ['Slack token', 'Slack tokens'],
  high_entropy: ['secret-looking string', 'secret-looking strings'],
}

/** "removed 1 GitHub token, 2 HTML comments", or "" when nothing was removed. For logs. */
export function describeRemoved(removed: Removed): string {
  const parts = (Object.keys(LABELS) as ScrubKind[])
    .filter((k) => (removed[k] ?? 0) > 0)
    .map((k) => {
      const n = removed[k] ?? 0
      const [one, many] = LABELS[k]
      return `${n} ${n === 1 ? one : many}`
    })
  return parts.length ? `removed ${parts.join(', ')}` : ''
}

/** How many secrets (not markup) were removed. */
export function secretsRemoved(removed: Removed): number {
  return SECRET_KINDS.reduce((n, k) => n + (removed[k] ?? 0), 0)
}
