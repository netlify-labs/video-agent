// Preview bundles (plan v2 §7, F0): each ready version's composition, extracted from its source.tar.gz into the
// bundles store so the sandboxed preview can serve it file by file. Immutable once written. Files are staged first
// and the manifest written last, so a half-written bundle is never served; a deletion that lands meanwhile wins.
import type { Deps } from '../deps.js'
import { excluded, isLibraryMedia } from '../lib/bundle-manifest.js'
import {
  isBundleReference,
  isReference,
  REFERENCES_FILE,
  referencesKey,
  type BundleReference,
} from '../lib/bundle-references.js'
import { sha256Hex } from '../lib/crypto.js'
import { validate, type Summary } from '../lib/contract.js'
import { readTarGz, TarError } from '../lib/tar.js'
import { engineInfo, type EngineId } from './engines.js'
import type { OutputRow } from './types.js'

export interface BundleEntry {
  path: string
  size: number
  sha256: string
  /**
   * Where an edit draft's unchanged or library file already is, or a version's reference file (the narration bus, in
   * videos); otherwise it's under the bundle's own f/.
   */
  src?: { store: 'bundles' | 'media' | 'videos'; key: string }
}
export interface BundleIndex {
  v: 1
  jobId: string
  versionN: number
  files: BundleEntry[]
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

/**
 * The composition's own files: the same set the bundle manifest counts (run inputs and caches stay out), less the
 * reference files, which never come from an archive.
 */
const keep = (path: string) => !excluded(path) && !isReference(path)

/**
 * Local media files index.html and its stylesheets point at that aren't in the bundle (library media aside).
 * A version saved before agent-made media was archived can reference files that were never kept.
 */
export function missingLocalFiles(files: Map<string, Uint8Array>): string[] {
  const text = [...files]
    .filter(([p]) => p === 'index.html' || p.endsWith('.css'))
    .map(([, b]) => new TextDecoder().decode(b))
    .join('\n')
  const refs = [
    // Media elements and posters (scripts and stylesheets come from the template), plus CSS url()s.
    ...text.matchAll(/<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi),
    ...text.matchAll(/\sposter\s*=\s*["']([^"']+)["']/gi),
    ...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi),
  ].map((m) => (m[1] ?? '').trim())
  const local = refs
    .filter((r) => r && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|_hf\/)/i.test(r))
    .map((r) => r.replace(/^\.\//, '').split(/[?#]/)[0] ?? '')
    .filter((r) => r && !r.startsWith('/'))
  // Library media is downloaded into every run from the version's snapshot, so only agent-made files can be missing.
  return [...new Set(local)].filter((r) => !isLibraryMedia(r) && !files.has(decodeURI(r))).sort()
}

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

/**
 * The contract check for a version's engine (render-engines plan §4.1): HyperFrames has editing contract v1; any other
 * engine isn't editable until its own contract lands. A missing engine is a row written before engines: HyperFrames.
 */
export function contractForEngine(
  engine: EngineId | undefined,
  files: Map<string, Uint8Array>,
): { version: 1 | null; violations: string[] } {
  const id = engine ?? 'hyperframes'
  if (id === 'hyperframes') return contractOf(files)
  return { version: null, violations: [`Editing isn't available for ${engineInfo(id).name} videos yet.`] }
}

/**
 * A version's reference entries (src/lib/bundle-references.ts), as finalize wrote them next to its source archive.
 * None for a version without (every one saved before them). Throws TarError when the list isn't the one pinned.
 */
export async function readReferences(
  deps: Pick<Deps, 'blobs'>,
  output: Pick<OutputRow, 'jobId' | 'versionN' | 'sha256'>,
): Promise<BundleReference[]> {
  const want = output.sha256[REFERENCES_FILE]
  if (!want) return []
  const raw = await deps.blobs.get('sources', referencesKey(output.jobId, output.versionN))
  if (!raw || sha256Hex(raw) !== want)
    throw new TarError("The saved composition's references don't match their hash.")
  const list = JSON.parse(new TextDecoder().decode(raw)) as unknown
  if (!Array.isArray(list) || !list.every((r) => isBundleReference(r, output.jobId)))
    throw new TarError("The saved composition's references are not valid.")
  return list
}

/** One reference file's bytes from the videos store, checked against its entry. Throws TarError on a mismatch. */
export async function fetchReference(deps: Pick<Deps, 'blobs'>, ref: BundleReference): Promise<Uint8Array> {
  const bytes = await deps.blobs.get('videos', ref.key)
  if (!bytes) throw new TarError(`The saved composition's ${ref.path} is missing.`)
  if (sha256Hex(bytes) !== ref.sha256 || bytes.byteLength !== ref.bytes)
    throw new TarError(`The saved composition's ${ref.path} doesn't match its hash.`)
  return bytes
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
  // Reference files are served from the videos store, checked here first (plan 2026-11-02 §6.2).
  const refs = await readReferences(deps, output)
  const refFiles = await Promise.all(refs.map(async (r) => [r.path, await fetchReference(deps, r)] as const))
  // Library media is by reference: the preview needs it next to the composition (plan v2 §14 rule 23).
  for (const m of await deps.store.listVersionMedia(jobId, n)) {
    if (m.kind === 'pdf') continue
    const path = `assets/media/${m.filename}`
    if (files.some(([p]) => p === path)) continue
    const bytes = await deps.blobs.get('media', m.key)
    if (bytes) files.push([path, bytes])
  }

  for (const [path, bytes] of files) await deps.blobs.set('bundles', bundleFileKey(jobId, n, path), bytes)
  const engine = (await deps.store.getVersion(jobId, n))?.engine
  const index: BundleIndex = {
    v: 1,
    jobId,
    versionN: n,
    files: [
      ...files.map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) })),
      ...refs.map((r) => ({
        path: r.path,
        size: r.bytes,
        sha256: r.sha256,
        src: { store: 'videos' as const, key: r.key },
      })),
    ],
    createdAt: deps.clock.now().toISOString(),
    contract: (() => {
      const all = new Map([...files, ...refFiles])
      const c = contractForEngine(engine, all)
      const missing = c.version === 1 ? missingLocalFiles(all) : []
      // Editing renders the saved composition as is, so it must have every file it uses.
      return missing.length
        ? {
            version: null,
            violations: [`It uses files that weren't saved: ${missing.slice(0, 5).join(', ')}.`],
          }
        : c
    })(),
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
