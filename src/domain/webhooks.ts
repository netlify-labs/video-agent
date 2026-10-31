// Webhook outbox (plan v2 §3, §14 rules 10–11). An event and one delivery row per destination are written in the
// same transaction as the change that caused them, and the sweep delivers them, so a crash can't lose an event.
// Destinations: the per-video webhookUrl from the API (signed with that key's secret), the video owner's personal
// webhook, and the admin-set team webhook. Every send re-checks that the recipient can still see the video.
import type { Deps } from '../deps.js'
import { decrypt, webhookSignature } from '../lib/crypto.js'
import type { Repo } from '../store/types.js'
import { getSettings } from './settings.js'
import type { JobRow, WebhookDeliveryRow, WebhookDestKind, WebhookEventType } from './types.js'
import { progressKey } from './progress.js'
import { canSee, videoDto } from './videos.js'

const DELIVER_FOR_MS = 24 * 3600_000
const MAX_BACKOFF_MS = 3600_000
const LEASE_MS = 60_000

type EmitDeps = Pick<Deps, 'ids' | 'clock' | 'config' | 'runner'>

/**
 * Records an event and its deliveries inside the caller's transaction. `data` adds event-specific fields
 * (a comment, a verdict) to the payload next to the video.
 */
export async function emitEvent(
  repo: Repo,
  deps: EmitDeps,
  e: {
    type: WebhookEventType
    jobId: string
    versionN?: number | null
    attemptId?: string | null
    data?: object
  },
) {
  const job = await repo.getJob(e.jobId)
  if (!job || job.deletedAt) return
  const dests: { kind: WebhookDestKind; ref: string; url: string }[] = []
  if ((e.type === 'video.ready' || e.type === 'video.failed') && e.versionN != null) {
    const v = await repo.getVersion(e.jobId, e.versionN)
    if (v?.webhookUrl && v.apiKeyId) dests.push({ kind: 'version_key', ref: v.apiKeyId, url: v.webhookUrl })
  }
  const personal = await repo.getUserWebhook(job.ownerId)
  if (personal) dests.push({ kind: 'personal', ref: job.ownerId, url: personal.url })
  const settings = await repo.getSettings()
  if (settings?.teamWebhookUrl) dests.push({ kind: 'team', ref: 'team', url: settings.teamWebhookUrl })
  if (dests.length === 0) return

  const now = deps.clock.now()
  const eventId = deps.ids.uuid()
  await repo.insertWebhookEvent({
    eventId,
    jobId: e.jobId,
    versionN: e.versionN ?? null,
    attemptId: e.attemptId ?? null,
    type: e.type,
    payload: {
      video: await videoDto(repo, deps, e.jobId, 'system'),
      ...(e.versionN != null ? { version: e.versionN } : {}),
      ...e.data,
    },
    createdAt: now.toISOString(),
  })
  for (const d of dests) {
    await repo.insertWebhookDelivery({
      id: deps.ids.uuid(),
      eventId,
      destKind: d.kind,
      destRef: d.ref,
      url: d.url,
      leaseUntil: null,
      nextRetryAt: now.toISOString(),
      deliverUntil: new Date(now.getTime() + DELIVER_FOR_MS).toISOString(),
      attempts: 0,
      lastResult: null,
      deliveredAt: null,
      droppedAt: null,
    })
  }
}

/** video.ready / video.failed for an attempt that just reached a terminal stage. */
/** Every path that ends an attempt calls this: the terminal webhook, plus cleanup of its progress cache. */
export async function emitTerminalEvent(repo: Repo, deps: EmitDeps, attemptId: string) {
  const a = await repo.getAttempt(attemptId)
  if (!a) return
  await repo.insertCleanup({
    id: deps.ids.uuid(),
    kind: 'delete_prefix',
    store: 'internal',
    prefix: progressKey(attemptId),
    nextActionAt: deps.clock.now().toISOString(),
    doneAt: null,
  })
  await emitEvent(repo, deps, {
    type: a.stage === 'ready' ? 'video.ready' : 'video.failed',
    jobId: a.jobId,
    versionN: a.versionN,
    attemptId,
  })
}

export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** attempt)
  return Math.round(base / 2 + random * (base / 2))
}

type Target = { ok: true; url: string; secret: string } | { ok: false; reason: string }

