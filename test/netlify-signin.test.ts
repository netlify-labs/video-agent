// Sign in with Netlify (AUTH_PROVIDER=netlify): the web flow end to end, one account per person shared with MCP
// OAuth (linking and merging), single sign-on, sessions, and the Netlify team rule with its daily re-check.
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mergeUsers } from '../src/auth/accounts.js'
import { GRACE_MS, openToken, sealToken } from '../src/auth/membership.js'
import { runCleanup } from '../src/domain/cleanup.js'
import { getSettings } from '../src/domain/settings.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const SITE = 'https://video.example.com'
const RESOURCE = `${SITE}/mcp`
const REDIRECT = 'https://client.example/callback'
const CREDS = { NETLIFY_OAUTH_CLIENT_ID: 'netlify-client', NETLIFY_OAUTH_CLIENT_SECRET: 'netlify-secret' }
const NETLIFY = { AUTH_PROVIDER: 'netlify', ...CREDS }
const TEAM = { NETLIFY_REQUIRED_TEAM: 'acme-team' }
const ACME = { id: '5f3a9c0de1b2', slug: 'acme-team', name: 'Acme' }
const DAY = 86400_000

async function send(
  h: Harness,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) {
  // Background work (the sweep kick) finishes before the call returns, as in the harness.
  const pending: Promise<unknown>[] = []
  const res = await h.app.fetch(new Request(`${SITE}${path}`, { method, ...init }), {
    context: { deploy: { published: true }, waitUntil: (p: Promise<unknown>) => void pending.push(p) },
  })
  await Promise.all(pending)
  return res
}
const location = (res: Response) => new URL(res.headers.get('location') ?? 'about:blank', SITE)
/** The value a response sets for a cookie ('' when it clears it), or null when it doesn't set it. */
const setCookie = (res: Response, name: string) => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return line ? (line.split(';')[0] ?? '').slice(name.length + 1) : null
}

/** Start → Netlify → callback in a browser that keeps cookies. Returns the callback and the session cookie. */
async function webSignIn(
  h: Harness,
  email: string,
  opts: { returnTo?: string; teams?: (typeof ACME)[] } = {},
) {
  if (opts.teams) h.deps.oauth.upstream.teamsOf.set(email.toLowerCase(), opts.teams)
  const start = await send(
    h,
    'GET',
    `/auth/netlify/start${opts.returnTo === undefined ? '' : `?return_to=${encodeURIComponent(opts.returnTo)}`}`,
  )
  expect(start.status).toBe(302)
  const up = location(start)
  expect(up.origin).toBe('https://upstream.example')
  expect(up.searchParams.get('redirect_uri')).toBe(`${SITE}/oauth/callback`)
  const signin = setCookie(start, 'va_signin')
  expect(signin).toBeTruthy()
  const code = h.deps.oauth.upstream.signIn({ email })
  const cb = await send(h, 'GET', `/oauth/callback?code=${code}&state=${up.searchParams.get('state')}`, {
    headers: { cookie: `va_signin=${signin}` },
  })
  const session = setCookie(cb, 'va_session')
  return { cb, cookie: session ? `va_session=${session}` : null }
}

async function signedIn(h: Harness, email: string, teams?: (typeof ACME)[]) {
  const { cb, cookie } = await webSignIn(h, email, teams ? { teams } : {})
  expect(cb.status).toBe(302)
  expect(location(cb).searchParams.get('signin_error')).toBeNull()
  expect(cookie).toBeTruthy()
  return cookie as string
}

const me = async (h: Harness, cookie: string) => h.call('GET', '/api/v1/me', { as: cookie })
/** A browser over days: follows the daily session rotation. */
const browser = (cookie: string) => ({ cookie })
async function visit(h: Harness, b: { cookie: string }) {
  const res = await me(h, b.cookie)
  const next = setCookie(res, 'va_session')
  if (next) b.cookie = `va_session=${next}`
  return res
}
const signinError = (res: Response) => location(res).searchParams.get('signin_error')

// ───── MCP OAuth helpers ─────

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
const form = (
  h: Harness,
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  send(h, 'POST', path, {
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  })

async function authorizeUrl(h: Harness) {
  const reg = await send(h, 'POST', '/oauth/register', {
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test client' }),
    headers: { 'content-type': 'application/json' },
  })
  const clientId = ((await reg.json()) as { client_id: string }).client_id
  const { verifier, challenge } = pkce()
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
  })
  return { clientId, verifier, url: `/oauth/authorize?${q.toString()}` }
}

