// The reference line: how a PR or release finds its video before the server has `externalRef`
// (docs/plans/2026-11-04-github-action.md §3.5). Every brief with a target ends with it, and the lookup searches for
// it with GET /api/v1/videos?owner=me&q=<ref>.
import { createHash } from 'node:crypto'

export type Target =
  | { kind: 'pr'; owner: string; repo: string; number: number }
  | { kind: 'release'; owner: string; repo: string; tag: string }

export const REF_LINE_PREFIX = 'Tracking reference for automation (not for the video): '
/** The list's `q` limit (GET /api/v1/videos). */
export const REF_MAX = 200

/**
 * `[va-ref github:acme/web#pr-123]` or `[va-ref github:acme/web@v1.2.0]`. The closing bracket stops `#pr-12` matching
 * `#pr-123`. A GitHub owner is at most 39 characters and a repo name 100, so only a very long tag can push it past
 * the `q` limit; that tag is shortened with a hash, the same way every time.
 */
export function refFor(target: Target): string {
  const base = `[va-ref github:${target.owner}/${target.repo}`
  if (target.kind === 'pr') return `${base}#pr-${target.number}]`
  const full = `${base}@${target.tag}]`
  if (full.length <= REF_MAX) return full
  const hash = createHash('sha256').update(target.tag).digest('hex').slice(0, 10)
  const room = REF_MAX - base.length - '@~]'.length - hash.length
  return `${base}@${target.tag.slice(0, Math.max(0, room))}~${hash}]`
}

export function refLine(target: Target): string {
  return REF_LINE_PREFIX + refFor(target)
}

/** The prompt with the reference line as its last line, after a blank line. */
export function appendRef(prompt: string, target: Target): string {
  return `${prompt.trimEnd()}\n\n${refLine(target)}`
}

/** True when the prompt's last non-empty line is exactly the target's reference line (the lookup's client check). */
export function endsWithRef(prompt: string, target: Target): boolean {
  const lines = prompt.split('\n').filter((l) => l.trim() !== '')
  return lines.at(-1)?.trim() === refLine(target)
}

/** "acme/web#123" or "acme/web@v1.2.0", for logs and titles. */
export function describeTarget(target: Target): string {
  return target.kind === 'pr'
    ? `${target.owner}/${target.repo}#${target.number}`
    : `${target.owner}/${target.repo}@${target.tag}`
}
