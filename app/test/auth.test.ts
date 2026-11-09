import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats.'

describe('admission and sessions', () => {
  it('admits confirmed users at an allowed domain and makes ADMIN_EMAILS admins', async () => {
    const h = harness()
    expect((await h.json(await h.call('GET', '/api/v1/me', { as: h.member }))).role).toBe('creator')
    expect((await h.json(await h.call('GET', '/api/v1/me', { as: h.admin }))).role).toBe('admin')
  })

  it('refuses outside domains, unconfirmed accounts and missing sessions', async () => {
    const h = harness()
    expect((await h.call('GET', '/api/v1/me', { as: h.outsider })).status).toBe(403)
    const unconfirmed = h.deps.identity.addUser({
      id: 'u_new',
      email: 'new@acme.com',
      confirmed: false,
    }).cookie
    expect((await h.call('GET', '/api/v1/me', { as: unconfirmed })).status).toBe(401)
    expect((await h.call('GET', '/api/v1/me')).status).toBe(401)
  })

  it('treats a deleted Identity account as signed out even with a valid cookie', async () => {
    const h = harness()
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(200)
    h.deps.identity.users.delete('u_member')
    h.deps.clock.advance(6 * 60_000) // past the live-check cache
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(401)
  })

  it('fails closed when Identity is unreachable', async () => {
    const h = harness()
    h.deps.identity.outage = true
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(502)
  })

  it('invite-only mode admits invited users only', async () => {
    const h = harness({ ALLOWED_EMAIL_DOMAINS: 'invite-only', ADMIN_EMAILS: 'boss@anywhere.io' })
    const invited = h.deps.identity.addUser({ id: 'u_inv', email: 'boss@anywhere.io', invited: true }).cookie
    expect((await h.json(await h.call('GET', '/api/v1/me', { as: invited }))).role).toBe('admin')
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(403)
  })

  it('refuses cross-site state changes on cookie sessions (CSRF) but not on API keys', async () => {
    const h = harness()
    expect(
      (
        await h.call('POST', '/api/v1/videos', {
          as: h.member,
          origin: 'https://evil.example',
          body: { prompt: PROMPT },
        })
      ).status,
    ).toBe(403)
    expect(
      (await h.call('POST', '/api/v1/videos', { as: h.member, origin: null, body: { prompt: PROMPT } }))
        .status,
    ).toBe(403)
    const key = await h.json(await h.call('POST', '/api/v1/keys', { as: h.member, body: { name: 'ci' } }))
    expect(
      (await h.call('POST', '/api/v1/videos', { key: key.key, origin: null, body: { prompt: PROMPT } }))
        .status,
    ).toBe(202)
  })

  it('rejects revoked keys, keys of disabled users, and garbage keys', async () => {
    const h = harness()
    const key = await h.json(await h.call('POST', '/api/v1/keys', { as: h.member, body: { name: 'ci' } }))
    expect((await h.call('GET', '/api/v1/me', { key: key.key })).status).toBe(200)
    expect((await h.call('GET', '/api/v1/me', { key: `${key.key}x` })).status).toBe(401)
    expect((await h.call('GET', '/api/v1/me', { key: 'nva_nope_nope' })).status).toBe(401)
    expect(
      (await h.call('PATCH', '/api/v1/users/u_member', { as: h.admin, body: { disabled: true } })).status,
    ).toBe(200)
    expect((await h.call('GET', '/api/v1/me', { key: key.key })).status).toBe(401)
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(403)
  })

  it('keeps at least one admin', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.admin })
    expect(
      (await h.call('PATCH', '/api/v1/users/u_admin', { as: h.admin, body: { role: 'reviewer' } })).status,
    ).toBe(409)
  })

  it('refuses paid work until setup is complete', async () => {
    const h = harness({ RUNNER_API_TOKEN: '' })
    const res = await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    expect(res.status).toBe(503)
    expect((await h.json(res)).error.code).toBe('setup_required')
    const health = await h.json(await h.call('GET', '/api/health'))
    expect(health.ready).toBe(false)
    expect(health.checks.find((c: { id: string }) => c.id === 'runner-token').status).toBe('fail')
  })

  it('flags autoconfirm in domain mode and open registration in invite-only mode', async () => {
    const h = harness()
    h.deps.identity.settingsValue = { autoconfirm: true, disableSignup: false }
    const health = await h.json(await h.call('GET', '/api/health?fresh=1'))
    expect(health.checks.find((c: { id: string }) => c.id === 'identity-autoconfirm').status).toBe('fail')
    const h2 = harness({ ALLOWED_EMAIL_DOMAINS: 'invite-only' })
    const health2 = await h2.json(await h2.call('GET', '/api/health?fresh=1'))
    expect(health2.checks.find((c: { id: string }) => c.id === 'identity-registration').status).toBe('fail')
  })

  it('serves nothing from a deploy that is not the live production deploy', async () => {
    const h = harness({}, { live: false })
    expect((await h.call('GET', '/api/health')).status).toBe(404)
    expect((await h.call('GET', '/api/v1/me', { as: h.member })).status).toBe(404)
  })
})