interface Conn {
  clientId: string
  access: string
  refresh: string
}

/** Allow on a consent page, trade the code, and return the access token. */
async function consentAndToken(h: Harness, page: Response, a: { clientId: string; verifier: string }) {
  return (await consent(h, page, a)).access
}

/** Allow, trade the code, and return the connection (access and refresh tokens). */
async function consent(h: Harness, page: Response, a: { clientId: string; verifier: string }): Promise<Conn> {
  expect(page.status).toBe(200)
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
  const allowed = await form(h, '/oauth/consent', { consent, decision: 'allow' }, { origin: SITE })
  expect(allowed.status).toBe(303)
  const code = location(allowed).searchParams.get('code') ?? ''
  const res = await form(h, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    client_id: a.clientId,
    redirect_uri: REDIRECT,
    code_verifier: a.verifier,
  })
  expect(res.status).toBe(200)
  const t = (await res.json()) as { access_token: string; refresh_token: string }
  return { clientId: a.clientId, access: t.access_token, refresh: t.refresh_token }
}

/** An MCP request after the client refreshed its hour-long access token, as clients do. */
async function later(h: Harness, c: Conn, method = 'tools/list') {
  const res = await form(h, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: c.refresh,
    client_id: c.clientId,
  })
  if (res.status === 200) {
    const t = (await res.json()) as { access_token: string; refresh_token: string }
    c.access = t.access_token
    c.refresh = t.refresh_token
  }
  return rpc(h, c.access, method)
}

/** MCP OAuth through the upstream (no web session). */
async function mcpConnect(h: Harness, email: string) {
  const a = await authorizeUrl(h)
  const auth = await send(h, 'GET', a.url)
  expect(auth.status).toBe(302)
  const code = h.deps.oauth.upstream.signIn({ email })
  const cb = await send(
    h,
    'GET',
    `/oauth/callback?code=${code}&state=${location(auth).searchParams.get('state')}`,
  )
  return { cb, a }
}
async function mcpToken(h: Harness, email: string) {
  const { cb, a } = await mcpConnect(h, email)
  return consentAndToken(h, cb, a)
}
async function mcpConn(h: Harness, email: string) {
  const { cb, a } = await mcpConnect(h, email)
  return consent(h, cb, a)
}

function rpc(h: Harness, token: string, method: string, params: unknown = {}) {
  return send(h, 'POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
  })
}
async function mcpCreate(h: Harness, token: string) {
  const res = await rpc(h, token, 'tools/call', { name: 'create_video', arguments: { prompt: PROMPT } })
  return ((await res.json()) as any).result.structuredContent.video_id as string
}

/** An identity-mode deployment where Mia (u_member) made a video, then the same store under Sign in with Netlify. */
async function migrated(env: Record<string, string> = {}, store?: Store) {
  const before = harness({}, store ? { store } : {})
  await before.call('GET', '/api/v1/me', { as: before.admin })
  const video = await before.json(
    await before.call('POST', '/api/v1/videos', { as: before.member, body: { prompt: PROMPT } }),
  )
  const h = harness({ ...NETLIFY, ...env }, { store: before.deps.store })
  return { h, videoId: video.id as string }
}

describe('Sign in with Netlify: off by default', () => {
  it('keeps Identity: no /auth routes, and config says identity', async () => {
    const h = harness()
    expect((await send(h, 'GET', '/auth/netlify/start')).status).toBe(404)
    expect((await send(h, 'POST', '/auth/sign-out', { headers: { origin: SITE } })).status).toBe(404)
    expect(await h.json(await h.call('GET', '/api/v1/config'))).toMatchObject({
      authProvider: 'identity',
      requiredTeams: [],
    })
    expect((await me(h, h.member)).status).toBe(200)
  })

  it('ignores a va_session cookie under Identity', async () => {
    const h = harness({ ...CREDS, MCP_OAUTH_PROVIDER: 'netlify' })
    expect(
      (await h.call('GET', '/api/v1/me', { as: 'va_session=nvs_abcdefghijklmnopqrstuvwxyz' })).status,
    ).toBe(401)
  })
})

