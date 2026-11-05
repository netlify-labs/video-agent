// Google OAuth and the YouTube Data API for the YouTube destination (publish destinations §4). One scope:
// youtube.force-ssl covers videos.insert, captions.insert, thumbnails.set, videos.update and videos.delete. Refresh
// tokens are stored encrypted; access tokens are fetched when needed and never stored.
import type { Deps } from '../../deps.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { getSettings } from '../settings.js'
import type { DestinationConnectionRow } from '../types.js'

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const API = 'https://www.googleapis.com/youtube/v3'
export const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3'

export const redirectUri = (deps: Pick<Deps, 'config'>) => `${deps.config.siteUrl}/auth/google/callback`

function google(deps: Pick<Deps, 'config'>) {
  if (!deps.config.google) throw new ApiError('not_found', 'YouTube is not set up on this video agent.')
  return deps.config.google
}

export function authorizeUrl(deps: Pick<Deps, 'config'>, state: string, challenge: string): string {
  const g = google(deps)
  const q = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: redirectUri(deps),
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${AUTH_URL}?${q.toString()}`
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

export async function exchangeCode(deps: Pick<Deps, 'config' | 'fetch'>, code: string, verifier: string) {
  const g = google(deps)
  const res = await deps.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      code,
      client_id: g.clientId,
      client_secret: g.clientSecret,
      redirect_uri: redirectUri(deps),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    scope?: string
    error?: string
  }
  if (!res.ok || !j.access_token)
    throw new ApiError('upstream_error', 'Google refused the sign-in. Try again.')
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    scopes: (j.scope ?? '').split(' '),
  }
}

/** The connected channel: its id and title. */
export async function myChannel(deps: Pick<Deps, 'fetch'>, accessToken: string) {
  const res = await deps.fetch(`${API}/channels?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const j = (await res.json().catch(() => ({}))) as { items?: { id: string; snippet?: { title?: string } }[] }
  const ch = j.items?.[0]
  if (!res.ok || !ch) throw new ApiError('conflict', 'That Google account has no YouTube channel.')
  return { id: ch.id, title: ch.snippet?.title ?? ch.id }
}

/** An access token for a connection; a revoked or expired grant marks the connection for reconnecting. */
export async function accessToken(
  deps: Pick<Deps, 'config' | 'fetch' | 'store' | 'ids' | 'clock' | 'blobs'>,
  conn: DestinationConnectionRow,
): Promise<string> {
  const g = google(deps)
  const { dataEncryptionKey } = await getSettings(deps)
  const res = await deps.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: decrypt(dataEncryptionKey, conn.tokenEnc),
      grant_type: 'refresh_token',
    }),
  })
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string }
  if (res.ok && j.access_token) return j.access_token
  if (j.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
    await deps.store.updateDestinationConnection(conn.id, {
      status: 'reconnect',
      updatedAt: deps.clock.now().toISOString(),
    })
    throw new ReconnectError()
  }
  throw new Error(`token refresh failed (${res.status})`)
}

export class ReconnectError extends Error {
  constructor() {
    super('Reconnect YouTube')
  }
}

export async function revoke(
  deps: Pick<Deps, 'fetch' | 'store' | 'ids' | 'clock' | 'blobs'>,
  conn: DestinationConnectionRow,
) {
  const { dataEncryptionKey } = await getSettings(deps)
  try {
    await deps.fetch(`${REVOKE_URL}?${form({ token: decrypt(dataEncryptionKey, conn.tokenEnc) })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
  } catch {
    // Best effort: the row is deleted either way.
  }
}

export async function encryptToken(deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>, token: string) {
  const { dataEncryptionKey } = await getSettings(deps)
  return encrypt(dataEncryptionKey, token)
}

/** Google's error reason (quotaExceeded, uploadLimitExceeded, forbidden, …) and message from a JSON error body. */
export async function googleError(res: Response): Promise<{ reason: string; message: string }> {
  const j = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[]; status?: string }
  }
  return {
    reason: j.error?.errors?.[0]?.reason ?? j.error?.status ?? `http_${res.status}`,
    message: j.error?.message ?? `YouTube answered ${res.status}.`,
  }
}

/** Seconds until the next midnight in America/Los_Angeles, when YouTube's daily quota resets. */
export function secondsToQuotaReset(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return 24 * 3600 - (n('hour') * 3600 + n('minute') * 60 + n('second'))
}
