// Preview links (plan v2 §7): a short-lived capability for one ready version's bundle, minted for whoever can see
// the video. Private videos bind it to the access epoch, so a privacy or owner change revokes it like file links.
import type { Deps } from '../deps.js'
import { signPath } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { PREVIEW_TTL_SEC, previewScope } from '../lib/preview.js'
import { TarError } from '../lib/tar.js'
import { ensureBundle, liveIndexKey } from './bundles.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import { loadJob } from './videos.js'

/** The capability for a version's bundle: the same one covers its live snapshots. */
async function sign(deps: Deps, job: { private: boolean; accessEpoch: number }, jobId: string, n: number) {
  const { fileSigningSecret } = await getSettings(deps)
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + PREVIEW_TTL_SEC
  const epoch = job.private ? job.accessEpoch : undefined
  const sig = signPath(fileSigningSecret, previewScope(jobId, n), exp, epoch)
  return {
    base: `${deps.config.siteUrl}${previewScope(jobId, n)}/${exp}.${epoch ?? 'x'}.${sig}/`,
    expiresAt: new Date(exp * 1000).toISOString(),
  }
}

export async function previewLink(
  deps: Deps,
  p: Principal,
  jobId: string,
  n: number,
  opts: { live?: boolean } = {},
) {
  const job = await loadJob(deps.store, p, jobId)
  assertCan(p, 'video:read')
  const v = await deps.store.getVersion(jobId, n)
  if (!v) throw new ApiError('not_found', 'Version not found.')
  if (opts.live) {
    // The running version's latest checkpoint snapshot.
    const a = (await deps.store.listAttempts(jobId))
      .filter((x) => x.versionN === n)
      .sort((x, y) => y.queuedAt.localeCompare(x.queuedAt))[0]
    const c = a ? await deps.store.getCheckpoint(a.id) : null
    // The bundle key ends in /{seq}.tar.gz: the snapshot extracted from it is live/s{seq}/.
    const seq = Number(/\/(\d+)\.tar\.gz$/.exec(c?.bundleKey ?? '')?.[1] ?? NaN)
    if (!Number.isInteger(seq) || !(await deps.blobs.get('bundles', liveIndexKey(jobId, n, seq))))
      throw new ApiError('not_found', 'No live snapshot yet.')
    const { base, expiresAt } = await sign(deps, job, jobId, n)
    return { url: `${base}live/s${seq}/index.html`, expiresAt, seq }
  }
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
  // Finalize records whether the composition keeps the editing contract when it makes the bundle. When that step
  // failed, the bundle is made here later, and so is the record: otherwise the version could never be edited.
  if (v.contract == null && index.contract?.version === 1) {
    await deps.store.updateVersion(jobId, n, { contract: 1 })
    deps.log.info('preview.contract_recorded', { jobId, versionN: n })
  }
  const { base, expiresAt } = await sign(deps, job, jobId, n)
  return { url: `${base}index.html`, expiresAt, seq: null }
}
