// video-agent login's routes (cli-and-sdk plan §5.2; bead va-p1th.4.4): only the two POSTs the CLI makes before it
// has a key skip auth; the approve page's lookup and decision take a same-origin browser session and nothing else.
import { describe, expect, it } from 'vitest'
import { apiKey, harness, type Harness } from './helpers.js'

const IP = { 'x-nf-client-connection-ip': '203.0.113.9' }
const start = async (h: Harness) => {
  const res = await h.call('POST', '/api/v1/cli/logins', {
    origin: null,
    headers: IP,
    body: { label: 'Video Agent CLI', host: 'mia-mbp' },
  })
  expect(res.status).toBe(201)
  return h.json<{ loginId: string; deviceCode: string; userCode: string; intervalSec: number }>(res)
}

describe('CLI login routes', () => {
  it('start, look up, approve and claim over HTTP; the key works', async () => {
    const h = harness()
    const login = await start(h)
    const claim = (deviceCode = login.deviceCode) =>
      h.call('POST', `/api/v1/cli/logins/${login.loginId}/token`, { origin: null, body: { deviceCode } })
    expect(await h.json(await claim())).toEqual({ status: 'pending' })

    const seen = await h.call('POST', '/api/v1/cli/logins/lookup', {
      as: h.member,
      body: { userCode: login.userCode },
    })
    expect(seen.status).toBe(200)
    expect(await h.json(seen)).toMatchObject({ host: 'mia-mbp', clientIp: '203.0.113.9', role: 'creator' })
    const ok = await h.call('POST', '/api/v1/cli/logins/approve', {
      as: h.member,
      body: { userCode: login.userCode, decision: 'approve' },
    })
    expect(await h.json(ok)).toEqual({ status: 'approved' })

    h.deps.clock.advance(6_000)
    const got = await h.json(await claim())
    expect(got.status).toBe('claimed')
    expect((await h.call('GET', '/api/v1/me', { key: got.apiKey, origin: null })).status).toBe(200)
    expect((await claim('wrong')).status).toBe(404)
  })

  it('skips auth for exactly the two POSTs', async () => {
    const h = harness()
    const login = await start(h)
    for (const [method, path] of [
      ['GET', '/api/v1/cli/logins'],
      ['GET', `/api/v1/cli/logins/${login.loginId}/token`],
      ['POST', '/api/v1/cli/logins/lookup'],
      ['POST', '/api/v1/cli/logins/approve'],
      ['POST', `/api/v1/cli/logins/${login.loginId}/token/x`],
      ['GET', '/api/v1/me'],
    ] as const)
      expect(
        (await h.call(method, path, { origin: null, body: method === 'POST' ? {} : undefined })).status,
      ).toBe(401)
  })

  it('lookup and approve refuse a key and a cross-origin session', async () => {
    const h = harness()
    const login = await start(h)
    const key = await apiKey(h, h.member)
    for (const path of ['/api/v1/cli/logins/lookup', '/api/v1/cli/logins/approve']) {
      const body = { userCode: login.userCode, decision: 'approve' }
      expect((await h.call('POST', path, { key, origin: null, body })).status).toBe(403)
      expect(
        (await h.call('POST', path, { as: h.member, origin: 'https://evil.example', body })).status,
      ).toBe(403)
    }
  })

  it('caps what the CLI sends and the codes people type', async () => {
    const h = harness()
    const bad = [{ label: 'x'.repeat(65), host: 'h' }, { label: 'CLI', host: 'mía-mbp' }, { label: 'CLI' }]
    for (const body of bad)
      expect((await h.call('POST', '/api/v1/cli/logins', { origin: null, body })).status).toBe(400)
    for (const userCode of ['ABC', 'ABCD-EFGHI', 'ABCD_EFGH', '1234-5678'])
      expect(
        (await h.call('POST', '/api/v1/cli/logins/lookup', { as: h.member, body: { userCode } })).status,
      ).toBe(400)
    const long = 'x'.repeat(65)
    expect(
      (await h.call('POST', '/api/v1/cli/logins/cli_x/token', { origin: null, body: { deviceCode: long } }))
        .status,
    ).toBe(400)
  })

  it('a missing client IP shares one bucket; the switch answers 409 and drops cli_login from config', async () => {
    const h = harness()
    const config = async () =>
      (await h.json(await h.call('GET', '/api/v1/config', { origin: null }))).features
    expect(await config()).toContain('cli_login')
    for (let i = 0; i < 10; i++)
      await h.call('POST', '/api/v1/cli/logins', { origin: null, body: { label: 'CLI', host: `h${i}` } })
    const capped = await h.call('POST', '/api/v1/cli/logins', {
      origin: null,
      body: { label: 'CLI', host: 'h' },
    })
    expect(capped.status).toBe(429)

    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { cliLoginEnabled: false } })
    expect(await config()).not.toContain('cli_login')
    const off = await h.call('POST', '/api/v1/cli/logins', {
      origin: null,
      headers: IP,
      body: { label: 'CLI', host: 'h' },
    })
    expect(off.status).toBe(409)
    expect((await h.json(off)).error.code).toBe('cli_login_disabled')
  })
})
