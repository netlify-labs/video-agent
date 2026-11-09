import type { Deps } from '../deps.js'
import { encrypt, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { API_KEY_PREFIX } from './auth.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import type { ApiKeyRow } from './types.js'

export const keyDto = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  revokedAt: k.revokedAt,
})

export async function createKey(deps: Deps, p: Principal, name: string) {
  assertCan(p, 'keys:manage')
  if (p.kind !== 'user')
    throw new ApiError('forbidden', 'API keys can only be created from a signed-in session.')
  return createKeyForUser(deps, p.userId, name)
}

/**
 * Makes a key for this person, returning it and its webhook secret once. The caller decides who may: a signed-in
 * session (createKey), or a CLI login the person approved, claimed after the key-owner checks (cli-login.ts).
 */
export async function createKeyForUser(deps: Deps, userId: string, name: string) {
  const id = deps.ids.keyId()
  const secret = Buffer.from(deps.ids.secret(24), 'base64url').toString('hex')
  const webhookSecret = `whsec_${deps.ids.secret(24)}`
  const { dataEncryptionKey } = await getSettings(deps)
  const row: ApiKeyRow = {
    id,
    ownerId: userId,
    name: name.trim(),
    secretHash: sha256Hex(secret),
    webhookSecretEnc: encrypt(dataEncryptionKey, webhookSecret),
    createdAt: deps.clock.now().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  }
  await deps.store.insertKey(row)
  return { ...keyDto(row), key: `${API_KEY_PREFIX}${id}_${secret}`, webhookSecret }
}

export async function listKeys(deps: Deps, p: Principal) {
  assertCan(p, 'keys:manage')
  return (await deps.store.listKeys(p.userId)).map(keyDto)
}

export async function revokeKey(deps: Deps, p: Principal, keyId: string) {
  const key = await deps.store.getKey(keyId)
  if (!key || (key.ownerId !== p.userId && p.role !== 'admin'))
    throw new ApiError('not_found', 'API key not found.')
  if (!key.revokedAt) await deps.store.updateKey(keyId, { revokedAt: deps.clock.now().toISOString() })
}
