// The canonical file manifest of a composition (plan v2 §14 rule 21). One hash covers every composition file and
// summary.json, plus the digests of the media the version references. Media bytes (assets/media/), check caches
// and anything else generated stays out, so the hash only changes when what gets rendered changes.
// Shared by the server (freezing a bundle), scripts/prepare-run.ts (restore) and scripts/render-job.ts (re-check).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface MediaDigest {
  id: string
  sha256: string
}

export interface BundleManifest {
  files: { path: string; sha256: string }[]
  media: MediaDigest[]
  hash: string
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** Paths (relative to video/, with forward slashes) that never count. Matches what render-job leaves out of
 * source.tar.gz (node_modules, .hyperframes, renders, feedback, *.mp4), so a restored archive hashes the same. */
export function excluded(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules' || p === 'renders')) return true
  if (path.endsWith('.mp4')) return true
  // Feedback stills are run inputs, not part of the composition.
  if (path === 'feedback' || path.startsWith('feedback/')) return true
  return path === 'assets/media' || path.startsWith('assets/media/')
}

/** Hash over the sorted (path, sha256) list and sorted media digests, as canonical JSON. */
export function manifestHash(files: BundleManifest['files'], media: MediaDigest[]): string {
  const f = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const m = [...media].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sha256(
    JSON.stringify({ v: 1, files: f.map((x) => [x.path, x.sha256]), media: m.map((x) => [x.id, x.sha256]) }),
  )
}

export function bundleManifest(dir: string, media: MediaDigest[] = []): BundleManifest {
  const files: BundleManifest['files'] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = relative(dir, full).split(sep).join('/')
      if (excluded(rel)) continue
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) files.push({ path: rel, sha256: sha256(readFileSync(full)) })
    }
  }
  walk(dir)
  return { files, media: [...media], hash: manifestHash(files, media) }
}
