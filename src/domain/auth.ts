// Turning a request into a Principal: Identity cookie sessions or API keys, with fail-closed
// admission and a live account check (getUser() can fall back to token claims during an outage).
import type { Deps, IdentityUser } from '../deps.js'
import { safeEqual, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import type { Principal } from './policy.js'
import type { UserRow } from './types.js'

const LIVE_TTL_MS = 5 * 60_000
const liveCache = new Map<string, { user: IdentityUser | null; at: number }>()

export function resetAuthCache() {
  liveCache.clear()
}

async function liveUser(deps: Deps, id: string): Promise<IdentityUser | null> {
  const now = deps.clock.now().getTime()
  const hit = liveCache.get(id)
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.user
  let user: IdentityUser | null
  try {
    user = await deps.identity.liveUser(id)
  } catch (e) {
    deps.log.warn('identity.live_lookup_failed', { userId: id, error: e })
    throw new ApiError('upstream_error', 'Could not verify your account right now. Try again shortly.')
  }
  liveCache.set(id, { user, at: now })
  return user
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@').pop() ?? ''
}

/** Admission rules for a confirmed Identity account under the configured mode. */
export function admits(
  config: Deps['config'],
  user: IdentityUser,
): { ok: true; via: 'domain' | 'invite' } | { ok: false; reason: string } {
  if (!user.confirmed) return { ok: false, reason: 'Confirm your email address first.' }
  const mode = config.allowedEmailDomains
  if (mode === null) return { ok: false, reason: 'This deployment has no admission rule configured yet.' }
  if (mode === 'invite-only') {
    return user.invited
      ? { ok: true, via: 'invite' }
      : { ok: false, reason: 'This deployment is invite-only.' }
  }
  return mode.includes(emailDomain(user.email))
    ? { ok: true, via: 'domain' }
    : { ok: false, reason: `Sign-ups are limited to ${mode.join(', ')} addresses.` }
}

async function ensureUserRow(deps: Deps, user: IdentityUser): Promise<UserRow> {
  const existing = await deps.store.getUser(user.id)
  const now = deps.clock.now().toISOString()
  if (existing) {
    if (existing.disabledAt) throw new ApiError('forbidden', 'Your account has been disabled by an admin.')
    const mode = deps.config.allowedEmailDomains
    if (existing.admittedVia === 'domain' && Array.isArray(mode) && !mode.includes(emailDomain(user.email))) {
      throw new ApiError('forbidden', 'Your email address is no longer in an allowed domain.')
    }
    if (
      existing.email !== user.email.toLowerCase() ||
      now.slice(0, 13) !== existing.lastSeenAt.slice(0, 13)
    ) {
      await deps.store.updateUser(user.id, { email: user.email.toLowerCase(), lastSeenAt: now })
    }
    return { ...existing, email: user.email.toLowerCase() }
  }
  const verdict = admits(deps.config, user)
  if (!verdict.ok) throw new ApiError('forbidden', verdict.reason)
  const isAdmin = deps.config.adminEmails.includes(user.email.toLowerCase())
  return deps.store.insertUserIfAbsent({
    id: user.id,
    email: user.email.toLowerCase(),
    name: user.name,
    role: isAdmin ? 'admin' : 'member',
    admittedVia: verdict.via,
    createdAt: now,
    lastSeenAt: now,
    disabledAt: null,
  })
}

export const API_KEY_PREFIX = 'nva_'

export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw.startsWith(API_KEY_PREFIX)) return null
  const rest = raw.slice(API_KEY_PREFIX.length)
  const i = rest.lastIndexOf('_')
  if (i <= 0) return null
  return { keyId: rest.slice(0, i), secret: rest.slice(i + 1) }
}

export async function principalFromRequest(deps: Deps, req: Request): Promise<Principal> {
  const auth = req.headers.get('authorization')
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth)
    const parsed = m?.[1] ? parseApiKey(m[1]) : null
    if (!parsed) throw new ApiError('unauthorized', 'Invalid API key.')
    const key = await deps.store.getKey(parsed.keyId)
    if (!key || key.revokedAt || !safeEqual(key.secretHash, sha256Hex(parsed.secret))) {
      throw new ApiError('unauthorized', 'Invalid API key.')
    }
    const live = await liveUser(deps, key.ownerId)
    if (!live?.confirmed) throw new ApiError('unauthorized', "This key's owner no longer has an account.")
    const row = await ensureUserRow(deps, live)
    const now = deps.clock.now().toISOString()
    if (!key.lastUsedAt || now.slice(0, 15) !== key.lastUsedAt.slice(0, 15))
      await deps.store.updateKey(key.id, { lastUsedAt: now })
    return {
      kind: 'apiKey',
      userId: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      apiKeyId: key.id,
    }
  }

  const session = await deps.identity.sessionUser(req)
  if (!session) throw new ApiError('unauthorized', 'Sign in first.')
  const live = await liveUser(deps, session.id)
  if (!live) throw new ApiError('unauthorized', 'Your account no longer exists.')
  if (!live.confirmed) throw new ApiError('unauthorized', 'Confirm your email address first.')
  const row = await ensureUserRow(deps, live)
  return { kind: 'user', userId: row.id, email: row.email, name: row.name, role: row.role, apiKeyId: null }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** CSRF protection for cookie sessions: state-changing requests must come from our own origin. */
export function assertSameOrigin(req: Request, principal: Principal) {
  if (principal.kind !== 'user' || SAFE_METHODS.has(req.method)) return
  const origin = req.headers.get('origin')
  if (!origin || origin !== new URL(req.url).origin)
    throw new ApiError('forbidden', 'Cross-site request refused.')
}
