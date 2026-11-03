// Reference entries of a bundle (plan 2026-11-02 §6.2): large run outputs that are part of the composition, and so
// count in its manifest hash, but are stored in Blobs by key instead of inside source.tar.gz, checkpoints and preview
// bundles, which keep their tar limits. Restorers fetch each one by key and check its sha256. No Node imports: the
// preview edge function uses this too.

/** One file of the composition stored by reference: its path in video/, its key in the videos store and digest. */
export interface BundleReference {
  path: string
  key: string
  sha256: string
  bytes: number
}

/** Bundle path → the file name the run uploads it as, and finalize keeps it under in the version's prefix. */
export const REFERENCE_FILES: Readonly<Record<string, string>> = {
  // The recorded narration bus (contract.ts NARRATION_SRC): a 24 kHz PCM16 bus passes the 10 MiB tar limit at ~218 s.
  'assets/narration/bus.wav': 'narration-bus.wav',
}

/** The largest file kept by reference (a 46-minute 24 kHz PCM16 bus). */
export const MAX_REFERENCE_BYTES = 128 * 1024 * 1024

export const isReference = (path: string) => Object.hasOwn(REFERENCE_FILES, path)

/** Where finalize keeps a version's reference file in the videos store. */
export const referenceKey = (jobId: string, n: number, path: string) =>
  `${jobId}/v${n}/${REFERENCE_FILES[path] ?? ''}`

/** Where finalize writes a version's reference entries, next to its source archive in the sources store. */
export const referencesKey = (jobId: string, n: number) => `${jobId}/v${n}.references.json`

/** The output-hash name of that file (OutputRow.sha256), so it is pinned like every other saved file. */
export const REFERENCES_FILE = 'references.json'

const HEX = /^[0-9a-f]{64}$/

/** Parsed JSON: checks one entry's shape, and that its key is the one finalize gives that path in `jobId`. */
export function isBundleReference(v: unknown, jobId: string): v is BundleReference {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.path === 'string' &&
    isReference(r.path) &&
    typeof r.key === 'string' &&
    new RegExp(`^${jobId}/v\\d{1,6}/${REFERENCE_FILES[r.path]?.replace('.', '\\.')}$`).test(r.key) &&
    typeof r.sha256 === 'string' &&
    HEX.test(r.sha256) &&
    Number.isInteger(r.bytes) &&
    (r.bytes as number) > 0 &&
    (r.bytes as number) <= MAX_REFERENCE_BYTES
  )
}
