// Keeps the Netlify Identity session alive. The API reads the nf_jwt cookie, but the access token in it lasts
// an hour, and the Identity SDK keeps its newest session in localStorage. Without this module a tab that
// outlives the token looks signed in while every request fails with "Sign in first."
//
// - The cookie is kept in step with the SDK's newest token before every request.
// - Tokens are refreshed shortly before they expire, and once more after a 401.
// - One tab (the leader, chosen with a Web Lock) refreshes; others ask it over a BroadcastChannel, because a
//   refresh token works only once and two tabs refreshing at the same moment would sign each other out.
// - The session is dropped only when Identity itself rejects the token, never on a network error.
// Adapted from revenue-engine's clients/frontend/src/auth/session.ts.
import {
  getUser,
  handleAuthCallback,
  refreshSession,
  type CallbackResult,
  type User,
} from '@netlify/identity'

const ACCESS_TOKEN_COOKIE = 'nf_jwt'
const REFRESH_TOKEN_COOKIE = 'nf_refresh'
const SDK_SESSION_KEY = 'gotrue.user'
const LEADER_LOCK = 'video-agent:identity-refresh-leader:v1'
const CHANNEL = 'video-agent:identity-refresh:v1'
const REFRESH_MARGIN_SEC = 60
const LEADER_TIMEOUT_MS = 5_000

type ChannelMessage =
  | { type: 'refresh-request'; requestId: string }
  | { type: 'refresh-complete'; requestId: string; authenticated: boolean }

let leader = false
let releaseLeadership: (() => void) | null = null
let leadershipAttempt: Promise<boolean> | null = null
let localRefresh: Promise<string | null> | null = null
let recovery: Promise<string | null> | null = null
let channel: BroadcastChannel | null = null
const pending = new Map<string, (authenticated: boolean) => void>()
const lostListeners = new Set<() => void>()

