// Preview bundles (plan v2 §7, F0): each ready version's composition, extracted from its source.tar.gz into the
// bundles store so the sandboxed preview can serve it file by file. Immutable once written. Files are staged first
// and the manifest written last, so a half-written bundle is never served; a deletion that lands meanwhile wins.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { validate, type Summary } from '../lib/contract.js'
import { readTarGz, TarError } from '../lib/tar.js'

export interface BundleIndex {
  v: 1
  jobId: string
  versionN: number
  files: { path: string; size: number; sha256: string }[]
  createdAt: string
  /** Editing contract the composition conforms to, or null (with why), checked when the bundle was made. */
  contract?: { version: 1 | null; violations: string[] }
}

export const bundlePrefix = (jobId: string, n: number) => `${jobId}/v${n}/`
export const bundleIndexKey = (jobId: string, n: number) => `${bundlePrefix(jobId, n)}manifest.json`
export const bundleFileKey = (jobId: string, n: number, path: string) => `${bundlePrefix(jobId, n)}f/${path}`

/** Live snapshots from a running version's checkpoints (plan v2 §6 A2): one at a time, under the same capability. */
export const livePrefix = (jobId: string, n: number) => `${bundlePrefix(jobId, n)}live/`
export const liveIndexKey = (jobId: string, n: number, seq: number) =>
  `${livePrefix(jobId, n)}s${seq}/manifest.json`
export const liveFileKey = (jobId: string, n: number, seq: number, path: string) =>
  `${livePrefix(jobId, n)}s${seq}/f/${path}`

/** Rendered video and run inputs stay out: previews play the composition, not the MP4. */
const keep = (path: string) => !path.endsWith('.mp4') && path !== 'feedback' && !path.startsWith('feedback/')

/** Whether a composition keeps the editing contract (plan v2 §8): only ones that declare it are checked. */
export function contractOf(files: Map<string, Uint8Array>): { version: 1 | null; violations: string[] } {
  const dec = (p: string) => {
    const b = files.get(p)
    return b ? new TextDecoder().decode(b) : null
  }
  const html = dec('index.html')
  if (!html || !/data-va-contract\s*=\s*["']1["']/.test(html))
    return { version: null, violations: ['The composition does not declare editing contract v1.'] }
  let summary: Summary | undefined
  try {
    const s = dec('summary.json')
    summary = s ? (JSON.parse(s) as Summary) : undefined
  } catch {
    return { version: null, violations: ['summary.json is not valid JSON.'] }
  }
  const violations = validate(html, summary)
  return { version: violations.length ? null : 1, violations }
}

export async function readBundleIndex(deps: Pick<Deps, 'blobs'>, jobId: string, n: number) {
  const raw = await deps.blobs.get('bundles', bundleIndexKey(jobId, n))
  return raw ? (JSON.parse(new TextDecoder().decode(raw)) as BundleIndex) : null
}

/**
 * The version's bundle, extracting it first if needed (finalize does this for new versions; older versions are
 * extracted the first time someone previews them). Null when the version has no saved composition or the video is
 * gone. Throws TarError for an archive that fails validation.
 */
export async function ensureBundle(
  deps: Pick<Deps, 'blobs' | 'store' | 'clock' | 'log'>,
  jobId: string,
  n: number,
): Promise<BundleIndex | null> {
  const existing = await readBundleIndex(deps, jobId, n)
  if (existing) return existing
  const output = await deps.store.getOutput(jobId, n)
  const want = output?.sha256['source.tar.gz']
  if (!output || !want) return null
  const gz = await deps.blobs.get('sources', output.sourceKey)
  if (!gz) return null
  if (sha256Hex(gz) !== want) throw new TarError("The saved composition doesn't match its hash.")
  const files = [...readTarGz(gz)].filter(([path]) => keep(path))

  for (const [path, bytes] of files) await deps.blobs.set('bundles', bundleFileKey(jobId, n, path), bytes)
  const index: BundleIndex = {
    v: 1,
    jobId,
    versionN: n,
    files: files.map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) })),
    createdAt: deps.clock.now().toISOString(),
    contract: contractOf(new Map(files)),
  }
  await deps.blobs.set('bundles', bundleIndexKey(jobId, n), JSON.stringify(index), {
    contentType: 'application/json',
  })
  // A late writer must not resurrect a deleted video's files.
  const job = await deps.store.getJob(jobId)
  if (!job || job.deletedAt) {
    for (const k of await deps.blobs.list('bundles', bundlePrefix(jobId, n)))
      await deps.blobs.delete('bundles', k)
    return null
  }
  deps.log.info('bundle.extracted', { jobId, versionN: n, files: index.files.length })
  return index
}

/** Extracts a checkpoint's composition (already validated) as the version's live snapshot, replacing the last one. */
export async function writeLiveSnapshot(
  deps: Pick<Deps, 'blobs' | 'clock'>,
  jobId: string,
  n: number,
  seq: number,
  files: Map<string, Uint8Array>,
) {
  const kept = [...files].filter(([path]) => keep(path))
  for (const [path, bytes] of kept) await deps.blobs.set('bundles', liveFileKey(jobId, n, seq, path), bytes)
  const index: BundleIndex = {
    v: 1,
    jobId,
    versionN: n,
    files: kept.map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) })),
    createdAt: deps.clock.now().toISOString(),
  }
  await deps.blobs.set('bundles', liveIndexKey(jobId, n, seq), JSON.stringify(index), {
    contentType: 'application/json',
  })
  // Older snapshots go once the new one is committed.
  for (const k of await deps.blobs.list('bundles', livePrefix(jobId, n)))
    if (!k.startsWith(`${livePrefix(jobId, n)}s${seq}/`)) await deps.blobs.delete('bundles', k)
}
