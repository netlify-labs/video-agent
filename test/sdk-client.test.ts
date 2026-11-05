// The SDK against the real routes, in process (cli-and-sdk plan §4.5): createApp with the fakes, the SDK's fetch
// pointed at app.fetch, a real API key.
import { describe, expect, it } from 'vitest'
import { isVideoAgentError, VideoAgent } from '../packages/sdk/src/index.js'
import { apiKey, harness, PROMPT, type Harness } from './helpers.js'

const sdk = async (h: Harness, o: { key?: boolean } = {}) => {
  const events: Record<string, unknown>[] = []
  const va = new VideoAgent({
    url: 'https://video.example.com',
    apiKey: o.key === false ? '' : await apiKey(h, h.member),
    fetch: async (input: string | URL | Request, init?: RequestInit) =>
      h.app.fetch(new Request(input, init), { context: { deploy: { published: true } } }),
    logger: (_e, f) => events.push(f),
  })
  return { va, events }
}

describe('SDK in process', () => {
  it('creates a video, and a retried create with the same key is the same video', async () => {
    const h = harness()
    const { va } = await sdk(h)
    const a = await va.videos.create({ prompt: PROMPT }, { idempotencyKey: 'same-key' })
    const b = await va.videos.create({ prompt: PROMPT }, { idempotencyKey: 'same-key' })
    expect(b.id).toBe(a.id)
    const other = await va.videos.create({ prompt: PROMPT })
    expect(other.id).not.toBe(a.id)
    // The same key with another body is the server's conflict, reported as is.
    await expect(
      va.videos.create({ prompt: `${PROMPT} Again.` }, { idempotencyKey: 'same-key' }),
    ).rejects.toMatchObject({
      status: 409,
    })
  })

  it('reads the server config once and gates on its features', async () => {
    const h = harness()
    const { va, events } = await sdk(h)
    expect((await va.serverConfig()).features).toEqual(expect.arrayContaining(['remix', 'planning']))
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { remixEnabled: false } })
    // Cached: the client still believes remix is on, and the server's own refusal comes back.
    const v = await va.videos.create({ prompt: PROMPT })
    const fresh = (await sdk(h)).va
    const err = await fresh.videos.remix(v.id, { prompt: 'Make it orange' }).catch((e: unknown) => e)
    expect(isVideoAgentError(err, 'unsupported_by_server')).toBe(true)
    expect(events.filter((e) => e.path === '/api/v1/config')).toHaveLength(1)
  })

  it('maps API errors and works without a key on public routes', async () => {
    const h = harness()
    const { va } = await sdk(h)
    await expect(va.videos.get('v_missing')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    const anon = (await sdk(h, { key: false })).va
    expect((await anon.serverConfig()).version?.promptTemplate).toBeGreaterThan(0)
    await expect(anon.videos.list()).rejects.toMatchObject({ status: 401 })
  })

  it('raw is typed and authenticated', async () => {
    const h = harness()
    const { va } = await sdk(h)
    const { data } = await va.raw.GET('/api/v1/me')
    expect(data?.id).toBe('u_member')
  })
})
