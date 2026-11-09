// The composition's reference files (app/server/lib/bundle-references.ts: the narration bus), uploaded on their own to the
// uploads store under the attempt id, like render-job's outputs, because source.tar.gz and checkpoints leave them
// out. render-job lists what this returns in its manifest, and finalize copies each one to the version's prefix.
import { join } from 'node:path'
import {
  MAX_REFERENCE_BYTES,
  REFERENCE_FILES,
  type BundleReference,
} from '../../app/server/lib/bundle-references.js'
import { bundleManifest } from '../../app/server/lib/bundle-manifest.js'
import { StepError, log, netlifyCli, run, withRetries } from './run-tools.js'

type Upload = (key: string, file: string) => Promise<void>

const cliUpload: Upload = async (key, file) => {
  const [bin, ...pre] = netlifyCli() as [string, ...string[]]
  await withRetries(`upload ${key}`, 4, () =>
    run(bin, [...pre, 'blobs:set', 'uploads', key, '--input', file, '--force'], { timeoutMs: 5 * 60_000 }),
  )
}

/** Uploads every reference file in `videoDir` and returns their entries for the manifest. `upload` is for tests. */
export async function uploadReferences(
  attempt: string,
  videoDir: string,
  upload: Upload = cliUpload,
): Promise<Omit<BundleReference, 'key'>[]> {
  const refs = bundleManifest(videoDir).references
  for (const r of refs) {
    if (r.bytes > MAX_REFERENCE_BYTES)
      throw new StepError(`video/${r.path} is larger than ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`)
    await upload(`${attempt}/${REFERENCE_FILES[r.path]}`, join(videoDir, r.path))
  }
  if (refs.length) log('references.uploaded', { files: refs.map((r) => ({ path: r.path, bytes: r.bytes })) })
  return refs
}
