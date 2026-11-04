// The MCP's optional OAuth 2.1 authorization server: clients (Dynamic Client Registration and Client ID Metadata
// Documents), authorize → upstream sign-in → consent → code → tokens, and the connected-apps list.
// Public clients only (PKCE S256). Tokens are opaque, bound to this site's /mcp and stored as SHA-256 hashes.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Deps, McpOAuthConfig, OAuthPort } from '../deps.js'
import { emailDomain, liveIdentityUser } from '../domain/auth.js'
import { assertCan, type Principal } from '../domain/policy.js'
import type { OAuthGrantRow, OAuthTokenRow, UserRow } from '../domain/types.js'
import { safeEqual, sha256Hex as sha } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { OAUTH_USER_PREFIX, linkUpstreamUser, type Admission } from './accounts.js'
import { checkTeams, freshMembership, recheckMembership, teamLabel, teamRequired } from './membership.js'
import type { UpstreamUser } from './upstream.js'

export { OAUTH_USER_PREFIX }

export const ACCESS_TTL_SEC = 3600
const REFRESH_TTL_MS = 30 * 86400_000
const REQUEST_TTL_MS = 10 * 60_000
const CODE_TTL_MS = 5 * 60_000
const CIMD_TTL_MS = 10 * 60_000
/** Registered clients that no grant or request has used for this long are deleted by the sweep. */
export const CLIENT_IDLE_MS = 90 * 86400_000

export type OAuthDeps = Deps & { config: Deps['config'] & { mcpOAuth: McpOAuthConfig }; oauth: OAuthPort }

export function oauthEnabled(deps: Deps): deps is OAuthDeps {
  return deps.config.mcpOAuth !== null && deps.oauth !== null
}

export const resourceUrl = (deps: Deps) => `${deps.config.siteUrl}/mcp`
export const callbackUrl = (deps: Deps) => `${deps.config.siteUrl}/oauth/callback`
export const resourceMetadataUrl = (deps: Deps) =>
  `${deps.config.siteUrl}/.well-known/oauth-protected-resource`

/** An error in the shape of RFC 6749 §5.2 (token, registration and revocation endpoints). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 | 429 = 400,
  ) {
    super(description)
  }
}

const later = (deps: Deps, ms: number) => new Date(deps.clock.now().getTime() + ms).toISOString()

// ───── clients ─────

export interface OAuthClient {
  id: string
  name: string | null
  redirectUris: string[]
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function loopbackUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null
  const u = new URL(value)
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password || u.hash)
    return null
  return u
}

/** Redirect URIs a client may register: https, or http on a loopback address (native apps). */
export function registrableRedirectUri(value: string): boolean {
  if (value.length > 2048 || !URL.canParse(value)) return false
  const u = new URL(value)
  if (u.hash || u.username || u.password) return false
  return u.protocol === 'https:' || loopbackUrl(value) !== null
}

/** Exact match, except that a loopback redirect matches a registered one on any port (RFC 8252 §7.3). */
export function redirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true
  const asked = loopbackUrl(redirectUri)
  if (!asked) return false
  return client.redirectUris.some((r) => {
    const u = loopbackUrl(r)
    return (
      u !== null &&
      u.hostname === asked.hostname &&
      u.pathname === asked.pathname &&
      u.search === asked.search
    )
  })
}

const cimdCache = new Map<string, { client: OAuthClient; at: number }>()

export function resetOAuthCaches() {
  cimdCache.clear()
  registrations.length = 0
}

const CimdDocument = z.object({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
})

/**
 * A client whose id is the https URL of its metadata document. The host must be on the allowlist (the SSRF guard),
 * and the document must name that exact URL as its client_id and be a public client.
 */
async function cimdClient(deps: OAuthDeps, id: string): Promise<OAuthClient | null> {
  if (id.length > 512 || !URL.canParse(id)) return null
  const url = new URL(id)
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null
  if (!deps.config.mcpOAuth.cimdHosts.includes(url.hostname)) return null
  const hit = cimdCache.get(id)
  if (hit && Date.now() - hit.at < CIMD_TTL_MS) return hit.client
  const doc = CimdDocument.safeParse(await deps.oauth.fetchClientMetadata(id))
  if (!doc.success || doc.data.client_id !== id) return null
  if ((doc.data.token_endpoint_auth_method ?? 'none') !== 'none') return null
  if (!doc.data.redirect_uris.every(registrableRedirectUri)) return null
  const client = {
    id,
    name: doc.data.client_name?.trim() || url.hostname,
    redirectUris: doc.data.redirect_uris,
  }
  cimdCache.set(id, { client, at: Date.now() })
  return client
}

