// The canonical file manifest of a composition (plan v2 §14 rule 21). One hash covers every composition file and
// summary.json, plus the digests of the library media the version references. Library media bytes (downloaded by each
// run), check caches and anything else generated stay out, so the hash only changes when what gets rendered changes.
// Files the agent made itself (assets/media/poster.png, a clip it rendered) are part of the composition and stay in.
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

/** A library item hydrated into the composition: always named assets/media/<media id>.<ext>. */
export const isLibraryMedia = (path: string) => /^assets\/media\/med_[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(path)

/** Paths (relative to video/, with forward slashes) that never count, and never go in source.tar.gz (render-job and
 * checkpoint archive exactly the files this keeps), so a restored archive hashes the same. */
export function excluded(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules' || p === 'renders')) return true
  // A stray render output at the top of video/; clips the composition uses live in a folder.
  if (!path.includes('/') && path.endsWith('.mp4')) return true
  // Feedback stills are run inputs, not part of the composition.
  if (path === 'feedback' || path.startsWith('feedback/')) return true
  return isLibraryMedia(path)
}

/** The composition's files under `dir` (relative, forward slashes, sorted), without the excluded ones. */
export function compositionFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = relative(dir, full).split(sep).join('/')
      if (excluded(rel)) continue
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.push(rel)
    }
  }
  walk(dir)
  return out
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
  const files = compositionFiles(dir).map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }))
  return { files, media: [...media], hash: manifestHash(files, media) }
}
