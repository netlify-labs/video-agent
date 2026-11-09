// Recorded voice-over settings (voice-over plan §6.1, §12 decisions 4 and 15): admins change them without a
// redeploy, everyone else is refused, the web app learns the flag from /api/v1/config, narration operations are
// refused while it's off, and setup says whether the deployment can record at all.
import { describe, expect, it } from 'vitest'
import { assertNarrationEnabled, narrationEnabled } from '../server/domain/narration-settings.js'
import { secureContext } from '../server/domain/setup.js'
import { NARRATION_SETTING_DEFAULTS } from '../server/domain/types.js'
import { ApiError } from '../server/lib/errors.js'
import { harness, person, pgStore } from './helpers.js'

const base = '/api/v1/admin/settings'

describe.each([
  ['memory', undefined],
  ['postgres', pgStore],
] as const)('admin settings (%s)', (_name, make) => {
  it('reads the defaults, changes only the fields given, and keeps them', async () => {
    const h = harness({}, make ? { store: await make() } : {})
    expect(await h.json(await h.call('GET', base, { as: h.admin }))).toEqual({
      ...NARRATION_SETTING_DEFAULTS,
      remixEnabled: true,
      webmcpEnabled: true,
      youtubeEnabled: false,
      youtubeConfigured: false,
      recordingQuotaBytes: 2 * 1024 ** 3,
      defaultLook: null,
      disabledLooks: [],
      cliLoginEnabled: true,
    })
    const off = await h.call('PATCH', base, {
      as: h.admin,
      body: { narrationEnabled: false, transcriptionProvider: 'elevenlabs' },
    })
    expect(off.status).toBe(200)
    expect(await h.json(off)).toEqual({
      narrationEnabled: false,
      transcriptionProvider: 'elevenlabs',
      takeQuotaBytes: NARRATION_SETTING_DEFAULTS.takeQuotaBytes,
      remixEnabled: true,
      webmcpEnabled: true,
      youtubeEnabled: false,
      youtubeConfigured: false,
      recordingQuotaBytes: 2 * 1024 ** 3,
      defaultLook: null,
      disabledLooks: [],
      cliLoginEnabled: true,
    })
    await h.call('PATCH', base, {
      as: h.admin,
      body: { takeQuotaBytes: 512 * 1024 ** 2, recordingQuotaBytes: 3 * 1024 ** 3 },
    })
    expect(await h.json(await h.call('GET', base, { as: h.admin }))).toEqual({
      narrationEnabled: false,
      transcriptionProvider: 'elevenlabs',
      takeQuotaBytes: 512 * 1024 ** 2,
      remixEnabled: true,
      webmcpEnabled: true,
      youtubeEnabled: false,
      youtubeConfigured: false,
      recordingQuotaBytes: 3 * 1024 ** 3,
      defaultLook: null,
      disabledLooks: [],
      cliLoginEnabled: true,
    })
    expect(h.deps.logs.some((l) => l.includes('"settings.updated"'))).toBe(true)
  })
})

describe('admin settings', () => {
  it('is for admins only', async () => {
    const h = harness()
    const reviewer = await person(h, 'u_rev', 'reviewer')
    for (const as of [h.member, reviewer]) {
      expect((await h.call('GET', base, { as })).status).toBe(403)
      expect((await h.call('PATCH', base, { as, body: { narrationEnabled: false } })).status).toBe(403)
    }
    expect(await narrationEnabled(h.deps)).toBe(true)
  })

  it('refuses values out of range', async () => {
    const h = harness()
    for (const body of [
      { transcriptionProvider: 'whisper' },
      { takeQuotaBytes: 10 },
      { takeQuotaBytes: 1.5 },
    ])
      expect((await h.call('PATCH', base, { as: h.admin, body })).status).toBe(400)
  })

  it('tells the web app whether recording is on, at once', async () => {
    const h = harness()
    const flag = async () => (await h.json(await h.call('GET', '/api/v1/config'))).narrationEnabled
    expect(await flag()).toBe(true)
    await h.call('PATCH', base, { as: h.admin, body: { narrationEnabled: false } })
    expect(await flag()).toBe(false)
  })

  it('refuses narration operations with 409 narration_disabled while it is off', async () => {
    const h = harness()
    await expect(assertNarrationEnabled(h.deps)).resolves.toBeUndefined()
    await h.call('PATCH', base, { as: h.admin, body: { narrationEnabled: false } })
    const e = await assertNarrationEnabled(h.deps).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ code: 'narration_disabled', status: 409 })
  })
})

describe('secure-context setup check', () => {
  it('passes over HTTPS and on localhost, and warns (never blocks) otherwise', async () => {
    expect(secureContext('https://video.example.com')).toBe(true)
    expect(secureContext('http://localhost:8888')).toBe(true)
    expect(secureContext('http://127.0.0.1:8888')).toBe(true)
    expect(secureContext('http://video.example.com')).toBe(false)
    expect(secureContext('not a url')).toBe(false)

    const ok = harness()
    const okRes = await ok.json(await ok.call('GET', '/api/health?fresh=1'))
    expect(okRes.checks.find((c: { id: string }) => c.id === 'secure-context').status).toBe('ok')

    const h = harness({ URL: 'http://video.example.com' })
    const r = await h.json(await h.call('GET', '/api/health?fresh=1'))
    const c = r.checks.find((x: { id: string }) => x.id === 'secure-context')
    expect(c.status).toBe('warn')
    expect(c.detail).toMatch(/record/)
    expect(r.ready).toBe(true)
  })
})