export async function resolveClient(deps: OAuthDeps, id: string): Promise<OAuthClient | null> {
  if (/^https:\/\//i.test(id)) return cimdClient(deps, id)
  if (id.length > 100) return null
  const row = await deps.store.getOAuthClient(id)
  return row ? { id: row.id, name: row.name, redirectUris: row.redirectUris } : null
}

const Registration = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
})

// A per-instance backstop against registration floods.
const registrations: number[] = []
const REGISTRATIONS_PER_MINUTE = 60

/** RFC 7591 registration. Every client is registered as public (no secret), whatever it asked for. */
export async function registerClient(deps: OAuthDeps, body: unknown) {
  const now = deps.clock.now()
  while (registrations.length > 0 && (registrations[0] ?? 0) < now.getTime() - 60_000) registrations.shift()
  if (registrations.length >= REGISTRATIONS_PER_MINUTE)
    throw new OAuthError('temporarily_unavailable', 'Too many registrations. Try again in a minute.', 429)
  const parsed = Registration.safeParse(body)
  if (!parsed.success) throw new OAuthError('invalid_client_metadata', 'The client metadata is not valid.')
  const m = parsed.data
  if (!m.redirect_uris.every(registrableRedirectUri))
    throw new OAuthError(
      'invalid_redirect_uri',
      'Redirect URIs must use https, or http on localhost, 127.0.0.1 or [::1].',
    )
  if (m.grant_types?.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))
    throw new OAuthError(
      'invalid_client_metadata',
      'Only authorization_code and refresh_token are supported.',
    )
  if (m.response_types?.some((r) => r !== 'code'))
    throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.')
  registrations.push(now.getTime())
  const row = {
    id: `nvc_${deps.ids.secret(16)}`,
    name: m.client_name ?? null,
    redirectUris: m.redirect_uris,
    createdAt: now.toISOString(),
  }
  await deps.store.insertOAuthClient(row)
  deps.log.info('oauth.client_registered', { clientId: row.id, redirectUris: row.redirectUris.length })
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(row.name ? { client_name: row.name } : {}),
    redirect_uris: row.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

// ───── authorize, callback, consent ─────

export type Outcome =
  | { kind: 'redirect'; url: string }
  | { kind: 'page'; status: 400 | 502; title: string; message: string }
  | { kind: 'consent'; consent: string; clientName: string; clientHost: string; email: string }

const page = (title: string, message: string, status: 400 | 502 = 400): Outcome => ({
  kind: 'page',
  status,
  title,
  message,
})
const EXPIRED = page(
  'This sign-in has expired',
  'It was already used or took too long. Start connecting again from your app.',
)

function back(deps: Deps, redirectUri: string, params: Record<string, string | null>): Outcome {
  const url = new URL(redirectUri)
  const all: Record<string, string | null> = { ...params, iss: deps.config.siteUrl }
  for (const [k, v] of Object.entries(all)) if (v !== null) url.searchParams.set(k, v)
  return { kind: 'redirect', url: url.toString() }
}

/** A person already signed in to the web app (Sign in with Netlify), for single sign-on at /oauth/authorize. */
export interface SignedIn {
  row: UserRow
  upstreamTokenEnc: string | null
  membershipCheckedAt: string | null
}

/**
 * GET /oauth/authorize: validates the request, remembers it for ten minutes and sends the browser upstream. With a
 * web session (`signedIn`), it skips the upstream round-trip and asks that person for consent straight away.
 */
