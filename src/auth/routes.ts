// HTTP routes of the optional MCP OAuth server. Mounted only when OAuth is configured, and kept out of the
// OpenAPI spec: these are protocol endpoints for MCP clients, not the video API.
import { Hono, type Context } from 'hono'
import {
  OAuthError,
  decideConsent,
  finishUpstream,
  registerClient,
  resourceUrl,
  revokeToken,
  startAuthorization,
  tokenRequest,
  type OAuthDeps,
  type Outcome,
  type SignedIn,
} from './oauth.js'
import { liveSession, readCookie, SESSION_COOKIE } from './sessions.js'
import { webCallback, webSignInEnabled } from './web.js'

const MAX_BODY = 16 * 1024
const NO_STORE = { 'cache-control': 'no-store' }
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '600',
}
const PAGE_HEADERS = {
  ...NO_STORE,
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  // Not no-referrer: with it, browsers post this page's own forms with Origin: null (live on 11-02, consent was refused).
  'referrer-policy': 'same-origin',
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function html(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#ddd;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#a3a3a3;--line:#333;--accent:#2dd4bf}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:12vh auto;padding:0 16px}h1{font-size:1.4rem;line-height:1.3}p{color:var(--muted)}b{color:var(--fg)}
form{display:flex;gap:12px;margin-top:24px}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
</style></head><body><main>${body}</main></body></html>`
}

function respond(c: Context, outcome: Outcome) {
  if (outcome.kind === 'redirect') return c.redirect(outcome.url, 302)
  if (outcome.kind === 'page')
    return c.html(
      html(outcome.title, `<h1>${esc(outcome.title)}</h1><p>${esc(outcome.message)}</p>`),
      outcome.status,
      PAGE_HEADERS,
    )
  const name = esc(outcome.clientName)
  return c.html(
    html(
      `Connect ${outcome.clientName}`,
      `<h1>Allow ${name} to use the video agent?</h1>
<p>${name} (returning to <b>${esc(outcome.clientHost)}</b>) will be able to make, revise and publish videos as <b>${esc(outcome.email)}</b>, with your role. Only allow apps you just started connecting. You can disconnect it any time on the API keys page.</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${esc(outcome.consent)}">
<button class="primary" type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Cancel</button></form>`,
    ),
    200,
    PAGE_HEADERS,
  )
}

async function readForm(c: Context): Promise<URLSearchParams> {
  const text = await c.req.text()
  if (Buffer.byteLength(text) > MAX_BODY) throw new OAuthError('invalid_request', 'The request is too large.')
  const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type === 'application/json') {
    try {
      const obj = JSON.parse(text) as unknown
      if (!obj || typeof obj !== 'object') throw new Error('not an object')
      return new URLSearchParams(
        Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    } catch {
      throw new OAuthError('invalid_request', 'The body is not valid JSON.')
    }
  }
  return new URLSearchParams(text)
}

/** The client id from HTTP Basic, for clients that send it there; public clients have no secret to check. */
function basicClientId(c: Context): string | null {
  const m = /^Basic\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')
  if (!m?.[1]) return null
  const decoded = Buffer.from(m[1], 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  try {
    return decodeURIComponent(i < 0 ? decoded : decoded.slice(0, i)) || null
  } catch {
    return null
  }
}

function oauthError(c: Context, e: unknown) {
  if (!(e instanceof OAuthError)) throw e
  return c.json({ error: e.error, error_description: e.description }, e.status, { ...NO_STORE, ...CORS })
}

export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono()
  const site = deps.config.siteUrl

  for (const path of ['/.well-known/*', '/oauth/token', '/oauth/register', '/oauth/revoke'])
    app.options(path, (c) => c.body(null, 204, CORS))

  const protectedResource = (c: Context) =>
    c.json(
      {
        resource: resourceUrl(deps),
        authorization_servers: [site],
        scopes_supported: ['mcp'],
        bearer_methods_supported: ['header'],
        resource_name: 'Video Agent',
      },
      200,
      { ...NO_STORE, ...CORS },
    )
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(
      {
        issuer: site,
        authorization_endpoint: `${site}/oauth/authorize`,
        token_endpoint: `${site}/oauth/token`,
        registration_endpoint: `${site}/oauth/register`,
        revocation_endpoint: `${site}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      },
      200,
      { ...NO_STORE, ...CORS },
    ),
  )

  app.post('/oauth/register', async (c) => {
    try {
      const text = await c.req.text()
      if (Buffer.byteLength(text) > MAX_BODY)
        throw new OAuthError('invalid_client_metadata', 'The request is too large.')
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new OAuthError('invalid_client_metadata', 'Registration takes a JSON body.')
      }
      return c.json(await registerClient(deps, body), 201, { ...NO_STORE, ...CORS })
    } catch (e) {
      if (e instanceof OAuthError && e.status === 429) c.header('retry-after', '60')
      return oauthError(c, e)
    }
  })

  // Single sign-on: someone signed in to the web app with Netlify goes straight to consent. A session that no longer
  // holds (expired, disabled, out of the team) falls back to the upstream sign-in.
  const signedIn = (c: Context) => async (): Promise<SignedIn | null> => {
    if (!webSignInEnabled(deps) || !readCookie(c.req.raw, SESSION_COOKIE)) return null
    try {
      const { session, user } = await liveSession(deps, c.req.raw)
      return {
        row: user,
        upstreamTokenEnc: session.upstreamTokenEnc,
        membershipCheckedAt: session.membershipCheckedAt,
      }
    } catch {
      return null
    }
  }
  app.get('/oauth/authorize', async (c) =>
    respond(c, await startAuthorization(deps, new URL(c.req.url).searchParams, signedIn(c))),
  )
  app.get('/oauth/callback', async (c) => {
    // The web app's Sign in with Netlify shares this redirect URI; its browser-bound cookie claims the callback.
    const web = webSignInEnabled(deps) ? await webCallback(deps, c) : null
    return web ?? respond(c, await finishUpstream(deps, new URL(c.req.url).searchParams))
  })
  app.post('/oauth/consent', async (c) => {
    // Sec-Fetch-Site says where the form was posted from, even when Origin is null (a page with no referrer, some
    // privacy settings); browsers without it are checked by Origin.
    const fetchSite = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    if (fetchSite ? fetchSite !== 'same-origin' : origin && origin !== new URL(site).origin)
      return respond(c, {
        kind: 'page',
        status: 400,
        title: 'Request refused',
        message: 'Cross-site request.',
      })
    const form = new URLSearchParams(await c.req.text())
    const outcome = await decideConsent(deps, form.get('consent') ?? '', form.get('decision') === 'allow')
    // 303, so the browser follows the redirect with a GET.
    return outcome.kind === 'redirect' ? c.redirect(outcome.url, 303) : respond(c, outcome)
  })

  app.post('/oauth/token', async (c) => {
    try {
      const tokens = await tokenRequest(deps, await readForm(c), basicClientId(c))
      return c.json(tokens, 200, { ...NO_STORE, ...CORS, pragma: 'no-cache' })
    } catch (e) {
      return oauthError(c, e)
    }
  })
  app.post('/oauth/revoke', async (c) => {
    try {
      await revokeToken(deps, await readForm(c), basicClientId(c))
      return c.body(null, 200, { ...NO_STORE, ...CORS })
    } catch (e) {
      return oauthError(c, e)
    }
  })

  return app
}
