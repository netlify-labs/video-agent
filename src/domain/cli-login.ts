// `video-agent login` (docs/plans/2026-11-04-cli-and-sdk.md §5.2): a device-style approval (modelled on RFC 8628) that
// ends in an ordinary API key. The CLI creates a login and gets a device code (only its sha256 is stored) and a user
// code; the person signs in, TYPES the user code (never a prefilled link, RFC 8628 §5.4) and approves; the CLI's
// claim then mints the key, after the same owner checks a key's every use gets. No key is ever stored here.
import { randomInt } from 'node:crypto'
import type { Deps } from '../deps.js'
import { safeEqual, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { keyOwner } from './auth.js'
import { createKeyForUser } from './keys.js'
import type { Principal } from './policy.js'
import type { CliLoginRow } from './types.js'

/** RFC 8628 §6.1: consonants only, so codes don't spell words, and no look-alikes. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const LOGIN_TTL_MS = 10 * 60_000
export const INTERVAL_SEC = 5
const MAX_PENDING_PER_IP = 10
const MAX_PENDING = 500
const MAX_APPROVALS_PER_HOUR = 10
const MAX_WRONG_CODES = 5
const WRONG_CODE_WINDOW_MS = 15 * 60_000
const MAX_WRONG_DEVICE_CODES = 5

export async function cliLoginEnabled(deps: Pick<Deps, 'store'>): Promise<boolean> {
  return (await deps.store.getSettings())?.cliLoginEnabled ?? true
}

async function assertEnabled(deps: Pick<Deps, 'store'>) {
  if (!(await cliLoginEnabled(deps)))
    throw new ApiError(
      'cli_login_disabled',
      'Browser login for the CLI is turned off. Make a key on the API keys page and run: video-agent login --key -',
    )
}

/** What the CLI sends about itself: shown on the approve page, so it's capped and printable ASCII only. */
function clean(value: string, what: string): string {
  const v = value.trim()
  if (!v || v.length > 64 || !/^[\x20-\x7e]+$/.test(v))
    throw new ApiError('invalid_request', `${what} must be 1 to 64 printable ASCII characters.`)
  return v
}

/** ABCDEFGH → ABCD-EFGH; anything typed (lower case, spaces, a dash) → ABCDEFGH. */
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`
export const normalizeCode = (typed: string) => typed.toUpperCase().replace(/[^A-Z]/g, '')

const newUserCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

export async function createLogin(deps: Deps, input: { label: string; host: string; clientIp: string }) {
  await assertEnabled(deps)
  const label = clean(input.label, 'label')
  const host = clean(input.host, 'host')
  const now = deps.clock.now()
  const nowIso = now.toISOString()
  if ((await deps.store.countPendingCliLogins(nowIso, input.clientIp)) >= MAX_PENDING_PER_IP)
    throw new ApiError(
      'rate_limited',
      'Too many logins waiting from this address. Finish or wait for those first.',
    )
  if ((await deps.store.countPendingCliLogins(nowIso)) >= MAX_PENDING)
    throw new ApiError(
      'rate_limited',
      'Too many logins are waiting for approval. Try again in a few minutes.',
    )
  let userCode = newUserCode()
  while (await deps.store.findPendingCliLogin(userCode, nowIso)) userCode = newUserCode()
  const deviceCode = deps.ids.secret(32)
  const row: CliLoginRow = {
    id: `cli_${deps.ids.uuid()}`,
    deviceCodeHash: sha256Hex(deviceCode),
    userCode,
    label,
    host,
    clientIp: input.clientIp,
    status: 'pending',
    userId: null,
    approvedAt: null,
    apiKeyId: null,
    failedAttempts: 0,
    lastPolledAt: null,
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS).toISOString(),
  }
  await deps.store.insertCliLogin(row)
  deps.log.info('cli_login.created', { loginId: row.id, clientIp: row.clientIp })
  return {
    loginId: row.id,
    deviceCode,
    userCode: showCode(userCode),
    // No code in it: the person types the one their terminal shows.
    verificationUrl: `${deps.config.siteUrl}/cli/approve`,
    expiresAt: row.expiresAt,
    intervalSec: INTERVAL_SEC,
  }
}

/** The pending login a signed-in person typed the code of; a wrong code counts toward their lock. */
async function typed(deps: Deps, p: Principal, code: string): Promise<CliLoginRow> {
  if (p.kind !== 'user')
    throw new ApiError('forbidden', 'Approve a CLI login from a signed-in browser session, not with a key.')
  const now = deps.clock.now()
  const since = new Date(now.getTime() - WRONG_CODE_WINDOW_MS).toISOString()
  if ((await deps.store.countCliLoginFailures(p.userId, since)) >= MAX_WRONG_CODES)
    throw new ApiError('rate_limited', 'Too many wrong codes. Try again in 15 minutes.')
  const login = await deps.store.findPendingCliLogin(normalizeCode(code), now.toISOString())
  if (!login) {
    await deps.store.insertCliLoginFailure({
      id: deps.ids.uuid(),
      userId: p.userId,
      createdAt: now.toISOString(),
    })
    deps.log.info('cli_login.lookup_failed', { userId: p.userId })
    throw new ApiError('not_found', 'No CLI login is waiting for that code. Check the code in your terminal.')
  }
  return login
}

/** What the approve page shows before the person decides. */
export async function lookupLogin(deps: Deps, p: Principal, code: string) {
  await assertEnabled(deps)
  const login = await typed(deps, p, code)
  return {
    loginId: login.id,
    label: login.label,
    host: login.host,
    clientIp: login.clientIp,
    createdAt: login.createdAt,
    expiresAt: login.expiresAt,
    role: p.role,
  }
}

export async function decideLogin(deps: Deps, p: Principal, code: string, decision: 'approve' | 'deny') {
  await assertEnabled(deps)
  const login = await typed(deps, p, code)
  const now = deps.clock.now()
  if (decision === 'deny') {
    await deps.store.updateCliLogin(login.id, { status: 'denied', userId: p.userId })
    deps.log.info('cli_login.denied', { loginId: login.id, userId: p.userId })
    return { status: 'denied' as const }
  }
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString()
  if ((await deps.store.countCliLoginApprovals(p.userId, hourAgo)) >= MAX_APPROVALS_PER_HOUR)
    throw new ApiError('rate_limited', 'You approved 10 CLI logins in the last hour. Try again later.')
  await deps.store.updateCliLogin(login.id, {
    status: 'approved',
    userId: p.userId,
    approvedAt: now.toISOString(),
  })
  deps.log.info('cli_login.approved', { loginId: login.id, userId: p.userId })
  return { status: 'approved' as const }
}

export type ClaimResult =
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }
  | {
      status: 'claimed'
      apiKey: string
      keyId: string
      webhookSecret: string
      user: { id: string; email: string; role: string }
    }

/** The CLI's poll. On the first claim after approval the key is minted, once; every later claim is expired. */
export async function claimLogin(deps: Deps, loginId: string, deviceCode: string): Promise<ClaimResult> {
  await assertEnabled(deps)
  const now = deps.clock.now()
  const nowIso = now.toISOString()
  const step = await deps.store.tx(async (repo) => {
    const login = await repo.getCliLogin(loginId, { lock: true })
    if (!login) throw new ApiError('not_found', 'No such CLI login.')
    if (!safeEqual(login.deviceCodeHash, sha256Hex(deviceCode))) {
      const failedAttempts = login.failedAttempts + 1
      await repo.updateCliLogin(login.id, {
        failedAttempts,
        ...(failedAttempts >= MAX_WRONG_DEVICE_CODES ? { status: 'expired' as const } : {}),
      })
      return { kind: 'wrong' as const }
    }
    if (login.status === 'denied') return { kind: 'done' as const, status: 'denied' as const }
    if (login.status === 'claimed' || login.status === 'expired')
      return { kind: 'done' as const, status: 'expired' as const }
    if (login.expiresAt <= nowIso) {
      await repo.updateCliLogin(login.id, { status: 'expired' })
      return { kind: 'done' as const, status: 'expired' as const }
    }
    if (login.status === 'pending') {
      const early = login.lastPolledAt && now.getTime() - Date.parse(login.lastPolledAt) < INTERVAL_SEC * 1000
      await repo.updateCliLogin(login.id, { lastPolledAt: nowIso })
      return { kind: 'done' as const, status: early ? ('slow_down' as const) : ('pending' as const) }
    }
    // Approved: taken now, under the lock, so two claims can't both mint.
    await repo.updateCliLogin(login.id, { status: 'claimed' })
    return { kind: 'mint' as const, login }
  })
  if (step.kind === 'wrong') throw new ApiError('not_found', 'No such CLI login.')
  if (step.kind === 'done') return { status: step.status }
  const { login } = step
  const userId = login.userId ?? ''
  let owner
  try {
    // Approving and then being offboarded must never yield a working key.
    owner = await keyOwner(deps, userId)
  } catch (e) {
    await deps.store.updateCliLogin(login.id, { status: 'denied' })
    deps.log.info('cli_login.claim_refused', {
      loginId: login.id,
      reason: e instanceof ApiError ? e.code : 'error',
    })
    return { status: 'denied' }
  }
  const key = await createKeyForUser(deps, userId, `CLI · ${login.host} · ${nowIso.slice(0, 10)}`)
  await deps.store.updateCliLogin(login.id, { apiKeyId: key.id })
  deps.log.info('cli_login.claimed', { loginId: login.id, keyId: key.id })
  return {
    status: 'claimed',
    apiKey: key.key,
    keyId: key.id,
    webhookSecret: key.webhookSecret,
    user: { id: owner.id, email: owner.email, role: owner.role },
  }
}
