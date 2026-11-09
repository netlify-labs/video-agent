// The identity provider people sign in with when an MCP client connects over OAuth. One implementation,
// Netlify OAuth; another (generic OIDC, say) only has to implement UpstreamIdentity.
import { z } from 'zod'
import type { McpOAuthConfig } from '../deps.js'

export interface UpstreamIdentity {
  /** Where to send the browser; the provider comes back to redirectUri with `code` and `state`. */
  authorizeUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string
  /** Trades the callback's code for the signed-in person. Throws UpstreamError. */
  exchange(code: string, redirectUri: string): Promise<UpstreamUser>
  /** The teams the token's owner belongs to. Throws UpstreamError ('rejected' when the token no longer works). */
  teams(accessToken: string): Promise<UpstreamTeam[]>
}

export interface UpstreamUser {
  subject: string
  email: string
  emailVerified: boolean
  /** The upstream access token, used only for team checks. Never logged. */
  accessToken?: string
}

export interface UpstreamTeam {
  id: string
  slug: string | null
  name: string | null
}

export class UpstreamError extends Error {
  constructor(
    readonly code: 'timeout' | 'rejected' | 'unavailable' | 'malformed',
    readonly operation: string,
  ) {
    super(`Upstream ${operation} failed: ${code}.`)
  }
}

const TIMEOUT_MS = 8_000
const MAX_BYTES = 256 * 1024

/** A GET or POST with a time limit, no redirects and a size limit, parsed as JSON. */
export async function boundedJson(
  operation: string,
  url: string,
  init: RequestInit,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    throw new UpstreamError(
      e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unavailable',
      operation,
    )
  }
  if (res.status >= 500 || res.status === 429) throw new UpstreamError('unavailable', operation)
  if (!res.ok) throw new UpstreamError('rejected', operation)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes)
    throw new UpstreamError('malformed', operation)
  const text = await res.text().catch(() => '')
  if (!text || Buffer.byteLength(text) > maxBytes) throw new UpstreamError('malformed', operation)
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError('malformed', operation)
  }
}

const NETLIFY_AUTHORIZE = 'https://app.netlify.com/authorize'
const NETLIFY_TOKEN = 'https://api.netlify.com/oauth/token'
const NETLIFY_USER = 'https://api.netlify.com/api/v1/user'
const NETLIFY_ACCOUNTS = 'https://api.netlify.com/api/v1/accounts'

const NetlifyToken = z.object({ access_token: z.string().min(1).max(8192) })
const NetlifyUser = z.object({ id: z.string().min(1).max(256), email: z.string().min(3).max(320) })
const NetlifyAccounts = z
  .array(
    z.object({
      id: z.string().min(1).max(256),
      slug: z.string().max(256).nullish(),
      name: z.string().max(512).nullish(),
    }),
  )
  .max(1000)

export function netlifyUpstream(
  config: Pick<McpOAuthConfig, 'clientId' | 'clientSecret'>,
  fetchImpl?: typeof fetch,
): UpstreamIdentity {
  const opts = fetchImpl ? { fetchImpl } : {}
  return {
    // Netlify OAuth apps are confidential clients (the secret is sent on exchange), so PKCE isn't passed.
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(NETLIFY_AUTHORIZE)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchange(code, redirectUri) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      })
      const token = NetlifyToken.safeParse(
        await boundedJson(
          'token',
          NETLIFY_TOKEN,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
            body,
          },
          opts,
        ),
      )
      if (!token.success) throw new UpstreamError('malformed', 'token')
      const user = NetlifyUser.safeParse(
        await boundedJson(
          'user',
          NETLIFY_USER,
          { headers: { accept: 'application/json', authorization: `Bearer ${token.data.access_token}` } },
          opts,
        ),
      )
      if (!user.success) throw new UpstreamError('malformed', 'user')
      // Netlify's user record has no verification flag; a Netlify sign-in is taken as proof of the address,
      // as other Netlify OAuth servers do.
      return {
        subject: user.data.id,
        email: user.data.email.trim().toLowerCase(),
        emailVerified: true,
        accessToken: token.data.access_token,
      }
    },
    async teams(accessToken) {
      // Account records are large (capabilities, billing), so the list gets a bigger size limit.
      const accounts = NetlifyAccounts.safeParse(
        await boundedJson(
          'accounts',
          NETLIFY_ACCOUNTS,
          { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } },
          { ...opts, maxBytes: 8 * 1024 * 1024 },
        ),
      )
      if (!accounts.success) throw new UpstreamError('malformed', 'accounts')
      return accounts.data.map((a) => ({ id: a.id, slug: a.slug ?? null, name: a.name ?? null }))
    },
  }
}
