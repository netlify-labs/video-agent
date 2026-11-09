// GET /api/v1/engines and the 'engines' feature (render-engines plan §7): HyperFrames always; Remotion only when ENGINES
// lists it, with its license notice; the feature string only once Remotion is actually on.
import { describe, expect, it } from 'vitest'
import { REMOTION_LICENSE_NOTICE } from '../server/lib/remotion-notice.js'
import { harness, person, type Harness } from './helpers.js'

const engines = async (h: Harness, as = h.member) =>
  (await h.json(await h.call('GET', '/api/v1/engines', { as }))).items as Record<string, unknown>[]
const features = async (h: Harness) =>
  (await h.json(await h.call('GET', '/api/v1/config'))).features as string[]

describe('GET /api/v1/engines', () => {
  it('lists only HyperFrames without ENGINES, and no engines feature', async () => {
    const h = harness()
    expect(await engines(h)).toEqual([
      expect.objectContaining({
        id: 'hyperframes',
        name: 'HyperFrames',
        enabled: true,
        notice: null,
        extraCredits: null,
        license: { kind: 'open', spdx: 'Apache-2.0' },
      }),
    ])
    expect(await features(h)).not.toContain('engines')
  })

  it('lists Remotion with its notice when ENGINES has it, off until an admin turns it on', async () => {
    const h = harness({ ENGINES: 'remotion' })
    const [, remotion] = await engines(h)
    expect(remotion).toMatchObject({
      id: 'remotion',
      enabled: false,
      notice: REMOTION_LICENSE_NOTICE,
      license: { kind: 'remotion', url: 'https://www.remotion.dev/docs/license' },
      capabilities: { editOps: [], sound: 'music', voiceover: false },
    })
    expect(await features(h)).not.toContain('engines')
  })

  it('once Remotion is on, says so and lists the engines feature, never the admin’s license record', async () => {
    const h = harness({ ENGINES: 'remotion' })
    await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.admin,
      body: { remotionEnabled: true, remotionLicense: { tier: 'free', note: 'approved by legal' } },
    })
    const viewer = await person(h, 'u_vic', 'viewer')
    const list = await engines(h, viewer)
    expect(list.map((e) => [e.id, e.enabled])).toEqual([
      ['hyperframes', true],
      ['remotion', true],
    ])
    expect(JSON.stringify(list)).not.toMatch(/approved by legal|admin@acme\.com|u_admin/)
    expect(await features(h)).toContain('engines')
  })

  it('needs a signed-in person', async () => {
    const h = harness()
    expect((await h.call('GET', '/api/v1/engines')).status).toBe(401)
  })
})
