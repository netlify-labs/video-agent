// One account per person: a Netlify sign-in (web or MCP) resolves to the same user row through user_identities,
// then by verified email, merging a row an earlier MCP sign-in created into the person's Identity account.
import type { Deps } from '../deps.js'
import { emailDomain } from '../domain/auth.js'
import type { UserRow } from '../domain/types.js'
import type { UpstreamUser } from './upstream.js'

/** User rows created by an OAuth sign-in (not backed by Netlify Identity) have ids with this prefix. */
export const OAUTH_USER_PREFIX = 'oauth_'

/** Who may sign in: `domains` admits new people at those domains; null admits only people with an account. */
export interface Admission {
  domains: string[] | null
  /** Under invite-only, ADMIN_EMAILS may still create their account (there are no invites without Identity). */
  adminsMayJoin: boolean
  domainReason: string
  noAccountReason: string
}

export type Linked = { ok: true; row: UserRow } | { ok: false; code: string; reason: string }

const isOAuthRow = (u: UserRow) => u.id.startsWith(OAUTH_USER_PREFIX)
const byLastSeen = (a: UserRow, b: UserRow) => b.lastSeenAt.localeCompare(a.lastSeenAt)

/** The admission rule for Sign in with Netlify on the web, from ALLOWED_EMAIL_DOMAINS. */
export function webAdmission(deps: Deps): Admission | null {
  const mode = deps.config.allowedEmailDomains
  if (mode === null) return null
  return {
    domains: mode === 'invite-only' ? null : mode,
    adminsMayJoin: mode === 'invite-only',
    domainReason: Array.isArray(mode) ? `Sign-ups are limited to ${mode.join(', ')} addresses.` : '',
    noAccountReason: 'This video agent is invite-only. Ask an admin to add you.',
  }
}

/** Moves everything `from` has to `into` in one transaction; `into` keeps its role, and stays disabled if either was. */
export async function mergeUsers(deps: Deps, fromId: string, intoId: string) {
  await deps.store.tx(async (repo) => {
    const from = await repo.getUser(fromId)
    const into = await repo.getUser(intoId)
    if (!from || !into || from.id === into.id) return
    await repo.updateUser(into.id, {
      disabledAt: into.disabledAt ?? from.disabledAt,
      lastSeenAt: from.lastSeenAt > into.lastSeenAt ? from.lastSeenAt : into.lastSeenAt,
    })
    await repo.mergeUser(from.id, into.id)
  })
  deps.log.info('auth.user_merged', { from: fromId, into: intoId })
}

/**
 * The person's user row for an upstream sign-in: the linked identity, else the row an earlier MCP sign-in created
 * (`oauth_<provider>_<subject>`), else a row with the same verified email (Identity rows first). When the person
 * has both an Identity row and OAuth rows for that email, the OAuth rows are merged into the Identity row. With no
 * row at all, one is created if the admission rule allows it.
 */
export async function linkUpstreamUser(
  deps: Deps,
  provider: string,
  u: UpstreamUser,
  admission: Admission | null,
): Promise<Linked> {
  if (!u.emailVerified)
    return { ok: false, code: 'unverified', reason: 'Your email address is not verified.' }
  if (!admission)
    return {
      ok: false,
      code: 'unconfigured',
      reason: 'This deployment has no admission rule configured yet.',
    }
  const email = u.email.trim().toLowerCase()
  if (admission.domains && !admission.domains.includes(emailDomain(email)))
    return { ok: false, code: 'domain', reason: admission.domainReason }

  const users = await deps.store.listUsers()
  const sameEmail = users.filter((r) => r.email === email)
  const identityRow = sameEmail.filter((r) => !isOAuthRow(r)).sort(byLastSeen)[0]
  const link = await deps.store.getUserIdentity(provider, u.subject)
  const linked = link ? users.find((r) => r.id === link.userId) : undefined
  const legacy = users.find((r) => r.id === `${OAUTH_USER_PREFIX}${provider}_${u.subject}`)
  let row = linked ?? legacy ?? identityRow ?? sameEmail.sort(byLastSeen)[0]

  if (row && identityRow && isOAuthRow(row)) {
    const strays = new Set([row.id, ...sameEmail.filter(isOAuthRow).map((r) => r.id)])
    for (const id of strays) await mergeUsers(deps, id, identityRow.id)
    row = (await deps.store.getUser(identityRow.id)) ?? identityRow
  }

  const now = deps.clock.now().toISOString()
  if (!row) {
    const isAdmin = deps.config.adminEmails.includes(email)
    if (!admission.domains && !(admission.adminsMayJoin && isAdmin))
      return { ok: false, code: 'no_account', reason: admission.noAccountReason }
    row = await deps.store.insertUserIfAbsent({
      id: `${OAUTH_USER_PREFIX}${provider}_${u.subject}`,
      email,
      name: null,
      role: isAdmin ? 'admin' : 'creator',
      admittedVia: admission.domains ? 'domain' : 'invite',
      createdAt: now,
      lastSeenAt: now,
      disabledAt: null,
    })
    deps.log.info('auth.user_created', { userId: row.id, provider })
  }
  if (row.disabledAt)
    return { ok: false, code: 'disabled', reason: 'Your account has been disabled by an admin.' }

  const stored = await deps.store.insertUserIdentityIfAbsent({
    provider,
    subject: u.subject,
    userId: row.id,
    email,
    createdAt: now,
    lastSeenAt: now,
  })
  if (
    stored.userId !== row.id ||
    stored.email !== email ||
    stored.lastSeenAt.slice(0, 13) !== now.slice(0, 13)
  )
    await deps.store.updateUserIdentity(provider, u.subject, { userId: row.id, email, lastSeenAt: now })
  if (row.lastSeenAt.slice(0, 13) !== now.slice(0, 13))
    await deps.store.updateUser(row.id, { lastSeenAt: now })
  return { ok: true, row }
}

/** How each person signs in, for the admin users page: 'identity' and/or the linked providers. */
export async function signInMethods(deps: Deps): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const add = (id: string, m: string) => {
    const list = out.get(id) ?? []
    if (!list.includes(m)) list.push(m)
    out.set(id, list)
  }
  for (const u of await deps.store.listUsers()) {
    if (!isOAuthRow(u)) add(u.id, 'identity')
    else add(u.id, u.id.slice(OAUTH_USER_PREFIX.length).split('_')[0] ?? 'oauth')
  }
  for (const i of await deps.store.listUserIdentities()) add(i.userId, i.provider)
  return out
}
