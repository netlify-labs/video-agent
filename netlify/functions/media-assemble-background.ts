// Background function (15-minute limit): assemble and verify one finished media upload session (plan v2 §14 rule 24).
import type { Context } from '@netlify/functions'
import { prodDeps } from '../../app/server/adapters/prod.js'
import { assembleUpload } from '../../app/server/domain/media-uploads.js'
import { getSettings } from '../../app/server/domain/settings.js'
import { hmacHex, safeEqual } from '../../app/server/lib/crypto.js'

export default async (req: Request, context: Context) => {
  const deps = prodDeps()
  if (!context.deploy.published && process.env.ALLOW_NON_PRODUCTION !== 'true') return
  const { uploadId } = (await req.json().catch(() => ({}))) as { uploadId?: string }
  const sig = req.headers.get('x-assemble-signature') ?? ''
  if (!uploadId) return
  const { fileSigningSecret } = await getSettings(deps)
  if (!safeEqual(sig, hmacHex(fileSigningSecret, `assemble:${uploadId}`))) {
    deps.log.warn('media.assembly_bad_signature', { uploadId })
    return
  }
  const started = Date.now()
  try {
    const outcome = await assembleUpload(deps, uploadId)
    deps.log.info('media.assembly_result', {
      uploadId,
      outcome,
      ms: Date.now() - started,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    })
  } catch (e) {
    deps.log.error('media.assembly_failed', { uploadId, error: e })
  }
}
