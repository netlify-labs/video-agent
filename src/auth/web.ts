// Sign in with Netlify for the web app (AUTH_PROVIDER=netlify): /auth/netlify/start → Netlify → /oauth/callback (the
// same redirect URI as MCP OAuth; a signed, browser-bound cookie tells the two apart) → session cookie.
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { Deps, OAuthPort } from '../deps.js'
import { emailDomain } from '../domain/auth.js'
import { getSettings } from '../domain/settings.js'
import { deriveKey, hmacHex, safeEqual } from '../lib/crypto.js'
import { linkUpstreamUser, webAdmission } from './accounts.js'
import { checkTeams, teamLabel, teamRequired } from './membership.js'
import {
  clearSessionCookie,
  cookie,
  createSession,
  endSession,
  readCookie,
  sessionCookie,
} from './sessions.js'
import type { UpstreamUser } from './upstream.js'

export type WebAuthDeps = Deps & { oauth: OAuthPort }

export function webSignInEnabled(deps: Deps): deps is WebAuthDeps {
  return deps.config.authProvider === 'netlify' && deps.config.netlifyOAuth !== null && deps.oauth !== null
}

const SIGNIN_COOKIE = 'va_signin'
const SIGNIN_PATH = '/oauth/callback'
const SIGNIN_TTL_SEC = 600
const NO_STORE = { 'cache-control': 'no-store' }

/** A same-origin relative path to return to after signing in; anything else becomes "/". */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith('/') || value.startsWith('//')) return '/'
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/'
  const url = new URL(value, 'https://x.invalid')
  return url.origin === 'https://x.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/'
}

const stateKey = async (deps: Deps) =>
  deriveKey((await getSettings(deps)).dataEncryptionKey, 'web-signin-state:v1')

/** The sign-in cookie: state, return path and expiry, HMAC-signed so it can't be forged or replayed later. */
async function signInCookieValue(deps: Deps, state: string, returnTo: string) {
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + SIGNIN_TTL_SEC
  const body = `${state}.${Buffer.from(returnTo).toString('base64url')}.${exp}`
  return `${body}.${hmacHex(await stateKey(deps), body)}`
}

async function readSignInCookie(
  deps: Deps,
  req: Request,
): Promise<{ state: string; returnTo: string } | null> {
  const raw = readCookie(req, SIGNIN_COOKIE)
  const parts = raw?.split('.') ?? []
  if (parts.length !== 4) return null
  const [state = '', ret = '', exp = '', mac = ''] = parts
  if (!safeEqual(hmacHex(await stateKey(deps), `${state}.${ret}.${exp}`), mac)) return null
  if (Number(exp) < deps.clock.now().getTime() / 1000) return null
  return { state, returnTo: safeReturnTo(Buffer.from(ret, 'base64url').toString('utf8')) }
}

const failed = (c: Context, message: string) => {
  c.header('set-cookie', cookie(SIGNIN_COOKIE, '', 0, SIGNIN_PATH), { append: true })
  return c.redirect(`/?signin_error=${encodeURIComponent(message)}`, 302)
}

/**
 * GET /oauth/callback for a web sign-in. Returns null when the callback isn't one (it belongs to MCP OAuth): the
 * browser carries no sign-in cookie for this state.
 */
export async function webCallback(deps: WebAuthDeps, c: Context): Promise<Response | null> {
  const params = new URL(c.req.url).searchParams
  const pending = await readSignInCookie(deps, c.req.raw)
  const state = params.get('state')
  if (!pending || !state || !safeEqual(pending.state, state)) return null
  c.header('cache-control', 'no-store')
  const code = params.get('code')
  if (params.get('error') || !code) return failed(c, 'Sign-in was cancelled.')
  let user: UpstreamUser
  try {
    user = await deps.oauth.upstream.exchange(code, `${deps.config.siteUrl}${SIGNIN_PATH}`)
  } catch (e) {
    deps.log.warn('auth.upstream_failed', { error: e })
    return failed(c, 'Could not verify the sign-in right now. Try again shortly.')
  }
  const linked = await linkUpstreamUser(deps, 'netlify', user, webAdmission(deps))
  if (!linked.ok) {
    deps.log.info('auth.denied', { domain: emailDomain(user.email), why: linked.code })
    return failed(c, linked.reason)
  }
  if (teamRequired(deps)) {
    const verdict = await checkTeams(deps, user.accessToken)
    if (verdict !== 'member') {
      deps.log.info('auth.denied', { userId: linked.row.id, why: `team_${verdict}` })
      return failed(
        c,
        verdict === 'unavailable'
          ? 'Could not check your Netlify team membership right now. Try again shortly.'
          : `You're not in the ${teamLabel(deps)} Netlify team.`,
      )
    }
  }
  const token = await createSession(deps, linked.row.id, user.accessToken)
  c.header('set-cookie', cookie(SIGNIN_COOKIE, '', 0, SIGNIN_PATH), { append: true })
  c.header('set-cookie', sessionCookie(token), { append: true })
  return c.redirect(pending.returnTo, 302)
}

/** /auth/netlify/start and /auth/sign-out; with MCP OAuth off, also the /oauth/callback they share. */
export function webAuthRoutes(deps: WebAuthDeps, opts: { withCallback: boolean }) {
  const app = new Hono()
  app.get('/auth/netlify/start', async (c) => {
    const state = deps.ids.secret(32)
    const returnTo = safeReturnTo(c.req.query('return_to'))
    c.header(
      'set-cookie',
      cookie(SIGNIN_COOKIE, await signInCookieValue(deps, state, returnTo), SIGNIN_TTL_SEC, SIGNIN_PATH),
    )
    // Netlify OAuth apps are confidential clients (the secret is sent on exchange), so there is no PKCE upstream.
    const url = deps.oauth.upstream.authorizeUrl({
      state,
      redirectUri: `${deps.config.siteUrl}${SIGNIN_PATH}`,
    })
    return c.redirect(url, 302)
  })
  app.post('/auth/sign-out', async (c) => {
    const origin = c.req.header('origin')
    if (!origin || origin !== new URL(c.req.url).origin)
      return c.json({ error: { code: 'forbidden', message: 'Cross-site request refused.' } }, 403)
    await endSession(deps, c.req.raw)
    return c.body(null, 204, { ...NO_STORE, 'set-cookie': clearSessionCookie() })
  })
  if (opts.withCallback)
    app.get(
      SIGNIN_PATH,
      async (c) => (await webCallback(deps, c)) ?? failed(c, 'This sign-in has expired. Try again.'),
    )
  return app
}
