// Web sessions for Sign in with Netlify: an opaque random token in an httpOnly cookie, stored as its SHA-256.
// Sessions slide (30 days from last use), rotate daily, end on sign-out or when an admin disables the person, and
// re-check the Netlify team rule at most once a day.
import type { Deps } from '../deps.js'
import type { Principal } from '../domain/policy.js'
import type { SessionRow, UserRow } from '../domain/types.js'
import { emailDomain } from '../domain/auth.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { freshMembership, recheckMembership } from './membership.js'

export const SESSION_COOKIE = 'va_session'
export const SESSION_TTL_MS = 30 * 86400_000
const ROTATE_MS = 24 * 3600_000
const TOUCH_MS = 3600_000
/** A rotated-out token keeps working this long, for requests already in flight. */
const ROTATE_GRACE_MS = 60_000
const TOKEN = /^nvs_[A-Za-z0-9_-]{20,100}$/

const iso = (ms: number) => new Date(ms).toISOString()

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null
  }
  return null
}

/** A Set-Cookie value: httpOnly, Secure and SameSite=Lax; maxAge 0 clears it. */
export function cookie(name: string, value: string, maxAgeSec: number, path = '/') {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`
}

export const sessionCookie = (token: string) => cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000)
export const clearSessionCookie = () => cookie(SESSION_COOKIE, '', 0)

/** Starts a session for a person who just signed in with Netlify; returns the cookie token. */
export async function createSession(deps: Deps, userId: string, accessToken: string | undefined) {
  const token = `nvs_${deps.ids.secret(32)}`
  const now = deps.clock.now().getTime()
  await deps.store.insertSession({
    id: sha256Hex(token),
    userId,
    provider: 'netlify',
    createdAt: iso(now),
    lastSeenAt: iso(now),
    expiresAt: iso(now + SESSION_TTL_MS),
    rotatedAt: iso(now),
    ...(await freshMembership(deps, accessToken)),
    membershipFailedAt: null,
    revokedAt: null,
  })
  deps.log.info('auth.session_created', { userId })
  return token
}

const ended = (message = 'Your session has ended. Sign in again.') => new ApiError('unauthorized', message)

/** The live session behind the request's cookie, with its user; ends it (and throws) when it no longer holds. */
export async function liveSession(deps: Deps, req: Request): Promise<{ session: SessionRow; user: UserRow }> {
  const token = readCookie(req, SESSION_COOKIE)
  if (!token) throw new ApiError('unauthorized', 'Sign in first.')
  if (!TOKEN.test(token)) throw ended()
  const session = await deps.store.getSession(sha256Hex(token))
  const now = deps.clock.now().toISOString()
  if (!session || session.revokedAt || session.expiresAt <= now) throw ended()
  const end = async (why: string, message: string) => {
    await deps.store.updateSession(session.id, { revokedAt: now })
    deps.log.info('auth.session_ended', { userId: session.userId, why })
    return ended(message)
  }
  const user = await deps.store.getUser(session.userId)
  if (!user) throw await end('no_user', 'Your account no longer exists.')
  if (user.disabledAt) throw await end('disabled', 'Your account has been disabled by an admin.')
  const mode = deps.config.allowedEmailDomains
  if (user.admittedVia === 'domain' && Array.isArray(mode) && !mode.includes(emailDomain(user.email)))
    throw await end('domain', 'Your email address is no longer in an allowed domain.')
  const check = await recheckMembership(deps, session)
  if (!check.ok) {
    // Someone who left the team loses every session and connected app, not just this one.
    if (check.why === 'not_member') {
      await deps.store.revokeUserSessions(user.id, now)
      await deps.store.revokeOAuthGrants(user.id, now)
    }
    throw await end(`team_${check.why}`, check.reason)
  }
  if (check.patch) {
    await deps.store.updateSession(session.id, check.patch)
    Object.assign(session, check.patch)
  }
  return { session, user }
}

/**
 * The person behind the session cookie. `setCookie` receives a new cookie when the token is rotated (daily); the
 * old token keeps working for a minute so requests already in flight don't fail.
 */
export async function principalFromSession(
  deps: Deps,
  req: Request,
  setCookie?: (value: string) => void,
): Promise<Principal> {
  const { session, user } = await liveSession(deps, req)
  const now = deps.clock.now().getTime()
  if (setCookie && now - Date.parse(session.rotatedAt) >= ROTATE_MS) {
    const token = `nvs_${deps.ids.secret(32)}`
    await deps.store.insertSession({
      ...session,
      id: sha256Hex(token),
      lastSeenAt: iso(now),
      expiresAt: iso(now + SESSION_TTL_MS),
      rotatedAt: iso(now),
    })
    await deps.store.updateSession(session.id, {
      rotatedAt: iso(now),
      lastSeenAt: iso(now),
      expiresAt: iso(Math.min(Date.parse(session.expiresAt), now + ROTATE_GRACE_MS)),
    })
    setCookie(sessionCookie(token))
  } else if (now - Date.parse(session.lastSeenAt) >= TOUCH_MS) {
    await deps.store.updateSession(session.id, { lastSeenAt: iso(now), expiresAt: iso(now + SESSION_TTL_MS) })
  }
  if (now - Date.parse(user.lastSeenAt) >= TOUCH_MS)
    await deps.store.updateUser(user.id, { lastSeenAt: iso(now) })
  return {
    kind: 'user',
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    apiKeyId: null,
  }
}

/** Sign-out: ends the request's session, if it has one. */
export async function endSession(deps: Deps, req: Request) {
  const token = readCookie(req, SESSION_COOKIE)
  if (!token || !TOKEN.test(token)) return
  const session = await deps.store.getSession(sha256Hex(token))
  if (!session || session.revokedAt) return
  await deps.store.updateSession(session.id, { revokedAt: deps.clock.now().toISOString() })
  deps.log.info('auth.signed_out', { userId: session.userId })
}
