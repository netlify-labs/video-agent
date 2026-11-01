// Backfilling preview variants for versions rendered before they existed (scripts/backfill-previews.ts). Admins only,
// and write-once: a variant (or the placeholder) a version already has is never replaced, and the required outputs
// (video, poster, GIF, captions, source) are out of reach. Each variant gets the same checks finalize applies.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import {
  isLqip,
  isPreviewFile,
  MAX_PREVIEW_BYTES,
  PREVIEW_FILES,
  sniffPreview,
  type Previews,
} from '../lib/media/previews.js'
import type { Principal } from './policy.js'
import { loadJob } from './videos.js'

export async function addPreview(
  deps: Deps,
  p: Principal,
  jobId: string,
  n: number,
  name: string,
  body: Uint8Array,
) {
  if (p.role !== 'admin') throw new ApiError('forbidden', 'Only admins can add preview variants.')
  await loadJob(deps.store, p, jobId)
  const version = await deps.store.getVersion(jobId, n)
  const output = await deps.store.getOutput(jobId, n)
  if (version?.status !== 'ready' || !output)
    throw new ApiError('not_found', 'There is no ready version to add previews to.')
  const previews: Previews = output.previews ?? { files: {}, lqip: null }

  if (name === 'lqip') {
    const lqip = new TextDecoder().decode(body).trim()
    if (!isLqip(lqip))
      throw new ApiError('invalid_request', 'The placeholder must be a small base64 WebP or JPEG data URI.')
    if (previews.lqip) throw new ApiError('conflict', 'This version already has a placeholder.')
    await deps.store.upsertOutput({ ...output, previews: { ...previews, lqip } })
    deps.log.info('previews.added', { jobId, n, file: 'lqip' })
    return { name, bytes: lqip.length }
  }

  if (!isPreviewFile(name)) throw new ApiError('invalid_request', `${name} isn't a preview variant.`)
  if (previews.files[name]) throw new ApiError('conflict', `This version already has ${name}.`)
  if (body.byteLength === 0 || body.byteLength > MAX_PREVIEW_BYTES || !sniffPreview(name, body))
    throw new ApiError('invalid_request', `${name} is empty, too large or not the right format.`)
  await deps.blobs.set('videos', `${jobId}/v${n}/${name}`, body, {
    contentType: PREVIEW_FILES[name],
    size: String(body.byteLength),
  })
  await deps.store.upsertOutput({
    ...output,
    sha256: { ...output.sha256, [name]: sha256Hex(body) },
    previews: { ...previews, files: { ...previews.files, [name]: { bytes: body.byteLength } } },
  })
  deps.log.info('previews.added', { jobId, n, file: name, bytes: body.byteLength })
  return { name, bytes: body.byteLength }
}