export async function startAuthorization(
  deps: OAuthDeps,
  params: URLSearchParams,
  signedIn?: () => Promise<SignedIn | null>,
): Promise<Outcome> {
  const one = (k: string) => {
    const v = params.getAll(k)
    return v.length === 1 && v[0] ? v[0] : null
  }
  const clientId = one('client_id')
  const redirectUri = one('redirect_uri')
  if (!clientId || !redirectUri)
    return page('This link is incomplete', 'The app sent no client_id or redirect_uri. Try connecting again.')
  const client = await resolveClient(deps, clientId)
  if (!client)
    return page('Unknown app', 'This app is not registered with the video agent. Try connecting again.')
  // Errors are only ever sent to a redirect URI the client registered.
  if (!redirectAllowed(client, redirectUri))
    return page('Unknown return address', "The app's redirect_uri is not one it registered.")
  const state = one('state')
  const fail = (error: string, description: string) =>
    back(deps, redirectUri, { error, error_description: description, state })
  if (!state || state.length > 1024) return fail('invalid_request', 'A single state parameter is required.')
  if (one('response_type') !== 'code') return fail('unsupported_response_type', 'Use response_type=code.')
  const challenge = one('code_challenge')
  if (one('code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  const resource = one('resource')
  if (resource !== resourceUrl(deps))
    return fail('invalid_target', `The resource parameter must be ${resourceUrl(deps)}.`)
  const upstreamState = deps.ids.secret(32)
  const request = {
    id: sha(upstreamState),
    clientId: client.id,
    clientName: client.name,
    redirectUri,
    resource,
    state,
    codeChallenge: challenge,
    userId: null,
    consentHash: null,
    codeHash: null,
    grantId: null,
    createdAt: deps.clock.now().toISOString(),
    expiresAt: later(deps, REQUEST_TTL_MS),
    usedAt: null,
  }
  const person = signedIn ? await signedIn() : null
  if (person) {
    const domains = deps.config.mcpOAuth.allowedEmailDomains
    if (domains && !domains.includes(emailDomain(person.row.email)))
      return fail('access_denied', `Only ${domains.join(', ')} addresses can connect.`)
    const consent = deps.ids.secret(32)
    await deps.store.insertOAuthRequest({
      ...request,
      userId: person.row.id,
      consentHash: sha(consent),
      upstreamTokenEnc: person.upstreamTokenEnc,
      membershipCheckedAt: person.membershipCheckedAt,
    })
    deps.log.info('oauth.single_sign_on', { clientId: client.id, userId: person.row.id })
    return {
      kind: 'consent',
      consent,
      clientName: client.name ?? 'An app',
      clientHost: new URL(redirectUri).host,
      email: person.row.email,
    }
  }
  await deps.store.insertOAuthRequest(request)
  return {
    kind: 'redirect',
    url: deps.oauth.upstream.authorizeUrl({ state: upstreamState, redirectUri: callbackUrl(deps) }),
  }
}

/** GET /oauth/callback: the upstream sign-in came back. Checks the person and asks for consent. */
export async function finishUpstream(deps: OAuthDeps, params: URLSearchParams): Promise<Outcome> {
  const upstreamState = params.get('state')
  if (!upstreamState || upstreamState.length > 200) return EXPIRED
  const req = await deps.store.getOAuthRequest(sha(upstreamState))
  const now = deps.clock.now().toISOString()
  if (!req || req.userId || req.usedAt || req.expiresAt <= now) return EXPIRED
  const deny = async (description: string) => {
    await deps.store.updateOAuthRequest(req.id, { usedAt: now })
    return back(deps, req.redirectUri, {
      error: 'access_denied',
      error_description: description,
      state: req.state,
    })
  }
  const code = params.get('code')
  if (params.get('error') || !code) return deny('Sign-in was cancelled.')
  let user: UpstreamUser
  try {
    user = await deps.oauth.upstream.exchange(code, callbackUrl(deps))
  } catch (e) {
    deps.log.warn('oauth.upstream_failed', { clientId: req.clientId, error: e })
    await deps.store.updateOAuthRequest(req.id, { usedAt: now })
    return back(deps, req.redirectUri, {
      error: 'temporarily_unavailable',
      error_description: 'Could not verify the sign-in right now. Try again shortly.',
      state: req.state,
    })
  }
  const mapped = await mapIdentity(deps, user)
  if (!mapped.ok) {
    deps.log.info('oauth.denied', {
      clientId: req.clientId,
      domain: emailDomain(user.email),
      why: mapped.code,
    })
    return deny(mapped.reason)
  }
  if (teamRequired(deps)) {
    const verdict = await checkTeams(deps, user.accessToken)
    if (verdict !== 'member') {
      deps.log.info('oauth.denied', { clientId: req.clientId, userId: mapped.row.id, why: `team_${verdict}` })
      if (verdict === 'unavailable') {
        await deps.store.updateOAuthRequest(req.id, { usedAt: now })
        return back(deps, req.redirectUri, {
          error: 'temporarily_unavailable',
          error_description: 'Could not check your Netlify team membership right now. Try again shortly.',
          state: req.state,
        })
      }
      return deny(`You're not in the ${teamLabel(deps)} Netlify team.`)
    }
  }
  const consent = deps.ids.secret(32)
  await deps.store.updateOAuthRequest(req.id, {
    userId: mapped.row.id,
    consentHash: sha(consent),
    ...(await freshMembership(deps, user.accessToken)),
  })
  return {
    kind: 'consent',
    consent,
    clientName: req.clientName ?? 'An app',
    clientHost: new URL(req.redirectUri).host,
    email: mapped.row.email,
  }
}

/**
 * The person's account, shared with the web app (src/auth/accounts.ts): the linked Netlify identity, else the
 * verified email's existing account (same role, privacy and ownership). A first-time email that passes the domain
 * rule gets an account with the default role, as web sign-up does.
 */
function mapIdentity(deps: OAuthDeps, u: UpstreamUser) {
  const domains = deps.config.mcpOAuth.allowedEmailDomains
  const admission: Admission = {
    domains,
    adminsMayJoin: false,
    domainReason: domains ? `Only ${domains.join(', ')} addresses can connect.` : '',
    noAccountReason: 'This video agent is invite-only. Accept your invite and sign in to the web app first.',
  }
  return linkUpstreamUser(deps, deps.config.mcpOAuth.provider, u, admission)
}

/** POST /oauth/consent: Allow issues a one-time code back to the client; Deny tells it access_denied. */
export async function decideConsent(deps: OAuthDeps, consent: string, allow: boolean): Promise<Outcome> {
  if (!consent || consent.length > 200) return EXPIRED
  return deps.store.tx(async (repo) => {
    const req = await repo.findOAuthRequest({ consentHash: sha(consent) }, { lock: true })
    const now = deps.clock.now().toISOString()
    if (!req?.userId || req.usedAt || req.codeHash || req.expiresAt <= now) return EXPIRED
    if (!allow) {
      await repo.updateOAuthRequest(req.id, { consentHash: null, usedAt: now })
      return back(deps, req.redirectUri, {
        error: 'access_denied',
        error_description: 'You declined.',
        state: req.state,
      })
    }
    const code = `nvac_${deps.ids.secret(32)}`
    await repo.updateOAuthRequest(req.id, {
      consentHash: null,
      codeHash: sha(code),
      expiresAt: later(deps, CODE_TTL_MS),
    })
    return back(deps, req.redirectUri, { code, state: req.state })
  })
}

// ───── tokens ─────

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

async function issueTokens(deps: Deps, repo: Repo, grantId: string): Promise<TokenResponse> {
  const now = deps.clock.now().toISOString()
  const access = `nvat_${deps.ids.secret(32)}`
  const refresh = `nvrt_${deps.ids.secret(32)}`
  const row = (value: string, kind: OAuthTokenRow['kind'], ms: number): OAuthTokenRow => ({
    hash: sha(value),
    kind,
    grantId,
    createdAt: now,
    expiresAt: later(deps, ms),
    usedAt: null,
  })
  await repo.insertOAuthToken(row(access, 'access', ACCESS_TTL_SEC * 1000))
  await repo.insertOAuthToken(row(refresh, 'refresh', REFRESH_TTL_MS))
  await repo.updateOAuthGrant(grantId, { expiresAt: later(deps, REFRESH_TTL_MS) })
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refresh,
    scope: 'mcp',
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge)
}

type Granted = { tokens: TokenResponse } | { error: string; revoked?: string }

const INVALID_GRANT = 'The grant is invalid, expired or already used.'

/** POST /oauth/token: authorization_code (with PKCE) and refresh_token (rotating, with reuse detection). */
export async function tokenRequest(
  deps: OAuthDeps,
  form: URLSearchParams,
  basicClientId: string | null,
): Promise<TokenResponse> {
  const clientId = form.get('client_id') ?? basicClientId
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401)
  const resource = form.get('resource')
  if (resource !== null && resource !== resourceUrl(deps))
    throw new OAuthError('invalid_target', `The resource parameter must be ${resourceUrl(deps)}.`)
  const grantType = form.get('grant_type')
  let result: Granted
  if (grantType === 'authorization_code') result = await exchangeCode(deps, form, clientId)
  else if (grantType === 'refresh_token') result = await refreshTokens(deps, form, clientId)
  else throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
  if ('error' in result) {
    deps.log.info('oauth.token_refused', {
      clientId,
      grantType,
      why: result.error,
      revokedGrant: result.revoked,
    })
    throw new OAuthError('invalid_grant', INVALID_GRANT)
  }
  return result.tokens
}

