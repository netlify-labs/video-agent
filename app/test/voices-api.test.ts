// GET /api/v1/voices: the ElevenLabs voices the picker offers. None without ElevenLabs (Kokoro is the free default);
// the account's own voices when the server can list them; ElevenLabs' default voices otherwise.
import { beforeEach, describe, expect, it } from 'vitest'
import { ELEVENLABS_DEFAULT_VOICES, resetVoicesCache } from '../server/domain/voices.js'
import { harness, type Harness } from './helpers.js'

type Voices = {
  provider: string
  default: string | null
  source: string
  items: { id: string; name: string; description: string | null; previewUrl: string | null }[]
}
const voices = async (h: Harness) => {
  const res = await h.call('GET', '/api/v1/voices', { as: h.admin })
  expect(res.status).toBe(200)
  return h.json<Voices>(res)
}
const elevenlabs = (h: Harness, key: string | null, voiceId: string | null = null) => {
  h.deps.config.elevenlabsKeySet = true
  h.deps.config.elevenlabsApiKey = key
  h.deps.config.elevenlabsVoiceId = voiceId
}
const answer = (h: Harness, status: number, body: unknown) => {
  const calls: { url: string; key: string | null }[] = []
  h.deps.fetch = (url, init) => {
    calls.push({ url, key: new Headers(init?.headers).get('xi-api-key') })
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }
  return calls
}

describe('voices', () => {
  beforeEach(resetVoicesCache)

  it('needs a sign-in', async () => {
    expect((await harness().call('GET', '/api/v1/voices')).status).toBe(401)
  })

  it('lists nothing without ElevenLabs, and asks nobody', async () => {
    const h = harness()
    const calls = answer(h, 200, { voices: [] })
    expect(await voices(h)).toEqual({ provider: 'kokoro', default: null, source: 'none', items: [] })
    expect(calls).toEqual([])
  })

  it("lists the account's voices by name, with the deployment's default, and caches them", async () => {
    const h = harness()
    elevenlabs(h, 'sk_test', 'voiceB')
    const calls = answer(h, 200, {
      voices: [
        {
          voice_id: 'voiceB',
          name: 'Zoe',
          labels: { accent: 'british', description: 'calm' },
          preview_url: 'https://cdn.example/zoe.mp3',
        },
        { voice_id: 'voiceA', name: 'Abe', preview_url: 'http://insecure.example/abe.mp3' },
        { voice_id: 'bad id!', name: 'Nope' },
        { name: 'No id' },
      ],
    })
    const got = await voices(h)
    expect(got).toEqual({
      provider: 'elevenlabs',
      default: 'voiceB',
      source: 'account',
      items: [
        { id: 'voiceA', name: 'Abe', description: null, previewUrl: null },
        {
          id: 'voiceB',
          name: 'Zoe',
          description: 'british, calm',
          previewUrl: 'https://cdn.example/zoe.mp3',
        },
      ],
    })
    await voices(h)
    expect(calls).toEqual([{ url: 'https://api.elevenlabs.io/v1/voices', key: 'sk_test' }])
  })

  it("falls back to ElevenLabs' default voices when the key can't list voices", async () => {
    const h = harness()
    elevenlabs(h, 'sk_test')
    answer(h, 401, { detail: { status: 'missing_permissions' } })
    const got = await voices(h)
    expect(got.source).toBe('defaults')
    expect(got.items).toEqual(ELEVENLABS_DEFAULT_VOICES)
    expect(got.default).toBe('CwhRBWXzGAHq8TQ4Fs17')
  })

  it('falls back to the default voices when functions cannot read the key', async () => {
    const h = harness()
    elevenlabs(h, null, 'JBFqnCBsd6RMkjVDRZzb')
    const calls = answer(h, 200, { voices: [] })
    const got = await voices(h)
    expect(got).toMatchObject({ provider: 'elevenlabs', source: 'defaults', default: 'JBFqnCBsd6RMkjVDRZzb' })
    expect(calls).toEqual([])
  })
})
