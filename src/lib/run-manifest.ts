// What a run restores and downloads before it starts (plan v2 §14 rule 21). The server writes it at start time to
// the sources store and pins its sha256 in the prompt, so scripts/prepare-run.ts only ever follows keys the server
// chose: nothing the model writes (or a request smuggles in) can point it somewhere else.
import { createHash } from 'node:crypto'

export const RUN_MANIFEST_VERSION = 1

export type RunKind = 'author' | 'revision' | 'render_unchanged'

export interface RunManifest {
  v: typeof RUN_MANIFEST_VERSION
  jobId: string
  attemptId: string
  versionN: number
  kind: RunKind
  /** The parent version's source archive (revisions). */
  source: { key: string; sha256: string; parentN: number } | null
  /** A version-owned frozen bundle (render-unchanged runs): archive hash plus the canonical file manifest hash. */
  bundle: { key: string; sha256: string; manifestHash: string } | null
}

export const runManifestKey = (jobId: string, attemptId: string) => `${jobId}/runs/${attemptId}.json`

/** Stable bytes: the same inputs always serialize the same, so a re-sent start pins the same hash. */
export function serializeRunManifest(m: RunManifest): string {
  return JSON.stringify({
    v: m.v,
    jobId: m.jobId,
    attemptId: m.attemptId,
    versionN: m.versionN,
    kind: m.kind,
    source: m.source && { key: m.source.key, sha256: m.source.sha256, parentN: m.source.parentN },
    bundle: m.bundle && { key: m.bundle.key, sha256: m.bundle.sha256, manifestHash: m.bundle.manifestHash },
  })
}

export const sha256Hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

const HEX = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/

/** Parses and checks a downloaded manifest against the attempt and the hash from the prompt. Throws a message. */
export function verifyRunManifest(raw: string, expected: { attemptId: string; sha256: string }): RunManifest {
  if (sha256Hex(raw) !== expected.sha256)
    throw new Error("The run manifest doesn't match the hash in your prompt.")
  let m: Omit<RunManifest, 'v'> & { v: unknown }
  try {
    m = JSON.parse(raw) as typeof m
  } catch {
    throw new Error('The run manifest is not valid JSON.')
  }
  if (m.v !== RUN_MANIFEST_VERSION) throw new Error(`Unsupported run manifest version ${String(m.v)}.`)
  if (m.attemptId !== expected.attemptId) throw new Error('The run manifest is for a different attempt.')
  if (!ID.test(m.jobId) || !ID.test(m.attemptId)) throw new Error('The run manifest has a bad id.')
  if (!['author', 'revision', 'render_unchanged'].includes(m.kind)) throw new Error('Unknown run kind.')
  // Every key stays inside this video's own prefix.
  const own = (key: string) => key.startsWith(`${m.jobId}/`) && !key.includes('..') && !key.includes('//')
  if (m.source && (!own(m.source.key) || !HEX.test(m.source.sha256)))
    throw new Error('The run manifest has a bad source entry.')
  if (m.bundle && (!own(m.bundle.key) || !HEX.test(m.bundle.sha256) || !HEX.test(m.bundle.manifestHash)))
    throw new Error('The run manifest has a bad bundle entry.')
  if (m.kind === 'revision' && !m.source) throw new Error('A revision run needs a source.')
  if (m.kind === 'render_unchanged' && !m.bundle) throw new Error('A render-unchanged run needs a bundle.')
  return m as RunManifest
}