async function exchangeCode(deps: OAuthDeps, form: URLSearchParams, clientId: string): Promise<Granted> {
  const code = form.get('code')
  const verifier = form.get('code_verifier')
  const redirectUri = form.get('redirect_uri')
  if (!code || !verifier || !redirectUri)
    throw new OAuthError('invalid_request', 'code, code_verifier and redirect_uri are required.')
  return deps.store.tx(async (repo): Promise<Granted> => {
    const req = await repo.findOAuthRequest({ codeHash: sha(code) }, { lock: true })
    const now = deps.clock.now().toISOString()
    if (!req?.userId) return { error: 'unknown_code' }
    if (req.usedAt) {
      // A code used twice may have leaked: whatever it was traded for is revoked (RFC 6749 §4.1.2).
      if (req.grantId) await repo.updateOAuthGrant(req.grantId, { revokedAt: now })
      return { error: 'code_reused', ...(req.grantId ? { revoked: req.grantId } : {}) }
    }
    if (req.expiresAt <= now) return { error: 'code_expired' }
    if (req.clientId !== clientId) return { error: 'client_mismatch' }
    if (req.redirectUri !== redirectUri) return { error: 'redirect_mismatch' }
    if (!pkceMatches(verifier, req.codeChallenge)) return { error: 'pkce_mismatch' }
    const user = await repo.getUser(req.userId)
    if (!user || user.disabledAt) return { error: 'user_disabled' }
    const grant: OAuthGrantRow = {
      id: `grt_${deps.ids.secret(16)}`,
      userId: user.id,
      clientId: req.clientId,
      clientName: req.clientName,
      resource: req.resource,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: later(deps, REFRESH_TTL_MS),
      revokedAt: null,
      upstreamTokenEnc: req.upstreamTokenEnc ?? null,
      membershipCheckedAt: req.membershipCheckedAt ?? null,
      membershipFailedAt: null,
    }
    await repo.insertOAuthGrant(grant)
    await repo.updateOAuthRequest(req.id, { usedAt: now, grantId: grant.id, upstreamTokenEnc: null })
    deps.log.info('oauth.grant_created', { grantId: grant.id, clientId: grant.clientId, userId: user.id })
    return { tokens: await issueTokens(deps, repo, grant.id) }
  })
}

