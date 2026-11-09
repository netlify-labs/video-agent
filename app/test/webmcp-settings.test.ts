// WebMCP's admin switch (va-qago): on by default, listed as the 'webmcp' feature, and an admin can turn it off.
import { describe, expect, it } from 'vitest'
import { harness, pgStore, type Harness } from './helpers.js'

const features = async (h: Harness) =>
  (await h.json(await h.call('GET', '/api/v1/config'))).features as string[]

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('the WebMCP switch (%s)', { timeout: 20_000 }, (_name, stores) => {
  it('is on by default, and off removes the webmcp feature', async () => {
    const h = harness({}, await stores())
    expect(await features(h)).toContain('webmcp')
    const settings = await h.json(await h.call('GET', '/api/v1/admin/settings', { as: h.admin }))
    expect(settings.webmcpEnabled).toBe(true)
    const res = await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.admin,
      body: { webmcpEnabled: false },
    })
    expect(res.status).toBe(200)
    expect((await h.json(res)).webmcpEnabled).toBe(false)
    expect(await features(h)).not.toContain('webmcp')
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { webmcpEnabled: true } })
    expect(await features(h)).toContain('webmcp')
  })

  it('only an admin can turn it off', async () => {
    const h = harness({}, await stores())
    const res = await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.member,
      body: { webmcpEnabled: false },
    })
    expect(res.status).toBe(403)
    expect(await features(h)).toContain('webmcp')
  })
})
