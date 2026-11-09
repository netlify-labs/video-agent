// video-agent login's domain (cli-and-sdk plan §5.2; bead va-p1th.4.3): create → lookup → approve → claim mints an
// ordinary API key once, after the same owner checks a key's every use gets; limits, the switch and the sweep. On the
// memory store and on Postgres (every migration applied).
import { describe, expect, it } from 'vitest'
import { claimLogin, createLogin, decideLogin, lookupLogin, normalizeCode } from '../server/domain/cli-login.js'
import { runCleanup } from '../server/domain/cleanup.js'
import type { Principal } from '../server/domain/policy.js'
import { harness, pgStore, type Harness } from './helpers.js'

const member: Principal = {
  kind: 'user',
  userId: 'u_member',
  email: 'mia@acme.com',
  name: 'Mia Member',
  role: 'creator',
  apiKeyId: null,
}
const IP = '203.0.113.7'
const start = (h: Harness, ip = IP) =>
  createLogin(h.deps, { label: 'Video Agent CLI', host: 'mia-mbp', clientIp: ip })
const events = (h: Harness, event: string) =>
  h.deps.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event)

describe.each([
  ['memory', () => harness()],
  ['Postgres', async () => harness({}, { store: await pgStore() })],
])('CLI login (%s)', (_store, make) => {
  it('create → lookup → approve → claim mints one key that works, with its webhook secret', async () => {
    const h = await make()
    const login = await start(h)
    expect(login.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(login.verificationUrl).toBe(`${h.deps.config.siteUrl}/cli/approve`)
    expect(login.verificationUrl).not.toContain(normalizeCode(login.userCode))
    expect(login.intervalSec).toBe(5)

    const seen = await lookupLogin(h.deps, member, login.userCode.toLowerCase().replace('-', ' '))
    expect(seen).toMatchObject({
      loginId: login.loginId,
      label: 'Video Agent CLI',
      host: 'mia-mbp',
      clientIp: IP,
      role: 'creator',
    })
    expect(await claimLogin(h.deps, login.loginId, login.deviceCode)).toEqual({ status: 'pending' })
    expect(await decideLogin(h.deps, member, login.userCode, 'approve')).toEqual({ status: 'approved' })

    const claim = await claimLogin(h.deps, login.loginId, login.deviceCode)
    if (claim.status !== 'claimed') throw new Error(`expected claimed, got ${claim.status}`)
    expect(claim.apiKey).toMatch(/^nva_/)
    expect(claim.webhookSecret).toMatch(/^whsec_/)
    expect(claim.user).toMatchObject({ id: 'u_member', email: 'mia@acme.com', role: 'creator' })
    const me = await h.call('GET', '/api/v1/me', { key: claim.apiKey, origin: null })
    expect(me.status).toBe(200)
    const keys = await h.json(await h.call('GET', '/api/v1/keys', { as: h.member }))
    const date = new Date(h.deps.clock.now()).toISOString().slice(0, 10)
    expect(keys.map((k: { name: string }) => k.name)).toContain(`CLI · mia-mbp · ${date}`)
    // The code works once.
    expect(await claimLogin(h.deps, login.loginId, login.deviceCode)).toEqual({ status: 'expired' })
    // No row ever holds a key or a raw code.
    const row = await h.deps.store.getCliLogin(login.loginId)
    const stored = JSON.stringify(row)
    expect(stored).not.toContain(claim.apiKey)
    expect(stored).not.toContain(login.deviceCode)
    expect(row?.apiKeyId).toBe(claim.keyId)
    expect(events(h, 'cli_login.claimed')).toHaveLength(1)
    expect(JSON.stringify(h.deps.logs)).not.toContain(login.deviceCode)
  })

  it('deny → denied; polling too fast → slow_down; ten minutes → expired', async () => {
    const h = await make()
    const a = await start(h)
    await decideLogin(h.deps, member, a.userCode, 'deny')
    expect(await claimLogin(h.deps, a.loginId, a.deviceCode)).toEqual({ status: 'denied' })
    const b = await start(h)
    expect(await claimLogin(h.deps, b.loginId, b.deviceCode)).toEqual({ status: 'pending' })
    expect(await claimLogin(h.deps, b.loginId, b.deviceCode)).toEqual({ status: 'slow_down' })
    h.deps.clock.advance(6_000)
    expect(await claimLogin(h.deps, b.loginId, b.deviceCode)).toEqual({ status: 'pending' })
    h.deps.clock.advance(10 * 60_000)
    expect(await claimLogin(h.deps, b.loginId, b.deviceCode)).toEqual({ status: 'expired' })
    await expect(lookupLogin(h.deps, member, b.userCode)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('five wrong typed codes lock approving for 15 minutes', async () => {
    const h = await make()
    const login = await start(h)
    for (let i = 0; i < 5; i++)
      await expect(lookupLogin(h.deps, member, 'BBBB-BBBB')).rejects.toMatchObject({ code: 'not_found' })
    await expect(decideLogin(h.deps, member, login.userCode, 'approve')).rejects.toMatchObject({
      code: 'rate_limited',
    })
    h.deps.clock.advance(15 * 60_000 + 1000)
    const again = await start(h)
    expect(await decideLogin(h.deps, member, again.userCode, 'approve')).toEqual({ status: 'approved' })
    expect(events(h, 'cli_login.lookup_failed')).toHaveLength(5)
  })

  it('five wrong device codes expire the login', async () => {
    const h = await make()
    const login = await start(h)
    for (let i = 0; i < 5; i++)
      await expect(claimLogin(h.deps, login.loginId, 'wrong')).rejects.toMatchObject({ code: 'not_found' })
    await decideLogin(h.deps, member, login.userCode, 'approve').catch(() => null)
    expect(await claimLogin(h.deps, login.loginId, login.deviceCode)).toEqual({ status: 'expired' })
  })

  it('caps: 10 approvals an hour per person, 10 pending per IP (another IP still works)', async () => {
    const h = await make()
    for (let i = 0; i < 10; i++) {
      const l = await createLogin(h.deps, { label: 'CLI', host: `h${i}`, clientIp: `198.51.100.${i}` })
      await decideLogin(h.deps, member, l.userCode, 'approve')
    }
    const eleventh = await start(h)
    await expect(decideLogin(h.deps, member, eleventh.userCode, 'approve')).rejects.toMatchObject({
      code: 'rate_limited',
    })
    for (let i = 0; i < 9; i++) await start(h)
    await expect(start(h)).rejects.toMatchObject({ code: 'rate_limited' })
    expect((await start(h, '192.0.2.1')).loginId).toMatch(/^cli_/)
  })

  it('refuses labels that are too long or not printable ASCII', async () => {
    const h = await make()
    await expect(
      createLogin(h.deps, { label: 'x'.repeat(65), host: 'h', clientIp: IP }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      createLogin(h.deps, { label: '<b>\u0000</b>', host: 'h', clientIp: IP }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
  })

  it('approve-then-disable and an Identity user who is gone both claim as denied', async () => {
    const h = await make()
    const a = await start(h)
    await decideLogin(h.deps, member, a.userCode, 'approve')
    await h.call('GET', '/api/v1/me', { as: h.member })
    expect(
      (await h.call('PATCH', '/api/v1/users/u_member', { as: h.admin, body: { disabled: true } })).status,
    ).toBe(200)
    expect(await claimLogin(h.deps, a.loginId, a.deviceCode)).toEqual({ status: 'denied' })
    expect(events(h, 'cli_login.claim_refused')).toHaveLength(1)

    const h2 = await make()
    const b = await start(h2)
    await decideLogin(h2.deps, member, b.userCode, 'approve')
    h2.deps.identity.users.delete('u_member')
    expect(await claimLogin(h2.deps, b.loginId, b.deviceCode)).toEqual({ status: 'denied' })
  })

  it('a key cannot approve: only a signed-in session', async () => {
    const h = await make()
    const login = await start(h)
    await expect(
      decideLogin(h.deps, { ...member, kind: 'apiKey', apiKeyId: 'key_1' }, login.userCode, 'approve'),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the admin switch turns every step off', async () => {
    const h = await make()
    const login = await start(h)
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { cliLoginEnabled: false } })
    for (const p of [
      start(h),
      lookupLogin(h.deps, member, login.userCode),
      decideLogin(h.deps, member, login.userCode, 'approve'),
      claimLogin(h.deps, login.loginId, login.deviceCode),
    ])
      await expect(p).rejects.toMatchObject({ code: 'cli_login_disabled', status: 409 })
  })

  it('the sweep marks expired logins and deletes them an hour later', async () => {
    const h = await make()
    const login = await start(h)
    h.deps.clock.advance(11 * 60_000)
    await runCleanup(h.deps, { deadline: Date.now() + 60_000, maxItems: 50 })
    expect((await h.deps.store.getCliLogin(login.loginId))?.status).toBe('expired')
    h.deps.clock.advance(61 * 60_000)
    await runCleanup(h.deps, { deadline: Date.now() + 60_000, maxItems: 50 })
    expect(await h.deps.store.getCliLogin(login.loginId)).toBeNull()
  })
})
