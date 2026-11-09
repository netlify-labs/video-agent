// Connecting a YouTube channel (publish destinations §4): a standard OAuth 2.0 web flow with PKCE. The state and the
// PKCE verifier live in a short-lived encrypted cookie bound to the signed-in person, so a callback only works in the
// browser that started it, once. Mounted only when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set.
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Deps } from '../deps.js'
import { principalFromRequest } from '../domain/auth.js'
import {
  authorizeUrl,
  encryptToken,
  exchangeCode,
  myChannel,
  YOUTUBE_SCOPE,
} from '../domain/destinations/google.js'
import { assertCan } from '../domain/policy.js'
import { getSettings } from '../domain/settings.js'
import { decrypt, encrypt, safeEqual } from '../lib/crypto.js'
import { readCookie } from './sessions.js'

const COOKIE = 'va_google_oauth'
const TTL_SEC = 600
const b64url = (b: Buffer) => b.toString('base64url')

interface Pending {
  state: string
  verifier: string
  userId: string
  exp: number
}

const back = (deps: Deps, q: string) => `${deps.config.siteUrl}/keys?${q}#connected-accounts`
const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

export function googleRoutes(deps: Deps) {
  const app = new Hono()

  app.get('/auth/google/start', async (c) => {
    const p = await principalFromRequest(deps, c.req.raw)
    assertCan(p, 'video:create')
    const { dataEncryptionKey } = await getSettings(deps)
    const verifier = b64url(randomBytes(32))
    const pending: Pending = {
      state: b64url(randomBytes(24)),
      verifier,
      userId: p.userId,
      exp: Math.floor(deps.clock.now().getTime() / 1000) + TTL_SEC,
    }
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    c.header('set-cookie', cookie(encrypt(dataEncryptionKey, JSON.stringify(pending)), TTL_SEC))
    c.header('cache-control', 'no-store')
    return c.redirect(authorizeUrl(deps, pending.state, challenge), 302)
  })

  app.get('/auth/google/callback', async (c) => {
    // Single use: the cookie is cleared whatever happens next.
    c.header('set-cookie', cookie('', 0))
    c.header('cache-control', 'no-store')
    const fail = (why: string) => {
      deps.log.warn('youtube.connect_failed', { why })
      return c.redirect(back(deps, `youtube=${encodeURIComponent(why)}`), 302)
    }
    const raw = readCookie(c.req.raw, COOKIE)
    if (!raw) return fail('expired')
    let pending: Pending
    try {
      const { dataEncryptionKey } = await getSettings(deps)
      pending = JSON.parse(decrypt(dataEncryptionKey, raw)) as Pending
    } catch {
      return fail('expired')
    }
    const p = await principalFromRequest(deps, c.req.raw).catch(() => null)
    const state = c.req.query('state') ?? ''
    if (
      !p ||
      p.userId !== pending.userId ||
      !safeEqual(state, pending.state) ||
      pending.exp < Math.floor(deps.clock.now().getTime() / 1000)
    )
      return fail('expired')
    if (c.req.query('error')) return fail('denied')
    const code = c.req.query('code')
    if (!code) return fail('denied')
    try {
      const t = await exchangeCode(deps, code, pending.verifier)
      if (!t.scopes.includes(YOUTUBE_SCOPE)) return fail('scope')
      if (!t.refreshToken) return fail('no_refresh_token')
      const ch = await myChannel(deps, t.accessToken)
      const now = deps.clock.now().toISOString()
      // Reconnecting the same channel keeps the connection's id, so publications pinned to it can still be removed.
      const prior = await deps.store.getUserConnection(p.userId, 'youtube')
      await deps.store.putDestinationConnection({
        id: prior?.accountId === ch.id ? prior.id : `dcon_${deps.ids.uuid().replace(/-/g, '').slice(0, 16)}`,
        userId: p.userId,
        kind: 'youtube',
        accountId: ch.id,
        accountLabel: ch.title,
        tokenEnc: await encryptToken(deps, t.refreshToken),
        scopes: t.scopes,
        status: 'ok',
        createdAt: prior?.accountId === ch.id ? prior.createdAt : now,
        updatedAt: now,
        revokedAt: null,
      })
      deps.log.info('youtube.connected', { userId: p.userId, channel: ch.id })
      return c.redirect(back(deps, 'youtube=connected'), 302)
    } catch (e) {
      deps.log.warn('youtube.connect_error', { error: e })
      return fail('google')
    }
  })

  return app
}
