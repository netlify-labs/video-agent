// Background function (15-minute limit): verify and store one attempt's files.
import type { Context } from '@netlify/functions'
import { prodDeps } from '../../app/server/adapters/prod.js'
import { finalizeAttempt } from '../../app/server/domain/finalize.js'
import { getSettings } from '../../app/server/domain/settings.js'
import { hmacHex, safeEqual } from '../../app/server/lib/crypto.js'

export default async (req: Request, context: Context) => {
  const deps = prodDeps()
  if (!context.deploy.published && process.env.ALLOW_NON_PRODUCTION !== 'true') return
  const { attemptId } = (await req.json().catch(() => ({}))) as { attemptId?: string }
  const sig = req.headers.get('x-finalize-signature') ?? ''
  if (!attemptId) return
  const { fileSigningSecret } = await getSettings(deps)
  if (!safeEqual(sig, hmacHex(fileSigningSecret, `finalize:${attemptId}`))) {
    deps.log.warn('finalize.bad_signature', { attemptId })
    return
  }
  try {
    const outcome = await finalizeAttempt(deps, attemptId)
    deps.log.info('finalize.result', { attemptId, outcome })
  } catch (e) {
    deps.log.error('finalize.failed', { attemptId, error: e })
  }
}
