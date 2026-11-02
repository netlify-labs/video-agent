// Background function (15-minute limit): run one Openverse search or import job, waiting out a slow Openverse, then
// wake the run whose music pick waits on it.
import type { Context } from '@netlify/functions'
import { prodDeps } from '../../src/adapters/prod.js'
import { runOpenverseJob } from '../../src/domain/openverse-jobs.js'
import { wakeMusicPick } from '../../src/domain/reconciler.js'
import { getSettings } from '../../src/domain/settings.js'
import { hmacHex, safeEqual } from '../../src/lib/crypto.js'

export default async (req: Request, context: Context) => {
  const deps = prodDeps()
  if (!context.deploy.published && process.env.ALLOW_NON_PRODUCTION !== 'true') return
  const { jobId } = (await req.json().catch(() => ({}))) as { jobId?: string }
  const sig = req.headers.get('x-openverse-signature') ?? ''
  if (!jobId) return
  const { fileSigningSecret } = await getSettings(deps)
  if (!safeEqual(sig, hmacHex(fileSigningSecret, `openverse:${jobId}`))) {
    deps.log.warn('openverse.job_bad_signature', { jobId })
    return
  }
  try {
    const outcome = await runOpenverseJob(deps, jobId)
    deps.log.info('openverse.job_result', { jobId, outcome })
    // A run waiting for this search or import moves on now rather than at the next sweep.
    if (outcome !== 'skipped') await wakeMusicPick(deps, jobId)
  } catch (e) {
    deps.log.error('openverse.job_crashed', { jobId, error: e })
  }
}