describe('Sign in with Netlify: the web flow', () => {
  it('start → Netlify → callback → session cookie → /api/v1/me', async () => {
    const h = harness({ ...NETLIFY, ADMIN_EMAILS: 'boss@acme.com' })
    expect(await h.json(await h.call('GET', '/api/v1/config'))).toMatchObject({
      authProvider: 'netlify',
      mcpOAuth: true,
    })
    const { cb, cookie } = await webSignIn(h, 'Boss@Acme.com', { returnTo: '/videos/vid_1?tab=x' })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/videos/vid_1?tab=x')
    const line = cb.headers.getSetCookie().find((c) => c.startsWith('va_session='))
    expect(line).toMatch(/HttpOnly/)
    expect(line).toMatch(/Secure/)
    expect(line).toMatch(/SameSite=Lax/)
    expect(line).toMatch(/Max-Age=2592000/)
    expect(setCookie(cb, 'va_signin')).toBe('')
    const body = await h.json(await me(h, cookie as string))
    expect(body).toMatchObject({ email: 'boss@acme.com', role: 'admin', via: 'session' })
    expect(body.id).toBe('oauth_netlify_sub-Boss@Acme.com')
    // Cookie sessions keep the same-origin rule for writes.
    const cross = await h.call('POST', '/api/v1/videos', {
      as: cookie as string,
      body: { prompt: PROMPT },
      origin: 'https://evil.example',
    })
    expect(cross.status).toBe(403)
  })

  it('returns only to same-origin relative paths', async () => {
    const h = harness(NETLIFY)
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])
      expect((await webSignIn(h, 'mia@acme.com', { returnTo: bad })).cb.headers.get('location')).toBe('/')
  })

  it('refuses a callback without the browser-bound sign-in cookie, or with another state', async () => {
    const h = harness({ ...NETLIFY, MCP_OAUTH_PROVIDER: 'off' })
    expect(h.deps.config.mcpOAuth).toBeNull()
    const start = await send(h, 'GET', '/auth/netlify/start')
    const signin = setCookie(start, 'va_signin') ?? ''
    const code = h.deps.oauth.upstream.signIn({ email: 'mia@acme.com' })
    const noCookie = await send(
      h,
      'GET',
      `/oauth/callback?code=${code}&state=${location(start).searchParams.get('state')}`,
    )
    expect(signinError(noCookie)).toMatch(/expired/)
    const otherState = await send(h, 'GET', `/oauth/callback?code=${code}&state=forged`, {
      headers: { cookie: `va_signin=${signin}` },
    })
    expect(signinError(otherState)).toMatch(/expired/)
    const tampered = await send(h, 'GET', `/oauth/callback?code=${code}&state=x`, {
      headers: { cookie: `va_signin=x.${Buffer.from('/').toString('base64url')}.9999999999.00` },
    })
    expect(signinError(tampered)).toMatch(/expired/)
    expect(h.deps.oauth.upstream.exchanges).toHaveLength(0)
    expect(await h.deps.store.listUsers()).toHaveLength(0)
  })

  it('denies other email domains, and creates no account', async () => {
    const h = harness(NETLIFY)
    const { cb, cookie } = await webSignIn(h, 'eve@evil.com')
    expect(cookie).toBeNull()
    expect(signinError(cb)).toBe('Sign-ups are limited to acme.com addresses.')
    expect(await h.deps.store.listUsers()).toHaveLength(0)
  })

  it('says so when Netlify is down at sign-in', async () => {
    const h = harness(NETLIFY)
    h.deps.oauth.upstream.failNext = true
    expect(signinError((await webSignIn(h, 'mia@acme.com')).cb)).toMatch(/right now/)
  })

  it('under invite-only, admits ADMIN_EMAILS and people who already have an account', async () => {
    const h = harness({ ...NETLIFY, ALLOWED_EMAIL_DOMAINS: 'invite-only' })
    expect(signinError((await webSignIn(h, 'newbie@acme.com')).cb)).toMatch(/invite-only/)
    expect((await h.json(await me(h, await signedIn(h, 'admin@acme.com')))).role).toBe('admin')
  })

  it('takes API keys without asking Identity', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: cookie, body: { name: 'k' } }))).key
    h.deps.identity.outage = true
    expect((await h.call('GET', '/api/v1/me', { key, origin: null })).status).toBe(200)
  })

  it('signs out: the cookie is cleared and the session ends', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    const cross = await send(h, 'POST', '/auth/sign-out', {
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(cross.status).toBe(403)
    expect((await me(h, cookie)).status).toBe(200)
    const out = await send(h, 'POST', '/auth/sign-out', { headers: { cookie, origin: SITE } })
    expect(out.status).toBe(204)
    expect(setCookie(out, 'va_session')).toBe('')
    const after = await me(h, cookie)
    expect(after.status).toBe(401)
    expect((await h.json(after)).error.message).toBe('Your session has ended. Sign in again.')
  })

  it('slides and rotates the session daily; the old token works for a minute', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    h.deps.clock.advance(25 * 3600_000)
    const res = await me(h, cookie)
    expect(res.status).toBe(200)
    const next = setCookie(res, 'va_session')
    expect(next).toMatch(/^nvs_/)
    expect(`va_session=${next}`).not.toBe(cookie)
    expect((await me(h, cookie)).status).toBe(200)
    h.deps.clock.advance(61_000)
    expect((await me(h, cookie)).status).toBe(401)
    expect((await me(h, `va_session=${next}`)).status).toBe(200)
    // Thirty idle days end it.
    h.deps.clock.advance(31 * DAY)
    expect((await me(h, `va_session=${next}`)).status).toBe(401)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 5 })
    expect((h.deps.store as any).dump().sessions.size).toBe(0)
  })

  it('shows sign-in methods on the admin users page', async () => {
    const { h } = await migrated()
    const admin = await signedIn(h, 'admin@acme.com')
    await signedIn(h, 'newbie@acme.com')
    const users = await h.json(await h.call('GET', '/api/v1/users', { as: admin }))
    const of = (email: string) => users.find((u: { email: string }) => u.email === email).signInMethods
    expect(of('admin@acme.com')).toEqual(['identity', 'netlify'])
    expect(of('mia@acme.com')).toEqual(['identity'])
    expect(of('newbie@acme.com')).toEqual(['netlify'])
  })

  it('replaces the Identity setup checks with Netlify OAuth checks', async () => {
    const h = harness(NETLIFY)
    const checks = (await h.json(await h.call('GET', '/api/health'))).checks as {
      id: string
      status: string
    }[]
    const ids = checks.map((c) => c.id)
    expect(ids).toContain('netlify-oauth')
    expect(ids).toContain('netlify-team')
    expect(ids.some((id) => id.startsWith('identity'))).toBe(false)
    expect(checks.find((c) => c.id === 'netlify-oauth')?.status).toBe('ok')
    const bare = harness({ AUTH_PROVIDER: 'netlify' })
    const bareChecks = (await bare.json(await bare.call('GET', '/api/health'))).checks as {
      id: string
      status: string
    }[]
    expect(bareChecks.find((c) => c.id === 'netlify-oauth')?.status).toBe('fail')
  })
})

