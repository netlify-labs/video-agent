// Background function (15-minute limit): write one plan's questions or brief (app/server/domain/plans.ts). The model
// calls can take longer than a request should wait, so the API records the work on the plan, dispatches this and
// answers; the caller polls the plan.
import type { Context } from '@netlify/functions'
import { prodDeps } from '../../app/server/adapters/prod.js'
import { runPlanWork } from '../../app/server/domain/plans.js'
import { getSettings } from '../../app/server/domain/settings.js'
import { hmacHex, safeEqual } from '../../app/server/lib/crypto.js'

export default async (req: Request, context: Context) => {
  const deps = prodDeps()
  if (!context.deploy.published && process.env.ALLOW_NON_PRODUCTION !== 'true') return
  const { planId } = (await req.json().catch(() => ({}))) as { planId?: string }
  const sig = req.headers.get('x-plan-signature') ?? ''
  if (!planId) return
  const { fileSigningSecret } = await getSettings(deps)
  if (!safeEqual(sig, hmacHex(fileSigningSecret, `plan:${planId}`))) {
    deps.log.warn('plan.work_bad_signature', { planId })
    return
  }
  const started = Date.now()
  try {
    const outcome = await runPlanWork(deps, planId)
    deps.log.info('plan.work_result', { planId, outcome, ms: Date.now() - started })
  } catch (e) {
    deps.log.error('plan.work_crashed', { planId, error: e })
  }
}
