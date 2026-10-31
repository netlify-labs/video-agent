// Personal and team webhook settings (plan v2 §3).
import { describe, expect, it } from 'vitest'
import { webhookSignature } from '../src/lib/crypto.js'
import { harness, type Harness } from './helpers.js'

const signed = (h: Harness, secret: string) => {
  const c = h.deps.http.calls.at(-1)
  const sig = c?.headers['x-video-agent-signature'] ?? ''
  return sig === webhookSignature(secret, c?.body ?? '', Number(/t=(\d+)/.exec(sig)?.[1]))
}

describe('personal webhook', () => {
  it('shows the secret once, keeps it on URL changes, rotates on request, and test-sends signed', async () => {
    const h = harness()
    const base = '/api/v1/me/webhook'
    expect(await h.json(await h.call('GET', base, { as: h.member }))).toBeNull()
    const created = await h.json(
      await h.call('PUT', base, { as: h.member, body: { url: 'https://a.example.com/h' } }),
    )
    expect(created.secret).toMatch(/^whsec_/)
    const got = await h.json(await h.call('GET', base, { as: h.member }))
    expect(got.url).toBe('https://a.example.com/h')
    expect(got.secret).toBeUndefined()

    const moved = await h.json(
      await h.call('PUT', base, { as: h.member, body: { url: 'https://b.example.com/h' } }),
    )
    expect(moved.secret).toBeNull()
    const test = await h.json(await h.call('POST', `${base}/test`, { as: h.member }))
    expect(test).toEqual({ ok: true, result: 'HTTP 200' })
    expect(h.deps.http.calls.at(-1)?.url).toBe('https://b.example.com/h')
    expect(signed(h, created.secret)).toBe(true)

    const rotated = await h.json(
      await h.call('PUT', base, { as: h.member, body: { url: 'https://b.example.com/h', rotate: true } }),
    )
    expect(rotated.secret).not.toBe(created.secret)
    await h.call('POST', `${base}/test`, { as: h.member })
    expect(signed(h, rotated.secret)).toBe(true)

    expect((await h.call('DELETE', base, { as: h.member })).status).toBe(204)
    expect(await h.json(await h.call('GET', base, { as: h.member }))).toBeNull()
    expect((await h.call('POST', `${base}/test`, { as: h.member })).status).toBe(404)
  })

  it('requires https', async () => {
    const h = harness()
    expect(
      (await h.call('PUT', '/api/v1/me/webhook', { as: h.member, body: { url: 'http://a.example.com/h' } }))
        .status,
    ).toBe(400)
  })
})

describe('team webhook', () => {
  it('admins set it; everyone else is refused', async () => {
    const h = harness()
    const base = '/api/v1/admin/team-webhook'
    expect(
      (await h.call('PUT', base, { as: h.member, body: { url: 'https://t.example.com/h' } })).status,
    ).toBe(403)
    expect((await h.call('GET', base, { as: h.member })).status).toBe(403)
    const created = await h.json(
      await h.call('PUT', base, { as: h.admin, body: { url: 'https://t.example.com/h' } }),
    )
    expect(created.secret).toMatch(/^whsec_/)
    expect(await h.json(await h.call('GET', base, { as: h.admin }))).toEqual({
      url: 'https://t.example.com/h',
    })
    await h.call('POST', `${base}/test`, { as: h.admin })
    expect(signed(h, created.secret)).toBe(true)
    expect((await h.call('DELETE', base, { as: h.admin })).status).toBe(204)
    expect(await h.json(await h.call('GET', base, { as: h.admin }))).toBeNull()
  })
})