/** Who receives this delivery now, and with which secret; or why it's dropped (plan v2 §14 rule 11). */
async function resolveTarget(deps: Deps, d: WebhookDeliveryRow, job: JobRow | null): Promise<Target> {
  if (!job || job.deletedAt) return { ok: false, reason: 'video deleted' }
  const { dataEncryptionKey } = await getSettings(deps)
  const activeUser = async (id: string) => {
    const u = await deps.store.getUser(id)
    return u && !u.disabledAt ? u : null
  }
  if (d.destKind === 'version_key') {
    const key = await deps.store.getKey(d.destRef)
    if (!key || key.revokedAt) return { ok: false, reason: 'API key revoked' }
    const owner = await activeUser(key.ownerId)
    if (!owner) return { ok: false, reason: "key owner can't sign in" }
    if (!canSee({ role: owner.role, userId: owner.id }, job))
      return { ok: false, reason: 'recipient lost access' }
    return { ok: true, url: d.url, secret: decrypt(dataEncryptionKey, key.webhookSecretEnc) }
  }
  if (d.destKind === 'personal') {
    const hook = await deps.store.getUserWebhook(d.destRef)
    if (!hook) return { ok: false, reason: 'personal webhook removed' }
    if (!(await activeUser(d.destRef))) return { ok: false, reason: "owner can't sign in" }
    if (job.ownerId !== d.destRef) return { ok: false, reason: 'no longer the owner' }
    return { ok: true, url: hook.url, secret: decrypt(dataEncryptionKey, hook.secretEnc) }
  }
  // Team: admins can see every video, so private videos go there in full (owner decision).
  const s = await deps.store.getSettings()
  if (!s?.teamWebhookUrl || !s.teamWebhookSecretEnc) return { ok: false, reason: 'team webhook removed' }
  return { ok: true, url: s.teamWebhookUrl, secret: decrypt(dataEncryptionKey, s.teamWebhookSecretEnc) }
}

export async function deliverWebhooks(
  deps: Deps,
  budget: { deadline: number; maxItems: number },
): Promise<number> {
  const now = deps.clock.now()
  const due = await deps.store.claimDueWebhookDeliveries(
    now.toISOString(),
    new Date(now.getTime() + LEASE_MS).toISOString(),
    budget.maxItems,
  )
  let delivered = 0
  for (const d of due) {
    if (Date.now() > budget.deadline) break
    const event = await deps.store.getWebhookEvent(d.eventId)
    const job = event ? await deps.store.getJob(event.jobId) : null
    const target = event
      ? await resolveTarget(deps, d, job)
      : ({ ok: false, reason: 'event missing' } as const)
    if (!target.ok || !event) {
      const reason = target.ok ? 'event missing' : target.reason
      await deps.store.updateWebhookDelivery(d.id, {
        droppedAt: deps.clock.now().toISOString(),
        lastResult: `dropped: ${reason}`,
        leaseUntil: null,
        nextRetryAt: null,
      })
      deps.log.info('webhook.dropped', { deliveryId: d.id, eventId: d.eventId, dest: d.destKind, reason })
      continue
    }
    const t = Math.floor(deps.clock.now().getTime() / 1000)
    const body = JSON.stringify({
      eventId: event.eventId,
      event: event.type,
      createdAt: event.createdAt,
      ...(event.payload as object),
    })
    let result: string
    let ok = false
    try {
      const res = await deps.http.postJson(
        target.url,
        body,
        {
          'x-video-agent-signature': webhookSignature(target.secret, body, t),
          'x-video-agent-event': event.type,
          'x-video-agent-delivery': d.id,
        },
        10_000,
      )
      ok = res.status >= 200 && res.status < 300
      result = `HTTP ${res.status}`
    } catch (err) {
      result = err instanceof Error ? err.message.slice(0, 200) : 'error'
    }
    const attempts = d.attempts + 1
    const after = deps.clock.now()
    if (ok) {
      await deps.store.updateWebhookDelivery(d.id, {
        deliveredAt: after.toISOString(),
        attempts,
        lastResult: result,
        leaseUntil: null,
        nextRetryAt: null,
      })
      delivered++
      continue
    }
    const next = after.getTime() + backoffMs(attempts)
    const giveUp = next > new Date(d.deliverUntil).getTime()
    await deps.store.updateWebhookDelivery(d.id, {
      attempts,
      lastResult: giveUp ? `gave up: ${result}` : result,
      leaseUntil: null,
      nextRetryAt: giveUp ? null : new Date(next).toISOString(),
    })
    deps.log.warn('webhook.delivery_failed', { deliveryId: d.id, dest: d.destKind, attempts, result, giveUp })
  }
  return delivered
}
