// Preview links (plan v2 §7): a short-lived capability for one ready version's bundle, minted for whoever can see
// the video. Private videos bind it to the access epoch, so a privacy or owner change revokes it like file links.
import type { Deps } from '../deps.js'
import { signPath } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { PREVIEW_TTL_SEC, previewScope } from '../lib/preview.js'
import { TarError } from '../lib/tar.js'
import { ensureBundle } from './bundles.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import { loadJob } from './videos.js'

export async function previewLink(deps: Deps, p: Principal, jobId: string, n: number) {
  const job = await loadJob(deps.store, p, jobId)
  assertCan(p, 'video:read')
  const v = await deps.store.getVersion(jobId, n)
  if (!v) throw new ApiError('not_found', 'Version not found.')
  if (v.status !== 'ready') throw new ApiError('conflict', 'Only ready versions can be previewed.')
  let index
  try {
    index = await ensureBundle(deps, jobId, n)
  } catch (e) {
    if (!(e instanceof TarError)) throw e
    deps.log.warn('preview.bundle_invalid', { jobId, versionN: n, error: e })
    throw new ApiError('conflict', "This version's composition can't be previewed.")
  }
  if (!index?.files.some((f) => f.path === 'index.html'))
    throw new ApiError('not_found', 'This version has no composition to preview.')
  const { fileSigningSecret } = await getSettings(deps)
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + PREVIEW_TTL_SEC
  const epoch = job.private ? job.accessEpoch : undefined
  const sig = signPath(fileSigningSecret, previewScope(jobId, n), exp, epoch)
  return {
    url: `${deps.config.siteUrl}${previewScope(jobId, n)}/${exp}.${epoch ?? 'x'}.${sig}/index.html`,
    expiresAt: new Date(exp * 1000).toISOString(),
  }
}
