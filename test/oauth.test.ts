// Optional MCP OAuth: off by default (nothing changes), and when on, the whole authorize → consent → token → /mcp
// flow against a fake upstream, with the failure cases the mcp-gateway learned about.
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { apiKey, harness, person, pgStore, type Harness } from './helpers.js'

const SITE = 'https://video.example.com'
const RESOURCE = `${SITE}/mcp`
const REDIRECT = 'https://client.example/callback'
const ON = {
  MCP_OAUTH_PROVIDER: 'netlify',
  NETLIFY_OAUTH_CLIENT_ID: 'netlify-client',
  NETLIFY_OAUTH_CLIENT_SECRET: 'netlify-secret',
}

/** A request straight to the app (no JSON body or cookie defaults). */
async function send(
  h: Harness,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) {
  return h.app.fetch(new Request(`${SITE}${path}`, { method, ...init }), {
    context: { deploy: { published: true }, waitUntil: () => undefined },
  })
}
const post = (
  h: Harness,
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  send(h, 'POST', path, {
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  })

async function register(
  h: Harness,
  body: unknown = { redirect_uris: [REDIRECT], client_name: 'Test client' },
) {
  return send(h, 'POST', '/oauth/register', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const authorizeQuery = (clientId: string, over: Record<string, string | null> = {}) => {
  const q = new URLSearchParams()
  const all: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
    ...over,
  }
  for (const [k, v] of Object.entries(all)) if (v !== null) q.set(k, v)
  return `/oauth/authorize?${q.toString()}`
}

const location = (res: Response) => new URL(res.headers.get('location') ?? 'about:blank')

/** Authorize → upstream sign-in → callback; returns the callback response (the consent page, or a redirect). */
async function signIn(h: Harness, email: string, opts: { clientId?: string; redirectUri?: string } = {}) {
  const clientId = opts.clientId ?? (await h.json(await register(h))).client_id
  const redirectUri = opts.redirectUri ?? REDIRECT
  const { verifier, challenge } = pkce()
  const auth = await send(
    h,
    'GET',
    authorizeQuery(clientId, { redirect_uri: redirectUri, code_challenge: challenge }),
  )
  expect(auth.status).toBe(302)
  const up = location(auth)
  expect(up.origin).toBe('https://upstream.example')
  expect(up.searchParams.get('redirect_uri')).toBe(`${SITE}/oauth/callback`)
  const code = h.deps.oauth.upstream.signIn({ email })
  const cb = await send(h, 'GET', `/oauth/callback?code=${code}&state=${up.searchParams.get('state')}`)
  return { clientId, redirectUri, verifier, cb }
}

/** The whole browser part: sign in, allow, and return the code the client receives. */
async function authorize(h: Harness, email: string, opts: { clientId?: string; redirectUri?: string } = {}) {
  const s = await signIn(h, email, opts)
  expect(s.cb.status).toBe(200)
  const consent = /name="consent" value="([^"]+)"/.exec(await s.cb.text())?.[1] ?? ''
  const res = await post(h, '/oauth/consent', { consent, decision: 'allow' }, { origin: SITE })
  expect(res.status).toBe(303)
  const back = location(res)
  expect(back.origin + back.pathname).toBe(new URL(s.redirectUri).origin + new URL(s.redirectUri).pathname)
  expect(back.searchParams.get('state')).toBe('st-1')
  expect(back.searchParams.get('iss')).toBe(SITE)
  return { ...s, code: back.searchParams.get('code') ?? '' }
}

const exchange = (
  h: Harness,
  a: { clientId: string; redirectUri: string; verifier: string; code: string },
  over: Record<string, string> = {},
) =>
  post(h, '/oauth/token', {
    grant_type: 'authorization_code',
    code: a.code,
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    code_verifier: a.verifier,
    resource: RESOURCE,
    ...over,
  })

async function connect(h: Harness, email: string, opts: { clientId?: string; redirectUri?: string } = {}) {
  const a = await authorize(h, email, opts)
  const res = await exchange(h, a)
  expect(res.status).toBe(200)
  const tokens = await h.json(res)
  return { ...a, access: tokens.access_token as string, refresh: tokens.refresh_token as string, tokens }
}