describe('Sign in with Netlify: one account per person', () => {
  it('links to the existing Identity account by email, with the same videos', async () => {
    const { h, videoId } = await migrated()
    const cookie = await signedIn(h, 'MIA@acme.com')
    expect((await h.json(await me(h, cookie))).id).toBe('u_member')
    const mine = await h.json(await h.call('GET', '/api/v1/videos?owner=me', { as: cookie }))
    expect(mine.items.map((v: { id: string }) => v.id)).toEqual([videoId])
    // The link is by Netlify user id from now on, even if the email at Netlify changes.
    await h.deps.store.updateUserIdentity('netlify', 'sub-MIA@acme.com', { email: 'old@acme.com' })
    expect((await h.json(await me(h, await signedIn(h, 'MIA@acme.com')))).id).toBe('u_member')
    expect(await h.deps.store.getUserIdentity('netlify', 'sub-MIA@acme.com')).toMatchObject({
      userId: 'u_member',
      email: 'mia@acme.com',
    })
  })

  it('gives web and MCP OAuth the same account', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'newbie@acme.com')
    const token = await mcpToken(h, 'newbie@acme.com')
    const id = await mcpCreate(h, token)
    const meRow = await h.json(await me(h, cookie))
    expect((await h.deps.store.getJob(id))?.ownerId).toBe(meRow.id)
    expect((await h.deps.store.listUsers()).filter((u) => u.email === 'newbie@acme.com')).toHaveLength(1)
  })

  it('links an existing oauth_netlify_ row (from MCP before this change) on first use', async () => {
    const h = harness(NETLIFY)
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.insertUserIfAbsent({
      id: 'oauth_netlify_sub-newbie@acme.com',
      email: 'newbie@acme.com',
      name: null,
      role: 'reviewer',
      admittedVia: 'domain',
      createdAt: now,
      lastSeenAt: now,
      disabledAt: null,
    })
    const cookie = await signedIn(h, 'newbie@acme.com')
    expect(await h.json(await me(h, cookie))).toMatchObject({
      id: 'oauth_netlify_sub-newbie@acme.com',
      role: 'reviewer',
    })
    expect(await h.deps.store.getUserIdentity('netlify', 'sub-newbie@acme.com')).toMatchObject({
      userId: 'oauth_netlify_sub-newbie@acme.com',
    })
  })

  it('merges an MCP-created oauth_ row into the Identity account for the same email', async () => {
    await mergeScenario(harness)
  })

  it('merges on Postgres too', async () => {
    const store = await pgStore()
    await mergeScenario((env, opts) => harness(env, { ...opts, store }))
  })

  it('keeps the Identity row when both have a verdict or a read watermark, and carries a disable', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.member })
    const now = h.deps.clock.now().toISOString()
    const stray = {
      id: 'oauth_netlify_x',
      email: 'mia@acme.com',
      name: null,
      role: 'admin' as const,
      admittedVia: 'domain' as const,
      createdAt: now,
      lastSeenAt: now,
      disabledAt: now,
    }
    await h.deps.store.insertUserIfAbsent(stray)
    for (const [userId, verdict] of [
      ['u_member', 'approved'],
      ['oauth_netlify_x', 'changes_requested'],
    ] as const)
      await h.deps.store.putVerdict({
        jobId: 'vid_x',
        versionN: 1,
        userId,
        verdict,
        note: null,
        updatedAt: now,
      })
    await h.deps.store.setNotificationReadAt('u_member', '2026-01-01T00:00:00.000Z')
    await h.deps.store.setNotificationReadAt('oauth_netlify_x', '2026-02-01T00:00:00.000Z')
    await mergeUsers(h.deps, 'oauth_netlify_x', 'u_member')
    expect(await h.deps.store.listVerdicts(['vid_x'])).toEqual([
      expect.objectContaining({ userId: 'u_member', verdict: 'approved' }),
    ])
    expect(await h.deps.store.getNotificationReadAt('u_member')).toBe('2026-01-01T00:00:00.000Z')
    expect(await h.deps.store.getNotificationReadAt('oauth_netlify_x')).toBeNull()
    const row = await h.deps.store.getUser('u_member')
    expect(row).toMatchObject({ role: 'creator', disabledAt: now })
    expect(await h.deps.store.getUser('oauth_netlify_x')).toBeNull()
  })
})

