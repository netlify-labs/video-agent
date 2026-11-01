// The Netlify team rule (NETLIFY_REQUIRED_TEAM): checked at every Netlify sign-in, web or MCP, and again at most
// once a day while a web session or MCP grant is used, with the person's own upstream token (stored encrypted).
import type { Deps } from '../deps.js'
import { getSettings } from '../domain/settings.js'
import { decrypt, deriveKey, encrypt } from '../lib/crypto.js'
import { UpstreamError } from './upstream.js'

/** A membership that passed is trusted for a day. */
export const RECHECK_MS = 24 * 3600_000
/** While Netlify can't answer, people stay signed in for up to a week after the last good check. */
export const GRACE_MS = 7 * 86400_000
/** After a failed attempt, the next try waits this long, so an outage doesn't slow every request. */
const RETRY_MS = 5 * 60_000

export const teamRequired = (deps: Deps) => deps.config.netlifyRequiredTeams.length > 0
export const teamLabel = (deps: Deps) => deps.config.netlifyRequiredTeams.join(' or ')

export type TeamVerdict = 'member' | 'not_member' | 'revoked' | 'unavailable'

/** Whether the token's owner is in one of the required teams, matched on account id or slug. */
export async function checkTeams(deps: Deps, accessToken: string | undefined): Promise<TeamVerdict> {
  if (!deps.oauth || !accessToken) return 'revoked'
  const wanted = new Set(deps.config.netlifyRequiredTeams)
  try {
    const teams = await deps.oauth.upstream.teams(accessToken)
    return teams.some((t) => wanted.has(t.id.toLowerCase()) || (t.slug && wanted.has(t.slug.toLowerCase())))
      ? 'member'
      : 'not_member'
  } catch (e) {
    if (e instanceof UpstreamError && e.code === 'rejected') return 'revoked'
    deps.log.warn('auth.team_check_failed', { error: e })
    return 'unavailable'
  }
}

const tokenKey = async (deps: Deps) =>
  deriveKey((await getSettings(deps)).dataEncryptionKey, 'upstream-token:v1')

/** AES-256-GCM with a key of its own, derived from the settings' data encryption key. */
export async function sealToken(deps: Deps, token: string): Promise<string> {
  return encrypt(await tokenKey(deps), token)
}

export async function openToken(deps: Deps, sealed: string): Promise<string | null> {
  try {
    return decrypt(await tokenKey(deps), sealed)
  } catch {
    return null
  }
}

/** What a session or grant keeps for the re-check. */
export interface Membership {
  upstreamTokenEnc?: string | null
  membershipCheckedAt?: string | null
  membershipFailedAt?: string | null
}

/** The fields a new session or grant starts with: the sealed token and a check that just passed. */
export async function freshMembership(deps: Deps, accessToken: string | undefined) {
  if (!teamRequired(deps) || !accessToken) return { upstreamTokenEnc: null, membershipCheckedAt: null }
  return {
    upstreamTokenEnc: await sealToken(deps, accessToken),
    membershipCheckedAt: deps.clock.now().toISOString(),
  }
}

export type Recheck =
  { ok: true; patch: Membership | null } | { ok: false; why: TeamVerdict | 'no_token'; reason: string }

/** Re-checks the team rule when a day has passed. A patch is returned for the caller to store. */
export async function recheckMembership(deps: Deps, m: Membership): Promise<Recheck> {
  if (!teamRequired(deps)) return { ok: true, patch: null }
  const now = deps.clock.now()
  const since = (iso: string | null | undefined) => (iso ? now.getTime() - Date.parse(iso) : Infinity)
  if (since(m.membershipCheckedAt) < RECHECK_MS) return { ok: true, patch: null }
  const team = teamLabel(deps)
  const token = m.upstreamTokenEnc ? await openToken(deps, m.upstreamTokenEnc) : null
  if (!token)
    return {
      ok: false,
      why: 'no_token',
      reason: `Sign in with Netlify again to confirm you're in the ${team} Netlify team.`,
    }
  const inGrace = since(m.membershipCheckedAt) < GRACE_MS
  if (inGrace && since(m.membershipFailedAt) < RETRY_MS) return { ok: true, patch: null }
  const verdict = await checkTeams(deps, token)
  if (verdict === 'member')
    return { ok: true, patch: { membershipCheckedAt: now.toISOString(), membershipFailedAt: null } }
  if (verdict === 'unavailable') {
    if (inGrace) return { ok: true, patch: { membershipFailedAt: now.toISOString() } }
    return {
      ok: false,
      why: verdict,
      reason: `Netlify couldn't confirm you're in the ${team} Netlify team for a week. Sign in again.`,
    }
  }
  return {
    ok: false,
    why: verdict,
    reason:
      verdict === 'not_member'
        ? `You're no longer in the ${team} Netlify team.`
        : `Your Netlify sign-in was revoked, so we can't confirm you're in the ${team} Netlify team. Sign in again.`,
  }
}