const refresh = (h: Harness, clientId: string, token: string) =>
  post(h, '/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId })

async function rpc(h: Harness, token: string | null, method: string, params: unknown = {}, path = '/mcp') {
  return send(h, 'POST', path, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}
const toolNames = async (h: Harness, token: string) => {
  const res = await rpc(h, token, 'tools/list')
  expect(res.status).toBe(200)
  return ((await res.json()) as any).result.tools.map((t: { name: string }) => t.name).sort() as string[]
}

/** A harness with OAuth on, and the member's and admin's rows created by a first sign-in. */
async function on(env: Record<string, string> = {}, store?: Harness['deps']['store']) {
  const h = harness({ ...ON, ...env }, store ? { store } : {})
  await h.call('GET', '/api/v1/me', { as: h.member })
  await h.call('GET', '/api/v1/me', { as: h.admin })
  return h
}

describe('MCP OAuth: off by default', () => {
  it('serves none of the OAuth routes and says so in config', async () => {
    const h = harness()
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      authorizeQuery('nvc_x'),
      '/oauth/callback?code=a&state=b',
    ])
      expect((await send(h, 'GET', path)).status).toBe(404)
    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/oauth/consent'])
      expect((await post(h, path, {})).status).toBe(404)
    expect((await h.call('GET', '/api/v1/oauth/grants', { as: h.member })).status).toBe(404)
    expect((await h.json(await h.call('GET', '/api/v1/config'))).mcpOAuth).toBe(false)
  })

  it('answers /mcp exactly as before', async () => {
    const h = harness()
    const none = await rpc(h, null, 'tools/list')
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="video-agent"')
    expect(await none.text()).toBe(
      JSON.stringify({
        error: {
          code: 'unauthorized',
          message: 'Send your API key as "Authorization: Bearer nva_…". Create one on the API keys page.',
        },
      }),
    )
    const other = await rpc(h, 'nvat_abcdefghijklmnopqrstuvwxyz', 'tools/list')
    expect(other.status).toBe(401)
    expect(other.headers.get('www-authenticate')).toBeNull()
    expect(await other.text()).toBe(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid API key.' } }),
    )
  })

  it('gives API-key clients byte-identical MCP responses whether OAuth is on or off', async () => {
    const bodies: string[] = []
    for (const env of [{}, ON]) {
      const h = harness(env)
      const key = await apiKey(h, h.member)
      const res = await rpc(h, key, 'tools/list')
      expect(res.status).toBe(200)
      bodies.push(await res.text())
    }
    expect(bodies[1]).toBe(bodies[0])
  })

  it('stays off when the provider is set without credentials', async () => {
    const h = harness({ MCP_OAUTH_PROVIDER: 'netlify', NETLIFY_OAUTH_CLIENT_ID: 'x' })
    expect(h.deps.config.mcpOAuth).toBeNull()
    expect((await send(h, 'GET', '/.well-known/oauth-protected-resource')).status).toBe(404)
  })
})

