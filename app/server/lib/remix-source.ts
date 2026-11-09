// The source a remix starts from (plan 2026-11-03 §2 gotcha 3, §3.1 step 4): a copy of the original version's
// source.tar.gz. A narrated version's archive leaves out the narration bus, but its composition still has the
// recorded-narration layer, the AI voice muted or ducked under it, a held last frame for narration that ran past the
// end, and narration: true caption cues. Recorded narration doesn't carry over to a remix in v1 (§0), so it is
// removed here, deterministically, and the result is checked against the editing contract before it is repacked.
import { createHash } from 'node:crypto'
import {
  applyHoldFrame,
  applyNarration,
  ContractError,
  holdBeatOf,
  load,
  save,
  validate,
  type Summary,
} from './contract.js'
import { BUNDLE_LIMITS, readTarGz, TarError, writeTarGz } from './tar.js'

export interface CleanedRemixSource {
  /** The archive to copy: the input itself when nothing was removed. */
  bytes: Uint8Array
  /** sha256 of `bytes`, hex. */
  sha256: string
  /** Recorded narration was taken out (only ever for a narrated source). */
  narrationDropped: boolean
}

/** archive: unreadable, over BUNDLE_LIMITS or unsafe; invalid: the composition is missing or breaks the contract. */
export type RemixSourceProblem = 'archive' | 'invalid'

export class RemixSourceError extends Error {
  constructor(
    readonly problem: RemixSourceProblem,
    message: string,
    readonly violations: string[] = [],
  ) {
    super(message)
    this.name = 'RemixSourceError'
  }
}

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const NARRATION_DIR = 'assets/narration/'
const HOLD_DIR = 'assets/hold/'

function unpack(tarGz: Uint8Array): Map<string, Uint8Array> {
  try {
    return readTarGz(tarGz, BUNDLE_LIMITS)
  } catch (e) {
    if (e instanceof TarError)
      throw new RemixSourceError('archive', `The source archive can't be used: ${e.message}`)
    throw e
  }
}

const invalid = (violations: string[]) =>
  new RemixSourceError(
    'invalid',
    `The source composition doesn't conform: ${violations.join(' ')}`,
    violations,
  )

/**
 * The source archive a remix copies. Not narrated: the input bytes as they are (same hash), once they read within
 * BUNDLE_LIMITS. Narrated: the narration layer is removed and the AI voice's own levels put back
 * (applyNarration(…, null)), the held last frame and its still go, narration: true cues leave summary.json, any
 * assets/narration/* file is dropped, and the result must validate before it is repacked. Same input, same bytes.
 * Throws RemixSourceError for an archive that's unreadable or over the limits, or a composition that doesn't conform.
 */
export function cleanRemixSource(tarGz: Uint8Array, opts: { narrated: boolean }): CleanedRemixSource {
  const files = unpack(tarGz)
  if (!opts.narrated) return { bytes: tarGz, sha256: sha256Hex(tarGz), narrationDropped: false }

  const htmlBytes = files.get('index.html')
  if (!htmlBytes) throw invalid(['The archive has no index.html.'])
  const html = new TextDecoder().decode(htmlBytes)
  const summaryBytes = files.get('summary.json')
  let summary: Summary = {}
  if (summaryBytes) {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(summaryBytes))
    } catch {
      throw invalid(["summary.json isn't valid JSON."])
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw invalid(["summary.json isn't an object."])
    summary = parsed as Summary
    if (summary.captions !== undefined && !Array.isArray(summary.captions))
      throw invalid(["summary.json's captions aren't a list."])
  }
  const nextSummary: Summary = summary.captions
    ? { ...summary, captions: summary.captions.filter((c) => !c.narration) }
    : summary

  let out: string
  try {
    // Removes the bus layer and undoes the levels the narration set (muted or lowered AI voice, muteAll), then lays
    // the video out again, so the music's dip follows only the unmuted AI voice.
    const removed = applyNarration(html, nextSummary, null).html
    // The held frame only covers narration that ran past the visuals' end (applyNarration's holdSeconds).
    const d = load(removed)
    if (holdBeatOf(d)) applyHoldFrame(d, 0)
    out = save(d)
  } catch (e) {
    if (e instanceof ContractError) throw invalid(e.violations)
    throw e
  }
  const problems = validate(out, nextSummary)
  if (problems.length) throw invalid(problems)

  const next = new Map<string, Uint8Array>()
  for (const [path, bytes] of files)
    if (!path.startsWith(NARRATION_DIR) && !path.startsWith(HOLD_DIR)) next.set(path, bytes)
  next.set('index.html', new TextEncoder().encode(out))
  if (summaryBytes && nextSummary !== summary)
    next.set('summary.json', new TextEncoder().encode(`${JSON.stringify(nextSummary, null, 2)}\n`))
  const bytes = writeTarGz(next)
  return { bytes, sha256: sha256Hex(bytes), narrationDropped: true }
}