async function refreshTokens(deps: OAuthDeps, form: URLSearchParams, clientId: string): Promise<Granted> {
  const refresh = form.get('refresh_token')
  if (!refresh) throw new OAuthError('invalid_request', 'refresh_token is required.')
  return deps.store.tx(async (repo): Promise<Granted> => {
    const tok = await repo.getOAuthToken(sha(refresh), { lock: true })
    const now = deps.clock.now().toISOString()
    if (tok?.kind !== 'refresh') return { error: 'unknown_token' }
    const grant = await repo.getOAuthGrant(tok.grantId)
    if (!grant || grant.revokedAt) return { error: 'grant_revoked' }
    if (grant.clientId !== clientId) return { error: 'client_mismatch' }
    if (tok.usedAt) {
      // A rotated refresh token came back: someone holds a copy, so the whole grant ends.
      await repo.updateOAuthGrant(grant.id, { revokedAt: now })
      return { error: 'refresh_reused', revoked: grant.id }
    }
    if (tok.expiresAt <= now) return { error: 'token_expired' }
    const user = await repo.getUser(grant.userId)
    if (!user || user.disabledAt) return { error: 'user_disabled' }
    await repo.updateOAuthToken(tok.hash, { usedAt: now })
    return { tokens: await issueTokens(deps, repo, grant.id) }
  })
}