describe('MCP OAuth: discovery and registration', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const h = await on()
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const prm = await h.json(await send(h, 'GET', path))
      expect(prm).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [SITE],
        bearer_methods_supported: ['header'],
      })
    }
    const as = await h.json(await send(h, 'GET', '/.well-known/oauth-authorization-server'))
    expect(as).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      revocation_endpoint: `${SITE}/oauth/revoke`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    })
    expect((await h.json(await h.call('GET', '/api/v1/config'))).mcpOAuth).toBe(true)
  })

  it('401s from /mcp point at the resource metadata', async () => {
    const h = await on()
    const none = await rpc(h, null, 'tools/list')
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource"`,
    )
    const bad = await rpc(h, 'nvat_abcdefghijklmnopqrstuvwxyz', 'tools/list', {}, '/api/mcp')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(bad.headers.get('www-authenticate')).toContain('resource_metadata=')
    const badKey = await rpc(h, 'nva_key_nope_secret', 'tools/list')
    expect(badKey.status).toBe(401)
    expect(((await badKey.json()) as any).error.message).toBe('Invalid API key.')
  })

  it('registers public clients and validates redirect URIs', async () => {
    const h = await on()
    const ok = await register(h, {
      redirect_uris: [REDIRECT, 'http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'client_secret_basic',
    })
    expect(ok.status).toBe(201)
    const body = await h.json(ok)
    expect(body.client_id).toMatch(/^nvc_/)
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.client_secret).toBeUndefined()
    for (const bad of [
      { redirect_uris: ['http://client.example/cb'] },
      { redirect_uris: ['https://client.example/cb#frag'] },
      { redirect_uris: ['https://user:pw@client.example/cb'] },
      { redirect_uris: ['javascript:alert(1)'] },
    ]) {
      const res = await register(h, bad)
      expect(res.status).toBe(400)
      expect((await h.json(res)).error).toBe('invalid_redirect_uri')
    }
    for (const bad of [{}, { redirect_uris: [] }, { redirect_uris: [REDIRECT], grant_types: ['password'] }]) {
      const res = await register(h, bad)
      expect(res.status).toBe(400)
      expect((await h.json(res)).error).toBe('invalid_client_metadata')
    }
  })

  it('accepts CIMD client ids from allowlisted hosts whose document names itself', async () => {
    const h = await on()
    const id = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
    h.deps.oauth.documents.set(id, { client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT] })
    const t = await connect(h, 'mia@acme.com', { clientId: id })
    expect(await toolNames(h, t.access)).toContain('create_video')
    const grants = await h.json(await h.call('GET', '/api/v1/oauth/grants', { as: h.member }))
    expect(grants[0]).toMatchObject({ clientId: id, clientName: 'Claude' })
  })

  it('refuses CIMD ids off the allowlist without fetching them, and documents that claim another id', async () => {
    const h = await on()
    const evil = 'https://169.254.169.254/latest/meta-data'
    expect((await send(h, 'GET', authorizeQuery(evil))).status).toBe(400)
    expect(h.deps.oauth.fetched).toEqual([])
    const id = 'https://claude.ai/client-a'
    h.deps.oauth.documents.set(id, { client_id: 'https://claude.ai/client-b', redirect_uris: [REDIRECT] })
    const res = await send(h, 'GET', authorizeQuery(id))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Unknown app')
    const secret = 'https://claude.ai/client-c'
    h.deps.oauth.documents.set(secret, {
      client_id: secret,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    })
    expect((await send(h, 'GET', authorizeQuery(secret))).status).toBe(400)
  })
})