describe('policy', () => {
  it('lets anyone view and revise, but only owners and admins rename, publish and delete', async () => {
    const h = harness()
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    const other = h.deps.identity.addUser({ id: 'u_other', email: 'otto@acme.com' }).cookie
    expect((await h.call('GET', `/api/v1/videos/${video.id}`, { as: other })).status).toBe(200)
    expect(
      (await h.call('PATCH', `/api/v1/videos/${video.id}`, { as: other, body: { title: 'x' } })).status,
    ).toBe(403)
    expect(
      (await h.call('POST', `/api/v1/videos/${video.id}/versions/1/publish`, { as: other })).status,
    ).toBe(403)
    expect((await h.call('DELETE', `/api/v1/videos/${video.id}`, { as: other })).status).toBe(403)
    expect(
      (
        await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
          as: other,
          body: { prompt: 'Make it blue.' },
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
          as: other,
          body: { prompt: 'And green.' },
        })
      ).status,
    ).toBe(409)
    expect((await h.call('GET', '/api/v1/users', { as: other })).status).toBe(403)
    expect((await h.call('GET', '/api/v1/stats', { as: other })).status).toBe(403)
    expect(
      (await h.call('PATCH', `/api/v1/videos/${video.id}`, { as: h.admin, body: { title: 'Renamed' } }))
        .status,
    ).toBe(200)
    expect((await h.call('DELETE', `/api/v1/videos/${video.id}`, { as: h.member })).status).toBe(202)
    expect((await h.call('GET', `/api/v1/videos/${video.id}`, { as: other })).status).toBe(404)
  })

  it('returns stable errors and validation details', async () => {
    const h = harness()
    const bad = await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: 'short' } })
    expect(bad.status).toBe(400)
    const body = await h.json(bad)
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.details[0].path).toBe('prompt')
    expect((await h.json(await h.call('GET', '/api/v1/nope', { as: h.member }))).error.code).toBe('not_found')
  })

  it('replays idempotent creates and refuses a reused key with a different body', async () => {
    const h = harness()
    const headers = { 'idempotency-key': 'abc-1' }
    const a = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, headers, body: { prompt: PROMPT } }),
    )
    const b = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, headers, body: { prompt: PROMPT } }),
    )
    expect(b.id).toBe(a.id)
    expect(
      (await h.call('POST', '/api/v1/videos', { as: h.member, headers, body: { prompt: `${PROMPT}!` } }))
        .status,
    ).toBe(409)
  })

  it('lists newest first with search, filters and cursors', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      await h.call('POST', '/api/v1/videos', {
        as: i % 2 ? h.admin : h.member,
        body: { prompt: `${PROMPT} number ${i} ${i === 3 ? 'pineapple' : ''}` },
      })
      h.deps.clock.advance(1000)
    }
    const page1 = await h.json(await h.call('GET', '/api/v1/videos?limit=2', { as: h.member }))
    expect(page1.items).toHaveLength(2)
    const page2 = await h.json(
      await h.call('GET', `/api/v1/videos?limit=2&cursor=${page1.nextCursor}`, { as: h.member }),
    )
    expect(page2.items[0].createdAt < page1.items[1].createdAt).toBe(true)
    expect(
      (await h.json(await h.call('GET', '/api/v1/videos?q=pineapple', { as: h.member }))).items,
    ).toHaveLength(1)
    expect(
      (await h.json(await h.call('GET', '/api/v1/videos?owner=me', { as: h.member }))).items,
    ).toHaveLength(3)
  })

  it('reports AI Gateway as an optional capability that never blocks setup', async () => {
    const { harness } = await import('./helpers.js')
    const h = harness()
    h.deps.gateway.isAvailable = false
    const r = await h.json(await h.call('GET', '/api/health?fresh=1', { as: h.admin }))
    const g = r.checks.find((c: { id: string }) => c.id === 'ai-gateway')
    expect(g.status).toBe('warn')
    expect(r.ready).toBe(true)
  })
})