/**
 * Newbie connects over MCP first (an oauth_ row that makes a video, comments, a verdict and holds a key), then signs
 * up with Identity on the web; the next Netlify sign-in folds the oauth_ row into the Identity row.
 */
async function mergeScenario(make: (env: Record<string, string>, opts?: { store?: Store }) => Harness) {
  const h = make({ MCP_OAUTH_PROVIDER: 'netlify', ...CREDS })
  // PGlite has one connection, so a settings read from inside a transaction (signing file URLs while creating a
  // video over MCP OAuth) would wait on itself; warm the cache first. Pooled Postgres has no such wait.
  await getSettings(h.deps)
  await h.call('GET', '/api/v1/me', { as: h.member })
  const token = await mcpToken(h, 'newbie@acme.com')
  const oauthId = 'oauth_netlify_sub-newbie@acme.com'
  const videoId = await mcpCreate(h, token)
  await h.drive(4)
  const memberVideo = await h.json(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  await h.drive(4)
  await rpc(h, token, 'tools/call', {
    name: 'add_comment',
    arguments: { video_id: memberVideo.id, version: 1, body: 'Bigger logo' },
  })
  const now = h.deps.clock.now().toISOString()
  await h.deps.store.putVerdict({
    jobId: memberVideo.id,
    versionN: 1,
    userId: oauthId,
    verdict: 'approved',
    note: null,
    updatedAt: now,
  })
  await h.deps.store.insertKey({
    id: 'key_stray',
    ownerId: oauthId,
    name: 'k',
    secretHash: 'x',
    webhookSecretEnc: 'x',
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  })

  // Newbie signs up with Identity: a second row for the same email.
  const cookie = h.deps.identity.addUser({ id: 'u_newbie', email: 'newbie@acme.com', name: 'Newbie' }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  expect((await h.deps.store.listUsers()).filter((u) => u.email === 'newbie@acme.com')).toHaveLength(2)

  // The next MCP sign-in merges, and the earlier grant now acts as the Identity account.
  await mcpToken(h, 'newbie@acme.com')
  expect(
    (await h.deps.store.listUsers()).filter((u) => u.email === 'newbie@acme.com').map((u) => u.id),
  ).toEqual(['u_newbie'])
  expect((await h.deps.store.getJob(videoId))?.ownerId).toBe('u_newbie')
  expect((await h.deps.store.getVersion(videoId, 1))?.authorId).toBe('u_newbie')
  expect((await h.deps.store.listComments(memberVideo.id)).map((c) => c.authorId)).toEqual(['u_newbie'])
  expect((await h.deps.store.listVerdicts([memberVideo.id])).map((v) => v.userId)).toEqual(['u_newbie'])
  expect((await h.deps.store.getKey('key_stray'))?.ownerId).toBe('u_newbie')
  expect(await h.deps.store.listOAuthGrants('u_newbie', now)).toHaveLength(2)
  expect(await h.deps.store.getUserIdentity('netlify', 'sub-newbie@acme.com')).toMatchObject({
    userId: 'u_newbie',
  })
  const mine = await h.json(await h.call('GET', '/api/v1/videos?owner=me', { as: cookie }))
  expect(mine.items.map((v: { id: string }) => v.id)).toEqual([videoId])
  const whoami = await rpc(h, token, 'tools/call', { name: 'list_videos', arguments: { owner: 'me' } })
  expect(whoami.status).toBe(200)
}

describe('Sign in with Netlify: MCP single sign-on', () => {
  it('goes straight to consent for a signed-in browser, without the upstream round-trip', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    const exchanges = h.deps.oauth.upstream.exchanges.length
    const a = await authorizeUrl(h)
    const page = await send(h, 'GET', a.url, { headers: { cookie } })
    expect(page.status).toBe(200)
    const token = await consentAndToken(h, page, a)
    expect(h.deps.oauth.upstream.exchanges).toHaveLength(exchanges)
    const id = await mcpCreate(h, token)
    expect((await h.deps.store.getJob(id))?.ownerId).toBe((await h.json(await me(h, cookie))).id)
  })

  it('still enforces the client, redirect, PKCE and resource rules', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    const a = await authorizeUrl(h)
    const noPkce = await send(
      h,
      'GET',
      a.url.replace(/code_challenge_method=S256/, 'code_challenge_method=plain'),
      {
        headers: { cookie },
      },
    )
    expect(location(noPkce).searchParams.get('error')).toBe('invalid_request')
    const otherResource = await send(
      h,
      'GET',
      a.url.replace(/resource=[^&]+/, 'resource=https%3A%2F%2Fx.example'),
      {
        headers: { cookie },
      },
    )
    expect(location(otherResource).searchParams.get('error')).toBe('invalid_target')
    const otherRedirect = await send(
      h,
      'GET',
      a.url.replace(/redirect_uri=[^&]+/, 'redirect_uri=https%3A%2F%2Fevil.example'),
      {
        headers: { cookie },
      },
    )
    expect(otherRedirect.status).toBe(400)
  })

  it('falls back to the upstream sign-in when the session no longer holds', async () => {
    const h = harness(NETLIFY)
    const cookie = await signedIn(h, 'mia@acme.com')
    await send(h, 'POST', '/auth/sign-out', { headers: { cookie, origin: SITE } })
    const a = await authorizeUrl(h)
    const res = await send(h, 'GET', a.url, { headers: { cookie } })
    expect(res.status).toBe(302)
    expect(location(res).origin).toBe('https://upstream.example')
  })
})