describe('MCP OAuth: authorize, consent and tokens', () => {
  it('maps the verified email to the existing account, with its role and videos', async () => {
    const h = await on()
    const t = await connect(h, 'MIA@acme.com')
    expect(t.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' })
    expect(t.access).toMatch(/^nvat_/)
    expect(await toolNames(h, t.access)).toHaveLength(13)
    const res = await rpc(h, t.access, 'tools/call', {
      name: 'create_video',
      arguments: { prompt: 'A 10-second teaser that says "Ship faster".' },
    })
    const id = ((await res.json()) as any).result.structuredContent.video_id as string
    expect((await h.deps.store.getJob(id))?.ownerId).toBe('u_member')
    // Tokens are stored hashed.
    expect(JSON.stringify((h.deps.store as any).dump().oauthTokens)).not.toContain(t.access)
    expect(h.deps.logs.join('\n')).not.toContain(t.access)
    expect(h.deps.logs.join('\n')).not.toContain(t.refresh)
  })

  it("applies the person's role: a viewer gets the read-only tools", async () => {
    const h = await on()
    await person(h, 'vic', 'viewer')
    const t = await connect(h, 'vic@acme.com')
    const names = await toolNames(h, t.access)
    expect(names).not.toContain('create_video')
    expect(names).toContain('get_video')
  })

  it('gives a first-time email in an allowed domain an account with the default role', async () => {
    const h = await on()
    const t = await connect(h, 'newbie@acme.com')
    expect(await toolNames(h, t.access)).toContain('create_video')
    const row = (await h.deps.store.listUsers()).find((u) => u.email === 'newbie@acme.com')
    expect(row).toMatchObject({
      id: 'oauth_netlify_sub-newbie@acme.com',
      role: 'creator',
      admittedVia: 'domain',
    })
  })

  it('uses MCP_OAUTH_ALLOWED_EMAIL_DOMAINS over ALLOWED_EMAIL_DOMAINS', async () => {
    const h = await on({ MCP_OAUTH_ALLOWED_EMAIL_DOMAINS: 'netlify.com' })
    expect((await connect(h, 'dev@netlify.com')).access).toMatch(/^nvat_/)
    const s = await signIn(h, 'mia@acme.com')
    expect(location(s.cb).searchParams.get('error')).toBe('access_denied')
  })

  it('denies other domains with access_denied back to the client', async () => {
    const h = await on()
    const s = await signIn(h, 'eve@evil.com')
    expect(s.cb.status).toBe(302)
    const back = location(s.cb)
    expect(back.origin).toBe('https://client.example')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('st-1')
    expect(await h.deps.store.listUsers()).toHaveLength(2)
  })

  it('denies when the person cancels at the provider, declines consent, or the provider is down', async () => {
    const h = await on()
    const clientId = (await h.json(await register(h))).client_id
    const auth = await send(h, 'GET', authorizeQuery(clientId))
    const cancelled = await send(
      h,
      'GET',
      `/oauth/callback?error=access_denied&state=${location(auth).searchParams.get('state')}`,
    )
    expect(location(cancelled).searchParams.get('error')).toBe('access_denied')

    const s = await signIn(h, 'mia@acme.com', { clientId })
    const consent = /name="consent" value="([^"]+)"/.exec(await s.cb.text())?.[1] ?? ''
    const declined = await post(h, '/oauth/consent', { consent, decision: 'deny' }, { origin: SITE })
    expect(location(declined).searchParams.get('error')).toBe('access_denied')
    expect(location(declined).searchParams.get('code')).toBeNull()

    h.deps.oauth.upstream.failNext = true
    const down = await signIn(h, 'mia@acme.com', { clientId })
    expect(location(down.cb).searchParams.get('error')).toBe('temporarily_unavailable')
  })

  it('shows a page instead of redirecting when no redirect is safe', async () => {
    const h = await on()
    const clientId = (await h.json(await register(h))).client_id
    for (const path of [
      authorizeQuery('nvc_unknown'),
      authorizeQuery(clientId, { redirect_uri: 'https://attacker.example/callback' }),
      authorizeQuery(clientId, { redirect_uri: null }),
      '/oauth/callback?code=x&state=nope',
    ]) {
      const res = await send(h, 'GET', path)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
    const crossSite = await post(
      h,
      '/oauth/consent',
      { consent: 'x', decision: 'allow' },
      { origin: 'https://evil.example' },
    )
    expect(crossSite.status).toBe(400)
  })

  it('requires PKCE S256, state and the exact resource at authorize', async () => {
    const h = await on()
    const clientId = (await h.json(await register(h))).client_id
    const cases: [Record<string, string | null>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: null }, 'invalid_request'],
      [{ state: null }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: null }, 'invalid_target'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ]
    for (const [over, error] of cases) {
      const res = await send(h, 'GET', authorizeQuery(clientId, over))
      expect(res.status).toBe(302)
      expect(location(res).origin).toBe('https://client.example')
      expect(location(res).searchParams.get('error')).toBe(error)
    }
  })

  it('binds the code to its PKCE verifier, redirect URI, client and resource', async () => {
    const h = await on()
    const a = await authorize(h, 'mia@acme.com')
    const other = (await h.json(await register(h))).client_id
    for (const [over, error] of [
      [{ code_verifier: pkce().verifier }, 'invalid_grant'],
      [{ redirect_uri: 'https://client.example/other' }, 'invalid_grant'],
      [{ client_id: other }, 'invalid_grant'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ] as const) {
      const res = await exchange(h, a, over)
      expect(res.status).toBe(400)
      expect((await h.json(res)).error).toBe(error)
    }
    // None of those used up the code.
    expect((await exchange(h, a)).status).toBe(200)
  })

  it('refuses a reused code and revokes what it was traded for', async () => {
    const h = await on()
    const a = await authorize(h, 'mia@acme.com')
    const first = await h.json(await exchange(h, a))
    const again = await exchange(h, a)
    expect(again.status).toBe(400)
    expect((await h.json(again)).error).toBe('invalid_grant')
    expect((await rpc(h, first.access_token, 'tools/list')).status).toBe(401)
  })

  it('expires codes after five minutes', async () => {
    const h = await on()
    const a = await authorize(h, 'mia@acme.com')
    h.deps.clock.advance(5 * 60_000 + 1)
    expect((await exchange(h, a)).status).toBe(400)
  })

  it('rotates refresh tokens, and a reused one revokes the whole grant', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    const r1 = await refresh(h, t.clientId, t.refresh)
    expect(r1.status).toBe(200)
    const next = await h.json(r1)
    expect(next.refresh_token).not.toBe(t.refresh)
    expect((await rpc(h, next.access_token, 'tools/list')).status).toBe(200)
    const reused = await refresh(h, t.clientId, t.refresh)
    expect(reused.status).toBe(400)
    expect((await h.json(reused)).error).toBe('invalid_grant')
    expect((await rpc(h, next.access_token, 'tools/list')).status).toBe(401)
    expect((await refresh(h, t.clientId, next.refresh_token)).status).toBe(400)
  })

  it('refuses a refresh from another client', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    const other = (await h.json(await register(h))).client_id
    expect((await refresh(h, other, t.refresh)).status).toBe(400)
    expect((await refresh(h, t.clientId, t.refresh)).status).toBe(200)
  })

  it('expires access tokens after an hour; the refresh token still works', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    h.deps.clock.advance(3600_000 + 1)
    const res = await rpc(h, t.access, 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    const r = await h.json(await refresh(h, t.clientId, t.refresh))
    expect((await rpc(h, r.access_token, 'tools/list')).status).toBe(200)
  })

  it('revokes through /oauth/revoke, only for the client the token was issued to', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    const other = (await h.json(await register(h))).client_id
    expect((await post(h, '/oauth/revoke', { token: t.refresh, client_id: other })).status).toBe(200)
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(200)
    expect((await post(h, '/oauth/revoke', { token: t.refresh, client_id: t.clientId })).status).toBe(200)
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(401)
    expect((await refresh(h, t.clientId, t.refresh)).status).toBe(400)
  })

  it('matches loopback redirect URIs on any port, and nothing else loosely', async () => {
    const h = await on()
    const clientId = (await h.json(await register(h, { redirect_uris: ['http://127.0.0.1:3000/callback'] })))
      .client_id
    const t = await connect(h, 'mia@acme.com', { clientId, redirectUri: 'http://127.0.0.1:54321/callback' })
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(200)
    for (const uri of [
      'http://127.0.0.1:54321/other',
      'http://localhost:54321/callback',
      'https://127.0.0.1:3000/callback',
    ])
      expect((await send(h, 'GET', authorizeQuery(clientId, { redirect_uri: uri }))).status).toBe(400)
  })

  it('still takes API keys, but not cookie sessions or OAuth tokens on the REST API', async () => {
    const h = await on()
    const key = await apiKey(h, h.member)
    expect(await toolNames(h, key)).toHaveLength(13)
    const cookie = await send(h, 'POST', '/mcp', {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: {
        cookie: h.member,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
    })
    expect(cookie.status).toBe(401)
    const t = await connect(h, 'mia@acme.com')
    expect((await h.call('GET', '/api/v1/videos', { key: t.access, origin: null })).status).toBe(401)
  })

  it('stops working for disabled people and deleted Identity accounts', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    expect(
      (await h.call('PATCH', '/api/v1/users/u_member', { as: h.admin, body: { disabled: true } })).status,
    ).toBe(200)
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(401)
    expect((await refresh(h, t.clientId, t.refresh)).status).toBe(400)
    const denied = await signIn(h, 'mia@acme.com')
    expect(location(denied.cb).searchParams.get('error')).toBe('access_denied')

    const h2 = await on()
    const t2 = await connect(h2, 'mia@acme.com')
    h2.deps.identity.users.delete('u_member')
    const { resetAuthCache } = await import('../src/domain/auth.js')
    resetAuthCache()
    expect((await rpc(h2, t2.access, 'tools/list')).status).toBe(401)
  })

  it('lists connected apps on the Keys page and disconnects them', async () => {
    const h = await on()
    const t = await connect(h, 'mia@acme.com')
    await rpc(h, t.access, 'tools/list')
    const list = await h.json(await h.call('GET', '/api/v1/oauth/grants', { as: h.member }))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ clientName: 'Test client', clientId: t.clientId })
    expect(list[0].lastUsedAt).toBeTruthy()
    expect(await h.json(await h.call('GET', '/api/v1/oauth/grants', { as: h.admin }))).toEqual([])
    const other = await person(h, 'otto')
    expect((await h.call('DELETE', `/api/v1/oauth/grants/${list[0].id}`, { as: other })).status).toBe(404)
    expect((await h.call('DELETE', `/api/v1/oauth/grants/${list[0].id}`, { as: h.member })).status).toBe(204)
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(401)
    expect(await h.json(await h.call('GET', '/api/v1/oauth/grants', { as: h.member }))).toEqual([])
  })

  it('the sweep deletes expired requests, tokens, grants and idle clients', async () => {
    const h = await on()
    await connect(h, 'mia@acme.com')
    await send(h, 'GET', authorizeQuery((await h.json(await register(h))).client_id))
    h.deps.clock.advance(91 * 86400_000)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 5 })
    const d = (h.deps.store as any).dump()
    for (const table of ['oauthRequests', 'oauthGrants', 'oauthTokens', 'oauthClients'])
      expect(d[table].size).toBe(0)
  })
})

