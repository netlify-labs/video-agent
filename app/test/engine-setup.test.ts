// The /setup Engines row (render-engines plan §7): absent unless ENGINES lists Remotion; then whether it's set up, on,
// under which recorded license, and whether its latest run failed to install it.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../server/domain/settings.js'
import type { AttemptRow } from '../server/domain/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const ack = (tier: 'free' | 'company') => ({
  by: 'u_admin',
  email: 'admin@acme.com',
  at: '2026-11-05T09:30:00Z',
  tier,
  note: null,
})
const engineRow = async (h: Harness) =>
  ((await h.json(await h.call('GET', '/api/health?fresh=1'))).checks as { id: string }[]).find(
    (c) => c.id === 'engines',
  )

/** A Remotion video whose one attempt ended like this, at this time. */
async function remotionAttempt(h: Harness, patch: Partial<AttemptRow>) {
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.deps.store.updateVersion(v.id, 1, { engine: 'remotion' })
  const [a] = await h.deps.store.listAttempts(v.id)
  await h.deps.store.updateAttempt(a?.id ?? '', patch)
}

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('the /setup Engines row (%s)', { timeout: 20_000 }, (_name, stores) => {
  async function deployment(settings: Record<string, unknown> | null, env = { ENGINES: 'remotion' }) {
    const h = harness(env, await stores())
    await getSettings(h.deps)
    if (settings) await h.deps.store.updateSettings(settings)
    return h
  }

  it('is absent without remotion in ENGINES', async () => {
    const h = await deployment({ remotionEnabled: true, remotionLicenseAck: ack('free') }, {} as never)
    expect(await engineRow(h)).toBeUndefined()
  })

  it('in ENGINES but no license recorded: a warning pointing at Admin', async () => {
    expect(await engineRow(await deployment(null))).toMatchObject({
      label: 'Render engines',
      status: 'warn',
      detail: 'HyperFrames ✓; Remotion: in ENGINES but not set up: see Admin.',
      fix: expect.stringContaining('/admin'),
    })
  })

  it('a license recorded but switched off', async () => {
    expect(
      await engineRow(await deployment({ remotionEnabled: false, remotionLicenseAck: ack('free') })),
    ).toMatchObject({ status: 'ok', detail: 'HyperFrames ✓; Remotion: off.' })
  })

  it('on: the tier and the day it was recorded, never who recorded it (the health check is public)', async () => {
    const row = await engineRow(
      await deployment({ remotionEnabled: true, remotionLicenseAck: ack('company') }),
    )
    expect(row).toMatchObject({
      status: 'ok',
      detail:
        'HyperFrames ✓; Remotion: on, Company License recorded on 2026-11-05; renders are reported to remotion.pro.',
    })
    expect(JSON.stringify(row)).not.toContain('admin@acme.com')
  })

  it('the latest Remotion run failed to install it: the code only; a newer successful run clears it', async () => {
    const h = await deployment({ remotionEnabled: true, remotionLicenseAck: ack('free') })
    await remotionAttempt(h, {
      stage: 'failed',
      errorCategory: 'engine_install_failed',
      errorMessage: 'npm ci timed out',
      endedAt: '2026-11-05T10:00:00.000Z',
    })
    expect(await engineRow(h)).toMatchObject({
      status: 'warn',
      detail: 'HyperFrames ✓; Remotion: last Remotion install failed: engine_install_failed.',
    })
    await remotionAttempt(h, { stage: 'ready', endedAt: '2026-11-05T11:00:00.000Z' })
    expect(await engineRow(h)).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('Remotion: on'),
    })
  })
})
