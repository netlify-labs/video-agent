// video-agent login, logout, whoami and doctor (cli-and-sdk plan §5.2, §6.3; bead va-p1th.4.2), in-process against
// harness()'s app: the device flow approved through the browser-session routes, --key, and the remote checks.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../packages/cli/src/router.js'
import { hostLabel } from '../../packages/cli/src/commands/account.js'
import { cli, SITE } from './cli-io.js'
import { apiKey, harness, type Harness } from './helpers.js'

const TOKEN = /^\/api\/v1\/cli\/logins\/(cli_[\w-]+)\/token$/

/**
 * Plays the person in the browser: on the CLI's first poll (or poll `approveAt`), types the code and approves (or
 * denies) as h.member; before each poll, moves the clock past the interval unless `tick` says otherwise.
 */
function browser(
  h: Harness,
  o: { decision?: 'approve' | 'deny' | null; approveAt?: number; tick?: (n: number) => number } = {},
) {
  let polls = 0
  return async (req: Request) => {
    const m = TOKEN.exec(new URL(req.url).pathname)
    if (!m) return
    polls++
    if (polls === (o.approveAt ?? 1) && o.decision !== null) {
      const login = await h.deps.store.getCliLogin(m[1]!)
      const res = await h.call('POST', '/api/v1/cli/logins/approve', {
        as: h.member,
        body: { userCode: login!.userCode, decision: o.decision ?? 'approve' },
      })
      expect(res.status).toBe(200)
    }
    h.deps.clock.advance(o.tick ? o.tick(polls) : 6_000)
  }
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
const exists = (dir: string) => {
  try {
    statSync(join(dir, 'config.json'))
    return true
  } catch {
    return false
  }
}

describe('video-agent login', () => {
  it('opens the approve page, prints the code, and saves url, key, key id and webhook secret 0600', async () => {
    const h = harness()
    const c = await cli(h, { key: null, before: browser(h) })
    const r = await c.run(['login'])
    expect(r.code, r.stderr).toBe(0)
    expect(c.opened).toEqual([`${h.deps.config.siteUrl}/cli/approve`])
    expect(r.stderr).toMatch(
      /Open \S+\/cli\/approve and enter [BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/,
    )
    expect(r.stdout).toContain('Signed in as mia@acme.com (creator)')
    const file = saved(c.configDir)
    expect(file).toMatchObject({ url: SITE, keyId: expect.stringMatching(/^key_/) })
    expect(file.apiKey).toMatch(/^nva_/)
    expect(file.webhookSecret).toMatch(/^whsec_/)
    expect(statSync(join(c.configDir, 'config.json')).mode & 0o777).toBe(0o600)
    expect(r.stdout + r.stderr).not.toContain('nva_')
    // The saved key works for the next command.
    const who = await c.run(['whoami'])
    expect(who.code).toBe(0)
    expect(who.stdout).toContain('mia@acme.com (creator)')
    expect(who.stdout).toContain('key from config')
    expect(who.stdout).toMatch(/features: .*cli_login/)
  })

  it('honours slow_down: the interval grows by five seconds', async () => {
    const h = harness()
    // Poll 2 comes too soon (the clock doesn't move); the person approves before poll 4.
    const c = await cli(h, {
      key: null,
      before: browser(h, { approveAt: 4, tick: (n) => (n === 2 ? 0 : 11_000) }),
    })
    const r = await c.run(['login', '--verbose'])
    expect(r.code, r.stderr).toBe(0)
    const polls = r.stderr
      .split('\n')
      .filter((l) => l.includes('"login.poll"'))
      .map((l) => JSON.parse(l) as { status: string; intervalSec: number })
    expect(polls.map((p) => [p.status, p.intervalSec])).toEqual([
      ['pending', 5],
      ['slow_down', 5],
      ['pending', 10],
      ['claimed', 10],
    ])
  })

  it('denied and expired exit 3 and save nothing', async () => {
    const h = harness()
    const denied = await cli(h, { key: null, before: browser(h, { decision: 'deny' }) })
    const d = await denied.run(['login', '--no-browser'])
    expect([d.code, d.stderr]).toEqual([3, expect.stringContaining('The login was denied in the browser.')])
    expect(exists(denied.configDir)).toBe(false)

    const expired = await cli(h, {
      key: null,
      before: browser(h, { decision: null, tick: () => 11 * 60_000 }),
    })
    const e = await expired.run(['login', '--no-browser'])
    expect([e.code, e.stderr]).toEqual([
      3,
      expect.stringContaining('The code expired. Run video-agent login again.'),
    ])
    expect(exists(expired.configDir)).toBe(false)
  })

  it('--no-browser prints the address and code only', async () => {
    const h = harness()
    const c = await cli(h, { key: null, before: browser(h) })
    const r = await c.run(['login', '--no-browser'])
    expect(r.code).toBe(0)
    expect(c.opened).toEqual([])
    expect(r.stderr).toContain('/cli/approve and enter ')
  })

  it('--key - reads stdin, checks it, saves it; --no-save keeps it out of the file', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const c = await cli(h, { key: null, stdin: `${key}\n` })
    const r = await c.run(['login', '--key', '-'])
    expect(r.code, r.stderr).toBe(0)
    expect(saved(c.configDir)).toMatchObject({ url: SITE, apiKey: key })
    expect(saved(c.configDir).keyId).toMatch(/^key_/)
    expect(r.stdout + r.stderr).not.toContain('nva_')

    const ci = await cli(h, { key: null, stdin: key })
    const n = await ci.run(['login', '--key', '-', '--no-save', '--json'])
    expect(n.code).toBe(0)
    expect(n.json()).toMatchObject({ saved: false, user: { email: 'mia@acme.com' } })
    expect(exists(ci.configDir)).toBe(false)
  })

  it('a revoked key exits 3 and saves nothing', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const id = (await h.json(await h.call('GET', '/api/v1/keys', { as: h.member })))[0].id
    await h.call('DELETE', `/api/v1/keys/${id}`, { as: h.member })
    const c = await cli(h, { key: null, stdin: key })
    const r = await c.run(['login', '--key', '-'])
    expect(r.code).toBe(3)
    expect(exists(c.configDir)).toBe(false)
    expect(r.stderr).not.toContain('nva_')
  })

  it('switched off: the API keys page hint, exit 7', async () => {
    const h = harness()
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { cliLoginEnabled: false } })
    const c = await cli(h, { key: null })
    const r = await c.run(['login'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain(`CLI sign-in isn't available on this server. Create a key on ${SITE}/keys`)
    expect(r.stderr).toContain('video-agent login --key -')
  })

  it('--no-save without --key is a usage error', async () => {
    const h = harness()
    const r = await (await cli(h, { key: null })).run(['login', '--no-save'])
    expect(r.code).toBe(2)
  })

  it('caps the host name it sends to 64 printable ASCII characters', () => {
    expect(hostLabel('mía-mbp')).toBe('ma-mbp')
    expect(hostLabel('x'.repeat(80))).toHaveLength(64)
    expect(hostLabel('éé')).toBe('unknown host')
  })
})