describe('MCP OAuth on Postgres', () => {
  it('runs the flow, rotation, reuse detection, connected apps and the sweep', async () => {
    const h = await on({}, await pgStore())
    const t = await connect(h, 'mia@acme.com')
    expect(await toolNames(h, t.access)).toHaveLength(13)
    const again = await exchange(h, t)
    expect(again.status).toBe(400)
    expect((await rpc(h, t.access, 'tools/list')).status).toBe(401)

    const t2 = await connect(h, 'newbie@acme.com')
    const next = await h.json(await refresh(h, t2.clientId, t2.refresh))
    expect((await rpc(h, next.access_token, 'tools/list')).status).toBe(200)
    expect((await refresh(h, t2.clientId, t2.refresh)).status).toBe(400)
    expect((await rpc(h, next.access_token, 'tools/list')).status).toBe(401)

    const t3 = await connect(h, 'mia@acme.com')
    const grants = await h.json(await h.call('GET', '/api/v1/oauth/grants', { as: h.member }))
    expect(grants).toHaveLength(1)
    expect(await h.deps.store.listOAuthGrants('u_member', '2000-01-01T00:00:00.000Z')).toHaveLength(1)
    await h.deps.store.revokeOAuthGrants('u_member', h.deps.clock.now().toISOString())
    expect((await rpc(h, t3.access, 'tools/list')).status).toBe(401)

    h.deps.clock.advance(91 * 86400_000)
    expect(
      await h.deps.store.deleteExpiredOAuth(
        h.deps.clock.now().toISOString(),
        h.deps.clock.now().toISOString(),
      ),
    ).toBeGreaterThan(0)
    expect(await h.deps.store.getOAuthClient(t.clientId)).toBeNull()
    expect(await h.deps.store.getOAuthGrant(grants[0].id)).toBeNull()
  })
})
