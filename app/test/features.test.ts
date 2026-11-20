// GET /api/v1/config carries the deployment's version and its features (cli-and-sdk plan §5.1, roadmap shared rule 1).
import { describe, expect, it } from 'vitest'
import { readConfig } from '../server/deps.js'
import { FEATURES } from '../server/domain/features.js'
import { PROMPT_TEMPLATE_VERSION } from '../server/domain/prompt.js'
import { harness, type Harness } from './helpers.js'

type Config = {
  version: { commit: string | null; promptTemplate: number; release: string | null }
  features: string[]
  youtubeAvailable: boolean
}
const config = async (h: Harness) => h.json<Config>(await h.call('GET', '/api/v1/config'))
const settings = (h: Harness, body: Record<string, unknown>) =>
  h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body })

describe('config version and features', () => {
  it('reports the prompt template and the committed build info', async () => {
    const { version } = await config(harness())
    expect(version).toEqual({ commit: null, promptTemplate: PROMPT_TEMPLATE_VERSION, release: null })
  })

  it('lists what is on by default, needs no sign-in, and only known strings', async () => {
    const h = harness()
    const res = await h.call('GET', '/api/v1/config')
    expect(res.status).toBe(200)
    const { features } = await h.json<Config>(res)
    expect(features).toEqual(
      expect.arrayContaining(['remix', 'narration', 'destinations', 'context', 'external_ref']),
    )
    for (const f of features) expect(FEATURES).toContain(f)
    expect(features).not.toContain('rest_wait')
    expect(new Set(features).size).toBe(features.length)
  })

  it('follows the admin switches', async () => {
    const h = harness()
    expect((await settings(h, { remixEnabled: false })).status).toBe(200)
    expect((await config(h)).features).not.toContain('remix')
    expect((await settings(h, { narrationEnabled: false })).status).toBe(200)
    const off = await config(h)
    expect(off.features).not.toContain('narration')
    expect(off).toMatchObject({ remixEnabled: false, narrationEnabled: false })
    await settings(h, { remixEnabled: true, narrationEnabled: true })
    expect((await config(h)).features).toEqual(expect.arrayContaining(['remix', 'narration']))
  })

  it('lists planning only when the AI Gateway is available', async () => {
    const h = harness()
    h.deps.gateway.isAvailable = false
    expect((await config(h)).features).not.toContain('planning')
    h.deps.gateway.isAvailable = true
    expect((await config(h)).features).toContain('planning')
  })

  it('lists elevenlabs_voices only when the deployment has an ElevenLabs key', async () => {
    const h = harness()
    expect((await config(h)).features).not.toContain('elevenlabs_voices')
    h.deps.config.elevenlabsKeySet = true
    expect((await config(h)).features).toContain('elevenlabs_voices')
  })

  it('reads ElevenLabs from the key or, when the key is scoped to builds only, from the default voice', () => {
    expect(readConfig({}).elevenlabsKeySet).toBe(false)
    expect(readConfig({ ELEVENLABS_API_KEY: 'sk_test' }).elevenlabsKeySet).toBe(true)
    expect(readConfig({ ELEVENLABS_VOICE_ID: 'CwhRBWXzGAHq8TQ4Fs17' }).elevenlabsKeySet).toBe(true)
  })

  it('lists youtube exactly when YouTube is available', async () => {
    const c = await config(harness())
    expect(c.features.includes('youtube')).toBe(c.youtubeAvailable)
  })
})