describe('Sign in with Netlify: disabling', () => {
  it('ends the sessions and connected apps of a disabled person', async () => {
    const h = harness(NETLIFY)
    const admin = await signedIn(h, 'admin@acme.com')
    const cookie = await signedIn(h, 'mia@acme.com')
    const token = await mcpToken(h, 'mia@acme.com')
    const id = (await h.json(await me(h, cookie))).id
    expect(
      (await h.call('PATCH', `/api/v1/users/${id}`, { as: admin, body: { disabled: true } })).status,
    ).toBe(200)
    expect((await me(h, cookie)).status).toBe(401)
    expect((await rpc(h, token, 'tools/list')).status).toBe(401)
    expect(signinError((await webSignIn(h, 'mia@acme.com')).cb)).toBe(
      'Your account has been disabled by an admin.',
    )
  })
})

describe('Sign in with Netlify: the team rule', () => {
  it('denies people outside the team, and admits by slug or by id', async () => {
    const h = harness({ ...NETLIFY, NETLIFY_REQUIRED_TEAM: 'other, ACME-TEAM' })
    expect(await h.json(await h.call('GET', '/api/v1/config'))).toMatchObject({
      requiredTeams: ['other', 'acme-team'],
    })
    const out = await webSignIn(h, 'mia@acme.com', {
      teams: [{ id: 'zzz', slug: 'elsewhere', name: null }] as any,
    })
    expect(out.cookie).toBeNull()
    expect(signinError(out.cb)).toBe("You're not in the other or acme-team Netlify team.")
    expect((await me(h, await signedIn(h, 'mia@acme.com', [ACME]))).status).toBe(200)
    const byId = harness({ ...NETLIFY, NETLIFY_REQUIRED_TEAM: ACME.id.toUpperCase() })
    expect(
      (await me(byId, await signedIn(byId, 'mia@acme.com', [{ ...ACME, slug: 'renamed' }]))).status,
    ).toBe(200)
  })

  it('applies to MCP OAuth sign-ins, also under Identity', async () => {
    const h = harness({ MCP_OAUTH_PROVIDER: 'netlify', ...CREDS, ...TEAM })
    await h.call('GET', '/api/v1/me', { as: h.member })
    const denied = await mcpConnect(h, 'mia@acme.com')
    expect(location(denied.cb).searchParams.get('error')).toBe('access_denied')
    expect(location(denied.cb).searchParams.get('error_description')).toBe(
      "You're not in the acme-team Netlify team.",
    )
    h.deps.oauth.upstream.teamsOf.set('mia@acme.com', [ACME])
    const token = await mcpToken(h, 'mia@acme.com')
    expect((await rpc(h, token, 'tools/list')).status).toBe(200)
  })

  it('re-checks at most daily: someone who left loses the session and their connected apps', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    const cookie = await signedIn(h, 'mia@acme.com', [ACME])
    const conn = await mcpConn(h, 'mia@acme.com')
    const calls = h.deps.oauth.upstream.teamCalls.length
    h.deps.clock.advance(23 * 3600_000)
    expect((await me(h, cookie)).status).toBe(200)
    expect((await later(h, conn)).status).toBe(200)
    expect(h.deps.oauth.upstream.teamCalls).toHaveLength(calls)
    h.deps.oauth.upstream.teamsOf.set('mia@acme.com', [])
    h.deps.clock.advance(2 * 3600_000)
    const res = await me(h, cookie)
    expect(res.status).toBe(401)
    expect((await h.json(res)).error.message).toBe("You're no longer in the acme-team Netlify team.")
    // Leaving the team ends the connected apps too, without waiting for their own check.
    expect(
      await h.deps.store.listOAuthGrants((await h.deps.store.listUsers())[0]?.id ?? '', '2000-01-01'),
    ).toEqual([])
    expect((await later(h, conn)).status).toBe(401)
  })

  it('revokes an MCP grant whose re-check finds the person gone', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    h.deps.oauth.upstream.teamsOf.set('mia@acme.com', [ACME])
    const conn = await mcpConn(h, 'mia@acme.com')
    h.deps.oauth.upstream.teamsOf.set('mia@acme.com', [])
    h.deps.clock.advance(25 * 3600_000)
    const res = await later(h, conn)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.message).toBe("You're no longer in the acme-team Netlify team.")
    expect(h.deps.logs.join('\n')).toContain('team_check')
    expect(
      await h.deps.store.listOAuthGrants((await h.deps.store.listUsers())[0]?.id ?? '', '2000-01-01'),
    ).toEqual([])
  })

  it('ends the session when Netlify rejects the stored token (401)', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    const cookie = await signedIn(h, 'mia@acme.com', [ACME])
    for (const t of h.deps.oauth.upstream.tokens.keys()) h.deps.oauth.upstream.revoked.add(t)
    h.deps.clock.advance(25 * 3600_000)
    const res = await me(h, cookie)
    expect(res.status).toBe(401)
    expect((await h.json(res)).error.message).toMatch(/revoked/)
  })

  it('keeps people signed in through a Netlify outage for up to seven days', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    const b = browser(await signedIn(h, 'mia@acme.com', [ACME]))
    const conn = await mcpConn(h, 'mia@acme.com')
    h.deps.oauth.upstream.teamsError = 'unavailable'
    h.deps.clock.advance(25 * 3600_000)
    expect((await visit(h, b)).status).toBe(200)
    expect((await later(h, conn)).status).toBe(200)
    // Retries wait five minutes, so an outage doesn't slow every request.
    const calls = h.deps.oauth.upstream.teamCalls.length
    expect((await visit(h, b)).status).toBe(200)
    expect(h.deps.oauth.upstream.teamCalls).toHaveLength(calls)
    h.deps.clock.advance(GRACE_MS - 25 * 3600_000 - 60_000)
    expect((await visit(h, b)).status).toBe(200)
    expect((await later(h, conn)).status).toBe(200)
    h.deps.clock.advance(2 * 60_000)
    const res = await visit(h, b)
    expect(res.status).toBe(401)
    expect((await h.json(res)).error.message).toMatch(/for a week/)
    expect((await later(h, conn)).status).toBe(401)
  })

  it('a recovered check resets the clock', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    const b = browser(await signedIn(h, 'mia@acme.com', [ACME]))
    h.deps.oauth.upstream.teamsError = 'timeout'
    h.deps.clock.advance(3 * DAY)
    expect((await visit(h, b)).status).toBe(200)
    h.deps.oauth.upstream.teamsError = null
    h.deps.clock.advance(10 * 60_000)
    expect((await visit(h, b)).status).toBe(200)
    h.deps.oauth.upstream.teamsError = 'unavailable'
    h.deps.clock.advance(6 * DAY)
    expect((await visit(h, b)).status).toBe(200)
  })

  it('asks people to sign in again when a team rule is added after they signed in', async () => {
    const before = harness(NETLIFY)
    const cookie = await signedIn(before, 'mia@acme.com')
    const h = harness({ ...NETLIFY, ...TEAM }, { store: before.deps.store })
    const res = await me(h, cookie)
    expect(res.status).toBe(401)
    expect((await h.json(res)).error.message).toMatch(/Sign in with Netlify again/)
  })

  it('stores the upstream token encrypted, never in plain text or logs', async () => {
    const h = harness({ ...NETLIFY, ...TEAM })
    await signedIn(h, 'mia@acme.com', [ACME])
    await mcpToken(h, 'mia@acme.com')
    const tokens = [...h.deps.oauth.upstream.tokens.keys()]
    expect(tokens.length).toBeGreaterThan(1)
    const dump = JSON.stringify((h.deps.store as any).dump(), (_k, v: unknown) =>
      v instanceof Map ? [...v.values()] : v,
    )
    for (const t of tokens) {
      expect(dump).not.toContain(t)
      expect(h.deps.logs.join('\n')).not.toContain(t)
    }
    const session = [...(h.deps.store as any).dump().sessions.values()][0]
    expect(session.upstreamTokenEnc).toMatch(/^v1\./)
    expect(tokens).toContain(await openToken(h.deps, session.upstreamTokenEnc))
    const sealed = await sealToken(h.deps, 'secret-token')
    expect(sealed).not.toContain('secret-token')
    expect(await openToken(h.deps, sealed)).toBe('secret-token')
    expect(
      await openToken(
        h.deps,
        sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      ),
    ).toBeNull()
  })

  it('keeps no upstream token when there is no team rule', async () => {
    const h = harness(NETLIFY)
    await signedIn(h, 'mia@acme.com')
    const session = [...(h.deps.store as any).dump().sessions.values()][0]
    expect(session.upstreamTokenEnc).toBeNull()
  })
})