/** POST /oauth/revoke (RFC 7009): ends the token's grant when the client it was issued to asks. Always succeeds. */
export async function revokeToken(deps: OAuthDeps, form: URLSearchParams, basicClientId: string | null) {
  const token = form.get('token')
  if (!token) throw new OAuthError('invalid_request', 'token is required.')
  if (token.length > 200) return
  const tok = await deps.store.getOAuthToken(sha(token))
  const grant = tok ? await deps.store.getOAuthGrant(tok.grantId) : null
  if (!grant || grant.revokedAt || grant.clientId !== (form.get('client_id') ?? basicClientId)) return
  await deps.store.updateOAuthGrant(grant.id, { revokedAt: deps.clock.now().toISOString() })
  deps.log.info('oauth.grant_revoked', { grantId: grant.id, by: 'client' })
}

/** The person behind an OAuth access token on /mcp, with their current role. */
export async function principalFromAccessToken(deps: Deps, token: string): Promise<Principal> {
  const invalid = () => new ApiError('unauthorized', 'Invalid or expired access token.')
  if (!/^nvat_[A-Za-z0-9_-]{20,100}$/.test(token)) throw invalid()
  const now = deps.clock.now().toISOString()
  const tok = await deps.store.getOAuthToken(sha(token))
  if (tok?.kind !== 'access' || tok.expiresAt <= now) throw invalid()
  const grant = await deps.store.getOAuthGrant(tok.grantId)
  if (!grant || grant.revokedAt || grant.expiresAt <= now || grant.resource !== resourceUrl(deps))
    throw invalid()
  const row = await deps.store.getUser(grant.userId)
  if (!row) throw invalid()
  if (row.disabledAt) throw new ApiError('unauthorized', 'Your account has been disabled by an admin.')
  const domains = deps.config.mcpOAuth?.allowedEmailDomains
  if (domains && !domains.includes(emailDomain(row.email)))
    throw new ApiError('unauthorized', 'Your email address is no longer in an allowed domain.')
  if (!row.id.startsWith(OAUTH_USER_PREFIX) && deps.config.authProvider === 'identity') {
    const live = await liveIdentityUser(deps, row.id)
    if (!live?.confirmed) throw new ApiError('unauthorized', 'Your account no longer exists.')
  }
  const check = await recheckMembership(deps, grant)
  if (!check.ok) {
    await deps.store.updateOAuthGrant(grant.id, { revokedAt: now })
    if (check.why === 'not_member') {
      await deps.store.revokeOAuthGrants(row.id, now)
      await deps.store.revokeUserSessions(row.id, now)
    }
    deps.log.info('oauth.grant_revoked', { grantId: grant.id, by: 'team_check', why: check.why })
    throw new ApiError('unauthorized', check.reason)
  }
  if (check.patch) await deps.store.updateOAuthGrant(grant.id, check.patch)
  if (!grant.lastUsedAt || now.slice(0, 15) !== grant.lastUsedAt.slice(0, 15))
    await deps.store.updateOAuthGrant(grant.id, { lastUsedAt: now })
  return {
    kind: 'oauth',
    userId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    apiKeyId: null,
    oauthGrantId: grant.id,
    oauthClientId: grant.clientId,
  }
}

// ───── connected apps (the Keys page) ─────

export const grantDto = (g: OAuthGrantRow) => ({
  id: g.id,
  clientId: g.clientId,
  clientName: g.clientName ?? 'Unnamed app',
  createdAt: g.createdAt,
  lastUsedAt: g.lastUsedAt,
})

export async function listGrants(deps: Deps, p: Principal) {
  if (!oauthEnabled(deps)) throw new ApiError('not_found', 'OAuth is not enabled on this video agent.')
  assertCan(p, 'keys:manage')
  return (await deps.store.listOAuthGrants(p.userId, deps.clock.now().toISOString())).map(grantDto)
}

export async function revokeGrant(deps: Deps, p: Principal, id: string) {
  if (!oauthEnabled(deps)) throw new ApiError('not_found', 'OAuth is not enabled on this video agent.')
  assertCan(p, 'keys:manage')
  const g = await deps.store.getOAuthGrant(id)
  if (!g || g.revokedAt || (g.userId !== p.userId && p.role !== 'admin'))
    throw new ApiError('not_found', 'Connected app not found.')
  await deps.store.updateOAuthGrant(id, { revokedAt: deps.clock.now().toISOString() })
  deps.log.info('oauth.grant_revoked', { grantId: id, by: p.userId })
}
