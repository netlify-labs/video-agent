// Background function (15-minute limit): drives one destination publication (publish destinations §2.4).
import type { Context } from '@netlify/functions'
import { prodDeps } from '../../src/adapters/prod.js'
import { runPublication } from '../../src/domain/destinations/run.js'
import { getSettings } from '../../src/domain/settings.js'
import { hmacHex, safeEqual } from '../../src/lib/crypto.js'

export default async (req: Request, context: Context) => {
  const deps = prodDeps()
  if (!context.deploy.published && process.env.ALLOW_NON_PRODUCTION !== 'true') return
  const { publicationId } = (await req.json().catch(() => ({}))) as { publicationId?: string }
  const sig = req.headers.get('x-publish-signature') ?? ''
  if (!publicationId) return
  const { fileSigningSecret } = await getSettings(deps)
  if (!safeEqual(sig, hmacHex(fileSigningSecret, `publish:${publicationId}`))) {
    deps.log.warn('destination.bad_signature', { id: publicationId })
    return
  }
  try {
    const outcome = await runPublication(deps, publicationId)
    deps.log.info('destination.run', { id: publicationId, outcome })
  } catch (e) {
    deps.log.error('destination.run_failed', { id: publicationId, error: e })
  }
}