describe('Sign in with Netlify on Postgres', () => {
  it('signs in, links, single-signs-on, re-checks the team and signs out', async () => {
    const store = await pgStore()
    const { h, videoId } = await migrated(TEAM, store)
    const cookie = await signedIn(h, 'mia@acme.com', [ACME])
    expect((await h.json(await me(h, cookie))).id).toBe('u_member')
    expect((await h.json(await h.call('GET', '/api/v1/videos?owner=me', { as: cookie }))).items[0].id).toBe(
      videoId,
    )
    const a = await authorizeUrl(h)
    const conn = await consent(h, await send(h, 'GET', a.url, { headers: { cookie } }), a)
    expect((await rpc(h, conn.access, 'tools/list')).status).toBe(200)
    const grant = (await store.listOAuthGrants('u_member', '2000-01-01'))[0]
    expect(grant?.upstreamTokenEnc).toMatch(/^v1\./)
    const b = browser(cookie)
    h.deps.clock.advance(25 * 3600_000)
    expect((await visit(h, b)).status).toBe(200)
    expect(b.cookie).not.toBe(cookie)
    h.deps.oauth.upstream.teamsOf.set('mia@acme.com', [])
    h.deps.clock.advance(25 * 3600_000)
    expect((await later(h, conn)).status).toBe(401)
    expect((await visit(h, b)).status).toBe(401)
    const again = await signedIn(h, 'mia@acme.com', [ACME])
    expect(
      (await send(h, 'POST', '/auth/sign-out', { headers: { cookie: again, origin: SITE } })).status,
    ).toBe(204)
    expect((await me(h, again)).status).toBe(401)
    expect(await store.deleteExpiredSessions(h.deps.clock.now().toISOString())).toBeGreaterThan(0)
  })
})