describe('video-agent logout and whoami', () => {
  it('logout --revoke revokes the saved key and forgets it; plain logout only forgets', async () => {
    const h = harness()
    const c = await cli(h, { key: null, before: browser(h) })
    expect((await c.run(['login'])).code).toBe(0)
    const key = saved(c.configDir).apiKey as string
    const r = await c.run(['logout', '--revoke'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('Revoked the key on the server and forgot it here.')
    expect(saved(c.configDir)).toEqual({ url: SITE })
    expect((await h.call('GET', '/api/v1/me', { key, origin: null })).status).toBe(401)
    expect((await c.run(['logout'])).stdout).toContain('No saved key.')
    expect((await c.run(['logout', '--revoke'])).code).toBe(3)
  })

  it('whoami --json: the person, the server version and features', async () => {
    const h = harness()
    const c = await cli(h)
    const r = await c.run(['whoami', '--json'])
    expect(r.code).toBe(0)
    const body = r.json()
    expect(body).toMatchObject({ user: { email: 'mia@acme.com', role: 'creator' }, url: SITE, key: 'env' })
    expect(body.features).toContain('cli_login')
    expect(body.server).toHaveProperty('promptTemplate')
  })
})

describe('video-agent doctor', () => {
  it('passes with a reachable server and a working key', async () => {
    const h = harness()
    const r = await (await cli(h)).run(['doctor', '--json'])
    expect(r.code).toBe(0)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(body.checks.map((x: { name: string }) => x.name)).toEqual(['node', 'config', 'server', 'key'])
    expect(body.features).toContain('cli_login')
  })

  it('reports an unreachable server and exits 1', { timeout: 30_000 }, async () => {
    let stdout = ''
    const code = await main(['doctor'], {
      stdout: (t) => (stdout += t),
      stderr: () => {},
      stdin: async () => '',
      env: { VIDEO_AGENT_URL: 'https://down.example', VIDEO_AGENT_KEY: 'nva_key_x_00' },
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      now: () => Date.now(),
      openBrowser: async () => {},
      configDir: '/nonexistent/va-doctor',
      pollMs: 0,
    })
    expect(code).toBe(1)
    expect(stdout).toContain('✓ node')
    expect(stdout).toMatch(/✗ server: Couldn't reach https:\/\/down\.example/)
    expect(stdout).not.toContain('nva_')
  })

  it('without a server says how to set one', async () => {
    let stdout = ''
    const code = await main(['doctor'], {
      stdout: (t) => (stdout += t),
      stderr: () => {},
      stdin: async () => '',
      env: {},
      fetch: async () => new Response(null, { status: 500 }),
      now: () => Date.now(),
      openBrowser: async () => {},
      configDir: '/nonexistent/va-doctor',
      pollMs: 0,
    })
    expect(code).toBe(1)
    expect(stdout).toContain('✗ config: No server set: run video-agent login --url <your deployment>')
  })
})