function readCookie(name: string): string | null {
  const match = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(document.cookie)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function setCookie(name: string, value: string) {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' ? '; secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; samesite=lax${secure}`
}

function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const b64 = part
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=')
    return JSON.parse(atob(b64)) as Record<string, unknown>
  } catch {
    return null
  }
}

function expiresWithin(token: string, seconds: number): boolean {
  const exp = jwtClaims(token)?.exp
  return typeof exp !== 'number' || exp - Math.floor(Date.now() / 1000) <= seconds
}

const fresh = (token: string | null) => (token && !expiresWithin(token, 0) ? token : null)

/** The newest access token, after copying the SDK's session into the cookies when it's newer. */
export function sessionToken(): string | null {
  const cookie = readCookie(ACCESS_TOKEN_COOKIE)
  try {
    const raw = localStorage.getItem(SDK_SESSION_KEY)
    if (!raw) return cookie
    const stored = (JSON.parse(raw) as { token?: { access_token?: unknown; refresh_token?: unknown } }).token
    const access = typeof stored?.access_token === 'string' ? stored.access_token : null
    if (!access) return cookie
    const storedExp = jwtClaims(access)?.exp
    const cookieExp = cookie ? jwtClaims(cookie)?.exp : undefined
    const storedIsNewer =
      !cookie || (typeof storedExp === 'number' && (typeof cookieExp !== 'number' || storedExp >= cookieExp))
    if (!storedIsNewer) return cookie
    if (access !== cookie) setCookie(ACCESS_TOKEN_COOKIE, access)
    const refresh = typeof stored?.refresh_token === 'string' ? stored.refresh_token : null
    if (refresh && refresh !== readCookie(REFRESH_TOKEN_COOKIE)) setCookie(REFRESH_TOKEN_COOKIE, refresh)
    return access
  } catch {
    return cookie
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL)
  channel.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
    const m = event.data
    if (m.type === 'refresh-request' && leader) {
      void refreshHere().then((token) => {
        channel?.postMessage({
          type: 'refresh-complete',
          requestId: m.requestId,
          authenticated: Boolean(token),
        } satisfies ChannelMessage)
      })
    } else if (m.type === 'refresh-complete') {
      pending.get(m.requestId)?.(m.authenticated)
    }
  })
  return channel
}

/** Becomes the refreshing tab if no other tab is. Without Web Locks every tab refreshes for itself. */
function ensureLeadership(): Promise<boolean> {
  if (leader) return Promise.resolve(true)
  if (leadershipAttempt) return leadershipAttempt
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    leader = true
    return Promise.resolve(true)
  }
  leadershipAttempt = new Promise<boolean>((resolve) => {
    navigator.locks
      .request(LEADER_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        leader = true
        ensureChannel()
        resolve(true)
        await new Promise<void>((release) => {
          releaseLeadership = release
        })
        releaseLeadership = null
        leader = false
      })
      .catch(() => {
        resolve(false)
      })
  }).finally(() => {
    leadershipAttempt = null
  })
  return leadershipAttempt
}

function relinquishLeadership() {
  releaseLeadership?.()
  releaseLeadership = null
  leader = false
}

function refreshHere(): Promise<string | null> {
  localRefresh ??= (async () => {
    await refreshSession()
    return fresh(sessionToken())
  })().finally(() => {
    localRefresh = null
  })
  return localRefresh
}

async function refreshViaLeader(): Promise<string | null> {
  if (leader) return refreshHere()
  const ch = ensureChannel()
  if (ch) {
    const requestId = crypto.randomUUID()
    const done = new Promise<boolean>((resolve) => pending.set(requestId, resolve))
    ch.postMessage({ type: 'refresh-request', requestId } satisfies ChannelMessage)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        done,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false)
          }, LEADER_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
      pending.delete(requestId)
    }
    const token = fresh(sessionToken())
    if (token) return token
  }
  // No leader answered (it closed or slept): take over.
  if (await ensureLeadership()) {
    await getUser()
    return refreshHere()
  }
  return fresh(sessionToken())
}

/** Starts the session: processes an email link if there is one, then restores the signed-in user. */
export async function startSession(
  readCallback: boolean,
): Promise<{ user: User | null; callback: CallbackResult | null }> {
  ensureChannel()
  sessionToken()
  const callback = readCallback ? await handleAuthCallback() : null
  const isLeader = await ensureLeadership()
  let user = callback?.user ?? null
  // The leader hydrates the SDK, which also starts its own refresh timer. Other tabs use the shared cookie.
  if (!user && isLeader) user = await getUser()
  if (!user && !isLeader && sessionToken() && !fresh(sessionToken())) await refreshViaLeader()
  if (!user && fresh(sessionToken())) user = await getUser()
  if (!user && isLeader) relinquishLeadership()
  return { user, callback }
}

/** Refreshes when the token is about to expire. Call before requests and when the tab wakes up. */
export async function refreshIfNeeded(): Promise<string | null> {
  const token = sessionToken()
  if (!token || !expiresWithin(token, REFRESH_MARGIN_SEC)) return token
  return refreshViaLeader()
}

/** True only when Identity itself rejects the token; a network failure keeps the session. */
async function identityRejects(token: string | null): Promise<boolean> {
  if (!token) return true
  try {
    const res = await fetch('/.netlify/identity/user', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    return res.status === 401 || res.status === 403
  } catch {
    return false
  }
}

/**
 * After a 401 from the API: refresh and say whether to retry. When Identity rejects the session, tells
 * the app it's signed out.
 */
export function recoverAfterUnauthorized(): Promise<string | null> {
  recovery ??= (async () => {
    const stale = sessionToken()
    const refreshed = await refreshViaLeader()
    if (refreshed && refreshed !== stale) return refreshed
    const current = refreshed ?? sessionToken()
    if (await identityRejects(current)) {
      for (const listener of lostListeners) listener()
      return null
    }
    return null
  })().finally(() => {
    recovery = null
  })
  return recovery
}

/** Called when the session can't be recovered, so the app can show the sign-in screen. */
export function onSessionLost(listener: () => void): () => void {
  lostListeners.add(listener)
  return () => lostListeners.delete(listener)
}

/** Forget leadership on sign-out so a later sign-in in any tab can lead. */
export function endSession() {
  relinquishLeadership()
}
