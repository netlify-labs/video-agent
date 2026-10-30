// Webhook outbox: the event row is written in the same transaction as the terminal outcome, and the
// sweep delivers it, so a crash between the two can't lose an event.
import type { Deps } from '../deps.js'
import { decrypt, webhookSignature } from '../lib/crypto.js'
import type { Repo } from '../store/types.js'
import { getSettings } from './settings.js'
import { videoDto } from './videos.js'

const DELIVER_FOR_MS = 24 * 3600_000
const MAX_BACKOFF_MS = 3600_000

export async function emitTerminalEvent(repo: Repo, deps: Pick<Deps, 'ids' | 'clock' | 'config' | 'runner'>, attemptId: string) {
  const a = await repo.getAttempt(attemptId)
  if (!a) return
  const v = await repo.getVersion(a.jobId, a.versionN)
  if (!v?.webhookUrl || !v.apiKeyId) return
  const job = await repo.getJob(a.jobId)
  if (!job || job.deletedAt) return
  const now = deps.clock.now()
  const type = a.stage === 'ready' ? 'video.ready' : 'video.failed'
  await repo.insertWebhookEvent({
    eventId: deps.ids.uuid(),
    jobId: a.jobId,
    versionN: a.versionN,
    attemptId,
    type,
    payload: { video: await videoDto(repo, deps, a.jobId), version: a.versionN },
    apiKeyId: v.apiKeyId,
    url: v.webhookUrl,
    leaseUntil: null,
    nextRetryAt: now.toISOString(),
    deliverUntil: new Date(now.getTime() + DELIVER_FOR_MS).toISOString(),
    attempts: 0,
    lastResult: null,
    deliveredAt: null,
  })
}

export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** attempt)
  return Math.round(base / 2 + random * (base / 2))
}

export async function deliverWebhooks(deps: Deps, budget: { deadline: number; maxItems: number }): Promise<number> {
  const now = deps.clock.now()
  const due = await deps.store.listDueWebhookEvents(now.toISOString(), budget.maxItems)
  const { dataEncryptionKey } = await getSettings(deps)
  let delivered = 0
  for (const e of due) {
    if (Date.now() > budget.deadline) break
    await deps.store.updateWebhookEvent(e.eventId, { leaseUntil: new Date(now.getTime() + 60_000).toISOString() })
    const key = await deps.store.getKey(e.apiKeyId)
    const t = Math.floor(deps.clock.now().getTime() / 1000)
    const body = JSON.stringify({ eventId: e.eventId, event: e.type, createdAt: new Date(t * 1000).toISOString(), ...(e.payload as object) })
    let result: string
    let ok = false
    try {
      if (!key) throw new Error('signing key missing')
      const secret = decrypt(dataEncryptionKey, key.webhookSecretEnc)
      const res = await deps.http.postJson(e.url, body, { 'x-video-agent-signature': webhookSignature(secret, body, t), 'x-video-agent-event': e.type }, 10_000)
      ok = res.status >= 200 && res.status < 300
      result = `HTTP ${res.status}`
    } catch (err) {
      result = err instanceof Error ? err.message.slice(0, 200) : 'error'
    }
    const attempts = e.attempts + 1
    const after = deps.clock.now()
    if (ok) {
      await deps.store.updateWebhookEvent(e.eventId, { deliveredAt: after.toISOString(), attempts, lastResult: result, leaseUntil: null, nextRetryAt: null })
      delivered++
      continue
    }
    const next = after.getTime() + backoffMs(attempts)
    const giveUp = next > new Date(e.deliverUntil).getTime()
    await deps.store.updateWebhookEvent(e.eventId, {
      attempts,
      lastResult: giveUp ? `gave up: ${result}` : result,
      leaseUntil: null,
      nextRetryAt: giveUp ? null : new Date(next).toISOString(),
    })
    deps.log.warn('webhook.delivery_failed', { eventId: e.eventId, attempts, result, giveUp })
  }
  return delivered
}
