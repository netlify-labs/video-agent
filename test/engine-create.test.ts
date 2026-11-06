// The engine on create (render-engines plan §4.2, §6, §7): a request may name one (it must be on here and listed by
// the look), what the engine can't make is refused, a remix needs its source's engine on, and turning an engine off
// never refuses work on the videos already made with it.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import { apiKey, harness, mcpCall, pgStore, PROMPT, type Harness } from './helpers.js'
import { remotionBundle } from './remotion-files.js'
import { tarGz } from './tarball.js'

const ack = {
  by: 'u_admin',
  email: 'admin@acme.com',
  at: '2026-11-05T00:00:00Z',
  tier: 'free' as const,
  note: null,
}

const create = (h: Harness, body: Record<string, unknown>) =>
  h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, ...body } })
const errorOf = async (res: Response) => ({
  status: res.status,
  ...((await res.json()) as { error: { code: string; details?: unknown } }).error,
})

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('the engine on create (%s)', { timeout: 20_000 }, (_name, stores) => {
  /** A deployment with Remotion in ENGINES, a license recorded, and the admin switch as given. */
  async function deployment(on = true) {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await getSettings(h.deps)
    await h.deps.store.updateSettings({ remotionEnabled: on, remotionLicenseAck: ack })
    return h
  }
  const refusals = (h: Harness) =>
    h.deps.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'api.error' && String(l.code).startsWith('engine_'))

  it('a request may name Remotion when it is on; the version is made with it', async () => {
    const h = await deployment()
    const res = await create(h, { engine: 'remotion', sound: 'music' })
    expect(res.status).toBe(202)
    const id = ((await res.json()) as { id: string }).id
    expect((await h.deps.store.getVersion(id, 1))?.engine).toBe('remotion')
  })

  it('no engine and no look is HyperFrames', async () => {
    const h = await deployment()
    const id = ((await (await create(h, {})).json()) as { id: string }).id
    expect((await h.deps.store.getVersion(id, 1))?.engine).toBe('hyperframes')
  })

  it('Remotion while it is off (or without ENGINES) is 409 engine_disabled', async () => {
    expect(await errorOf(await create(await deployment(false), { engine: 'remotion' }))).toMatchObject({
      status: 409,
      code: 'engine_disabled',
    })
    const plain = harness({}, await stores())
    expect(await errorOf(await create(plain, { engine: 'remotion' }))).toMatchObject({
      status: 409,
      code: 'engine_disabled',
    })
  })

  it('an engine the look does not list is 400 engine_not_supported_by_look', async () => {
    const h = await deployment()
    expect(await errorOf(await create(h, { engine: 'remotion', look: 'clean' }))).toMatchObject({
      status: 400,
      code: 'engine_not_supported_by_look',
    })
  })

  it.each([
    ['sound effects', { sound: 'music_sfx' }, 'sound'],
    ['a voice-over', { voiceover: { enabled: true } }, 'voiceover'],
  ])('Remotion with %s is 409 engine_unsupported, logged', async (_label, body, capability) => {
    const h = await deployment()
    expect(await errorOf(await create(h, { engine: 'remotion', ...body }))).toMatchObject({
      status: 409,
      code: 'engine_unsupported',
      details: { capability },
    })
    expect(refusals(h).at(-1)).toMatchObject({ code: 'engine_unsupported', status: 409 })
    // Nothing was made.
    expect((await h.json(await h.call('GET', '/api/v1/videos', { as: h.member }))).items).toHaveLength(0)
  })

  it('MCP create_video offers engine only where Remotion is on, with the same refusals', async () => {
    const off = harness({}, await stores())
    const offTools = (await mcpCall(off, await apiKey(off, off.member), 'tools/list', {})).tools as {
      name: string
      inputSchema: { properties: Record<string, unknown> }
    }[]
    expect(offTools.find((t) => t.name === 'create_video')?.inputSchema.properties).not.toHaveProperty(
      'engine',
    )

    const h = await deployment()
    const key = await apiKey(h, h.member)
    const tools = (await mcpCall(h, key, 'tools/list', {})).tools as typeof offTools
    expect(tools.find((t) => t.name === 'create_video')?.inputSchema.properties.engine).toMatchObject({
      enum: ['hyperframes', 'remotion'],
    })
    const call = (args: Record<string, unknown>) =>
      mcpCall(h, key, 'tools/call', { name: 'create_video', arguments: { prompt: PROMPT, ...args } })
    const refused = await call({ engine: 'remotion', sound: 'music_sfx' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.structuredContent)).toContain("Remotion videos can't have sound effects")
    const made = await call({ engine: 'remotion', sound: 'music' })
    expect(made.isError).toBeFalsy()
  })

  it('turning Remotion off refuses a remix of a Remotion video, never a revision of one', async () => {
    const h = await deployment()
    h.deps.nextSource = tarGz(remotionBundle())
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    const id = ((await (await create(h, { engine: 'remotion' })).json()) as { id: string }).id
    await h.drive(4)
    await h.deps.store.updateSettings({ remotionEnabled: false })

    const remix = await h.call('POST', `/api/v1/videos/${id}/remix`, {
      as: h.member,
      body: { prompt: 'The same for org secrets.' },
    })
    expect(await errorOf(remix)).toMatchObject({ status: 409, code: 'engine_disabled' })

    const revise = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    expect(revise.status).toBe(202)
    expect((await h.deps.store.getVersion(id, 2))?.engine).toBe('remotion')
  })

  it('a revision of a Remotion video asking for sound effects is 409 engine_unsupported', async () => {
    const h = await deployment()
    h.deps.nextSource = tarGz(remotionBundle())
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    const id = ((await (await create(h, { engine: 'remotion' })).json()) as { id: string }).id
    await h.drive(4)
    const res = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Add whooshes.', sound: 'music_sfx' },
    })
    expect(await errorOf(res)).toMatchObject({
      status: 409,
      code: 'engine_unsupported',
      details: { capability: 'sound' },
    })
  })
})
