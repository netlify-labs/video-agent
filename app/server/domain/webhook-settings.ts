// Personal and team webhook destinations (plan v2 §3). The signing secret is shown once, when the webhook is
// created or rotated; deliveries are signed with it (X-Video-Agent-Signature, as for API-key webhooks).
import type { Deps } from '../deps.js'
import { decrypt, encrypt, webhookSignature } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'

function checkUrl(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ApiError('invalid_request', 'Enter a full https:// URL.')
  }
  if (u.protocol !== 'https:') throw new ApiError('invalid_request', 'Webhook URLs must use https.')
}

const newSecret = (deps: Pick<Deps, 'ids'>) => `whsec_${deps.ids.secret(24)}`

export async function getMyWebhook(deps: Deps, p: Principal) {
  assertCan(p, 'keys:manage')
  const w = await deps.store.getUserWebhook(p.userId)
  return w ? { url: w.url, createdAt: w.createdAt, updatedAt: w.updatedAt } : null
}

/** Creates or changes your webhook. A new secret is issued on create, or when `rotate` is set. */
export async function putMyWebhook(
  deps: Deps,
  p: Principal,
  input: { url: string; rotate?: boolean | undefined },
) {
  assertCan(p, 'keys:manage')
  checkUrl(input.url)
  const { dataEncryptionKey } = await getSettings(deps)
  const now = deps.clock.now().toISOString()
  const existing = await deps.store.getUserWebhook(p.userId)
  const secret = !existing || input.rotate ? newSecret(deps) : null
  await deps.store.putUserWebhook({
    userId: p.userId,
    url: input.url,
    secretEnc: secret ? encrypt(dataEncryptionKey, secret) : (existing?.secretEnc ?? ''),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  return { url: input.url, createdAt: existing?.createdAt ?? now, updatedAt: now, secret }
}

export async function deleteMyWebhook(deps: Deps, p: Principal) {
  assertCan(p, 'keys:manage')
  await deps.store.deleteUserWebhook(p.userId)
}

export async function getTeamWebhook(deps: Deps, p: Principal) {
  assertCan(p, 'settings:manage')
  const s = await deps.store.getSettings()
  return s?.teamWebhookUrl ? { url: s.teamWebhookUrl } : null
}

export async function putTeamWebhook(
  deps: Deps,
  p: Principal,
  input: { url: string; rotate?: boolean | undefined },
) {
  assertCan(p, 'settings:manage')
  checkUrl(input.url)
  const { dataEncryptionKey } = await getSettings(deps)
  const s = await deps.store.getSettings()
  const secret = !s?.teamWebhookSecretEnc || input.rotate ? newSecret(deps) : null
  await deps.store.updateSettings({
    teamWebhookUrl: input.url,
    ...(secret ? { teamWebhookSecretEnc: encrypt(dataEncryptionKey, secret) } : {}),
  })
  return { url: input.url, secret }
}

export async function deleteTeamWebhook(deps: Deps, p: Principal) {
  assertCan(p, 'settings:manage')
  await deps.store.updateSettings({ teamWebhookUrl: null, teamWebhookSecretEnc: null })
}

/** Sends a signed `webhook.test` event right away and reports what the endpoint answered. */
export async function testWebhook(deps: Deps, p: Principal, which: 'personal' | 'team') {
  const { dataEncryptionKey } = await getSettings(deps)
  let url: string
  let secret: string
  if (which === 'personal') {
    assertCan(p, 'keys:manage')
    const w = await deps.store.getUserWebhook(p.userId)
    if (!w) throw new ApiError('not_found', 'Set a webhook first.')
    url = w.url
    secret = decrypt(dataEncryptionKey, w.secretEnc)
  } else {
    assertCan(p, 'settings:manage')
    const s = await deps.store.getSettings()
    if (!s?.teamWebhookUrl || !s.teamWebhookSecretEnc)
      throw new ApiError('not_found', 'Set a team webhook first.')
    url = s.teamWebhookUrl
    secret = decrypt(dataEncryptionKey, s.teamWebhookSecretEnc)
  }
  const t = Math.floor(deps.clock.now().getTime() / 1000)
  const body = JSON.stringify({
    eventId: deps.ids.uuid(),
    event: 'webhook.test',
    createdAt: deps.clock.now().toISOString(),
  })
  try {
    const res = await deps.http.postJson(
      url,
      body,
      { 'x-video-agent-signature': webhookSignature(secret, body, t), 'x-video-agent-event': 'webhook.test' },
      10_000,
    )
    return { ok: res.status >= 200 && res.status < 300, result: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, result: e instanceof Error ? e.message.slice(0, 200) : 'error' }
  }
}
