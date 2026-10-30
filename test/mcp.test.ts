import { describe, expect, it } from 'vitest'
import { normalizeAspect, normalizeDuration, normalizeVideoId } from '../src/mcp.js'
import { harness, type Harness } from './helpers.js'

async function rpc(
  h: Harness,
  key: string | null,
  method: string,
  params: unknown = {},
  id = 1,
  path = '/api/mcp',
) {
  const res = await h.call('POST', path, {
    origin: null,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: { jsonrpc: '2.0', id, method, params },
  })
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() }
}

async function tool(h: Harness, key: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(h, key, 'tools/call', { name, arguments: args })
  const result = (r.body as { result: { structuredContent: any; isError?: boolean } }).result
  return { data: result.structuredContent, isError: result.isError === true }
}

async function setup() {
  const h = harness()
  const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: h.member, body: { name: 'claude' } })))
    .key as string
  return { h, key }
}

describe('MCP', () => {
  it('serves the short /mcp URL too', async () => {
    const { h, key } = await setup()
    const r = await rpc(h, key, 'tools/list', {}, 1, '/mcp')
    expect(r.status).toBe(200)
    expect((r.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(7)
  })

  it('initializes and lists seven tools with instructions', async () => {
    const { h, key } = await setup()
    const init = await rpc(h, key, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.status).toBe(200)
    expect((init.body as any).result.instructions).toContain('create_video')
    const list = await rpc(h, key, 'tools/list')
    const names = (list.body as any).result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual([
      'cancel_video',
      'create_video',
      'get_video',
      'list_videos',
      'publish_video',
      'revise_video',
      'unpublish_video',
    ])
  })

  it('creates, follows, revises and publishes a video through tools', async () => {
    const { h, key } = await setup()
    const created = await tool(h, key, 'create_video', {
      prompt: 'A 10-second teaser that says "Ship faster", ending on "Try it today".',
      aspect: 'vertical',
      duration_sec: 'auto',
    })
    expect(created.isError).toBe(false)
    expect(created.data.aspect).toBe('9:16')
    expect(created.data.status).toBe('queued')
    const id = created.data.video_id as string
    await h.drive(4)
    const got = await tool(h, key, 'get_video', { video_id: `https://video.example.com/videos/${id}` })
    expect(got.data.status).toBe('ready')
    expect(got.data.versions[0].downloads.mp4).toMatch(
      new RegExp(
        `^https://video.example.com/files/${id}/v1/video.mp4\\?exp=\\d+&sig=[0-9a-f]{64}&download=1$`,
      ),
    )
    expect(got.data.next_actions.join(' ')).toContain('publish_video')

    const revised = await tool(h, key, 'revise_video', { video_id: id, change: 'Make the end card orange.' })
    expect(revised.data.latest_version).toBe(2)
    const again = await tool(h, key, 'revise_video', { video_id: id, change: 'And bigger.' })
    expect(again.isError).toBe(true)
    expect(again.data.error.type).toBe('CONFLICT')
    expect(again.data.error.data.suggested_tool_calls[0].name).toBe('get_video')
    await h.drive(4)

    const pub = await tool(h, key, 'publish_video', { video_id: id })
    expect(pub.data.version).toBe(2)
    expect(pub.data.urls.page).toMatch(/\/v\/[a-z2-9]+$/)
    const list = await tool(h, key, 'list_videos', { query: 'ship faster', mine: true })
    expect(list.data.videos[0]).toMatchObject({ video_id: id, public: true, versions: 2 })
    const un = await tool(h, key, 'unpublish_video', { video_id: id })
    expect(un.data.unpublished).toBe(true)
  })

  it('returns helpful errors instead of failing', async () => {
    const { h, key } = await setup()
    const bad = await tool(h, key, 'create_video', {
      prompt: 'A short video about our product launch.',
      aspect: 'cinema',
    })
    expect(bad.isError).toBe(true)
    expect(bad.data.error).toMatchObject({
      type: 'INVALID_ARGUMENT',
      data: { available_options: ['16:9', '9:16', '1:1', '4:5'] },
    })
    const missing = await tool(h, key, 'get_video', { video_id: 'vid_doesnotexist' })
    expect(missing.data.error.type).toBe('NOT_FOUND')
    const notId = await tool(h, key, 'get_video', { video_id: 'my latest video' })
    expect(notId.data.error.data.suggested_tool_calls[0].name).toBe('list_videos')
  })

  it('requires an API key', async () => {
    const { h } = await setup()
    expect((await rpc(h, null, 'tools/list')).status).toBe(401)
    expect((await rpc(h, 'nva_bad_key', 'tools/list')).status).toBe(401)
  })
})

describe('MCP input normalization', () => {
  it('reads aspects, durations and ids the way people write them', () => {
    expect(normalizeAspect('Vertical')).toBe('9:16')
    expect(normalizeAspect('16x9')).toBe('16:9')
    expect(normalizeAspect('square')).toBe('1:1')
    expect(normalizeAspect(undefined)).toBeUndefined()
    expect(normalizeDuration('30s')).toBe(30)
    expect(normalizeDuration('2 min')).toBe(120)
    expect(normalizeDuration('auto')).toBeUndefined()
    expect(normalizeDuration(12.4)).toBe(12)
    expect(normalizeVideoId('https://x.netlify.app/videos/vid_01ABC')).toBe('vid_01abc')
  })
})
