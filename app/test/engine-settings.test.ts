// The Remotion switch and license choice on the admin settings (render-engines plan §7).
import { describe, expect, it } from 'vitest'
import { enabledEngines } from '../server/domain/engines.js'
import { harness, person, pgStore, type Harness } from './helpers.js'

const patch = (h: Harness, body: object, as = h.admin) =>
  h.call('PATCH', '/api/v1/admin/settings', { as, body })
const read = async (h: Harness) => h.json(await h.call('GET', '/api/v1/admin/settings', { as: h.admin }))

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('Remotion settings (%s)', (_name, stores) => {
  const remotionOn = { ENGINES: 'hyperframes,remotion' }

  it('says nothing about Remotion when ENGINES doesn’t list it, and refuses its fields', async () => {
    const h = harness({}, await stores())
    expect(await read(h)).not.toHaveProperty('remotion')
    const res = await patch(h, { remotionEnabled: true, remotionLicense: { tier: 'free' } })
    expect(res.status).toBe(409)
    expect((await h.json(res)).error.code).toBe('engine_disabled')
  })

  it('only admins change it', async () => {
    const h = harness(remotionOn, await stores())
    const rita = await person(h, 'u_rita', 'reviewer')
    expect((await patch(h, { remotionLicense: { tier: 'free' } }, h.member)).status).toBe(403)
    expect((await patch(h, { remotionLicense: { tier: 'free' } }, rita)).status).toBe(403)
  })

  it('needs a license choice before it turns on', async () => {
    const h = harness(remotionOn, await stores())
    expect(await read(h)).toMatchObject({ remotion: { enabled: false, license: null, keySet: false } })
    const res = await patch(h, { remotionEnabled: true })
    expect(res.status).toBe(400)
    expect((await h.json(res)).error.code).toBe('remotion_license_required')
  })

  it('refuses a Company License without the key on the project', async () => {
    const h = harness(remotionOn, await stores())
    const res = await patch(h, { remotionEnabled: true, remotionLicense: { tier: 'company' } })
    expect(res.status).toBe(409)
    expect(await h.json(res)).toMatchObject({
      error: {
        code: 'remotion_key_missing',
        message: "Set VIDEO_AGENT_REMOTION_KEY on the project first; the server only checks that it's set.",
      },
    })
  })

  it('records the Free License choice with who and when, and offers Remotion', async () => {
    const h = harness(remotionOn, await stores())
    const res = await patch(h, {
      remotionEnabled: true,
      remotionLicense: { tier: 'free', note: '  evaluation, approved by legal  ' },
    })
    expect(res.status).toBe(200)
    expect((await h.json(res)).remotion).toMatchObject({
      enabled: true,
      keySet: false,
      license: {
        by: 'u_admin',
        email: 'admin@acme.com',
        tier: 'free',
        note: 'evaluation, approved by legal',
      },
    })
    expect((await enabledEngines(h.deps)).map((e) => e.id)).toEqual(['hyperframes', 'remotion'])
  })

  it('records a Company License when the key is set', async () => {
    const h = harness({ ...remotionOn, VIDEO_AGENT_REMOTION_KEY: 'rm_sec_test_value' }, await stores())
    const res = await patch(h, { remotionEnabled: true, remotionLicense: { tier: 'company' } })
    expect(res.status).toBe(200)
    expect((await h.json(res)).remotion).toMatchObject({
      enabled: true,
      keySet: true,
      license: { tier: 'company' },
    })
    // The key's value is never logged.
    expect(h.deps.logs.join('\n')).not.toContain('rm_sec_test_value')
    const saved = h.deps.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'settings.remotion_saved')
    expect(saved).toMatchObject({ by: 'u_admin', tier: 'company', enabled: true })
  })

  it('turning it off keeps the record, and stops offering it for new videos', async () => {
    const h = harness(remotionOn, await stores())
    await patch(h, { remotionEnabled: true, remotionLicense: { tier: 'free' } })
    const off = await h.json(await patch(h, { remotionEnabled: false }))
    expect(off.remotion).toMatchObject({ enabled: false, license: { tier: 'free' } })
    expect((await enabledEngines(h.deps)).map((e) => e.id)).toEqual(['hyperframes'])
  })
})
