import { describe, expect, it } from 'vitest'
import { normalizeAspect, normalizeDuration, normalizeVideoId } from '../src/mcp.js'
import { apiKey, harness, mcpCall, person, type Harness } from './helpers.js'

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
  const key = await apiKey(h, h.member, 'claude')
  return { h, key }
}

describe('MCP', () => {
  it('serves the short /mcp URL too', async () => {
    const { h, key } = await setup()
    const r = await rpc(h, key, 'tools/list', {}, 1, '/mcp')
    expect(r.status).toBe(200)
    expect((r.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(21)
  })

  it('initializes and lists twenty-one tools with instructions', async () => {
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
      'add_comment',
      'add_narration',
      'cancel_video',
      'create_video',
      'get_music_job',
      'get_narration',
      'get_video',
      'import_music',
      'list_comments',
      'list_media',
      'list_videos',
      'plan_brief',
      'plan_video',
      'publish_video',
      'remix_video',
      'render_with_narration',
      'revise_video',
      'search_music',
      'set_verdict',
      'show_video',
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

  it('shows the video card for create, revise and show, and tells agents to keep checking', async () => {
    const { h, key } = await setup()
    const card = 'ui://video-agent/video-card.html'
    const { tools } = ((await rpc(h, key, 'tools/list')).body as any).result as {
      tools: { name: string; _meta?: { ui?: { resourceUri?: string } } }[]
    }
    const withCard = tools.filter((t) => t._meta?.ui?.resourceUri === card).map((t) => t.name)
    // Not get_video: agents call it over and over, and each call would add a card to the chat.
    expect(withCard.sort()).toEqual(['create_video', 'remix_video', 'revise_video', 'show_video'])

    const read = ((await rpc(h, key, 'resources/read', { uri: card })).body as any).result as {
      contents: { mimeType: string; text: string; _meta: { ui: { csp: { resourceDomains: string[] } } } }[]
    }
    expect(read.contents[0]?.mimeType).toBe('text/html;profile=mcp-app')
    expect(read.contents[0]?.text).toMatch(/^<!doctype html>/)
    expect(read.contents[0]?._meta.ui.csp.resourceDomains).toEqual(['https://video.example.com'])

    const created = await tool(h, key, 'create_video', {
      prompt: 'A 10-second teaser that says "Ship faster".',
    })
    const id = created.data.video_id as string
    expect(created.data.next_actions[0]).toContain('Keep checking without asking')
    expect(created.data.next_actions[0]).toContain('wait_seconds 8')
    await h.drive(4)
    const shown = await tool(h, key, 'show_video', { video_id: id })
    expect(shown.data).toMatchObject({ video_id: id, status: 'ready' })
    expect(shown.data.versions[0].downloads.mp4).toContain(`/files/${id}/v1/video.mp4`)
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

  it('logs why a request was refused, without its arguments or credentials', async () => {
    const { h, key } = await setup()
    // Accept without text/event-stream: the transport refuses it (406) before any tool runs.
    const res = await h.call('POST', '/api/mcp', {
      origin: null,
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_video', arguments: { prompt: 'secret words' } },
      },
    })
    const r = { status: res.status }
    expect(r.status).toBe(406)
    const line = h.deps.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'mcp.refused')
    expect(line).toMatchObject({
      status: 406,
      httpMethod: 'POST',
      methods: ['tools/call'],
      accept: 'application/json',
      principal: 'apiKey',
    })
    expect(line?.message).toEqual(expect.stringContaining('text/event-stream'))
    expect(JSON.stringify(line)).not.toContain('secret words')
    expect(JSON.stringify(line)).not.toContain(key)
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

  it('plans through MCP: plan_video asks, plan_brief writes the brief, create_video uses plan_id', async () => {
    const { h, key } = await setup()
    h.deps.gateway.replies.push(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            question: 'Who is it for?',
            why: '',
            options: [
              { id: 'a', label: 'Developers', description: '' },
              { id: 'b', label: 'Leads', description: '' },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      }),
      JSON.stringify({
        goal: 'g',
        audience: 'Developers',
        keyMessage: 'k',
        beats: [{ text: 'b', seconds: 2 }],
        tone: 't',
        callToAction: 'Read the docs',
        mustInclude: [],
        avoid: [],
      }),
    )
    const planned = await tool(h, key, 'plan_video', { prompt: 'A 30-second launch video for org webhooks' })
    expect(planned.data.questions[0]).toEqual(
      expect.objectContaining({
        question_id: 'q1',
        choices: [expect.objectContaining({ choice_id: 'a' }), expect.anything()],
      }),
    )
    const brief = await tool(h, key, 'plan_brief', {
      plan_id: planned.data.plan_id,
      answers: [{ question_id: 'q1', choice_ids: ['a'] }],
    })
    expect(brief.data.brief.callToAction).toBe('Read the docs')
    const created = await tool(h, key, 'create_video', {
      prompt: 'A 30-second launch video for org webhooks',
      plan_id: planned.data.plan_id,
    })
    expect(created.isError).toBe(false)
    const v = await h.deps.store.getVersion(created.data.video_id, 1)
    expect(v?.plan?.planId).toBe(planned.data.plan_id)
  })

  it('hides the planning tools when AI Gateway is unavailable', async () => {
    const { h, key } = await setup()
    h.deps.gateway.isAvailable = false
    const list = await rpc(h, key, 'tools/list')
    const names = (list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(names).not.toContain('plan_video')
  })
})

describe('MCP prompts', () => {
  const promptNames = async (h: Harness, cookie: string) => {
    const { prompts } = (await mcpCall(h, await apiKey(h, cookie), 'prompts/list', {})) as {
      prompts: { name: string; arguments?: { name: string; required?: boolean }[] }[]
    }
    return prompts
  }

  it('lists the recipes each role can use', async () => {
    const h = harness()
    const creator = await promptNames(h, h.member)
    expect(creator.map((p) => p.name).sort()).toEqual([
      'changelog_video',
      'localize_video',
      'pr_video',
      'review_video',
      'social_cut',
    ])
    expect(creator.find((p) => p.name === 'pr_video')?.arguments).toEqual([
      expect.objectContaining({ name: 'pr_url', required: true }),
      expect.objectContaining({ name: 'audience', required: false }),
      expect.objectContaining({ name: 'aspect', required: false }),
    ])
    const reviewer = await person(h, 'u_reviewer', 'reviewer')
    expect((await promptNames(h, reviewer)).map((p) => p.name)).toEqual(['review_video'])
    const viewer = await person(h, 'u_viewer', 'viewer')
    expect(await promptNames(h, viewer)).toEqual([])
  })

  it('returns a user message that walks through tools the caller has', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const { tools } = (await mcpCall(h, key, 'tools/list', {})) as { tools: { name: string }[] }
    const toolNames = new Set(tools.map((t) => t.name))
    const get = async (k: string, name: string, args: Record<string, string>) => {
      const r = (await mcpCall(h, k, 'prompts/get', { name, arguments: args })) as {
        messages: { role: string; content: { type: string; text: string } }[]
      }
      expect(r.messages).toHaveLength(1)
      expect(r.messages[0]?.role).toBe('user')
      return r.messages[0]?.content.text ?? ''
    }
    const mentionsOnly = (text: string, allowed: Set<string>) => {
      const named = [
        ...text.matchAll(/\b(?:[a-z]+_)+(?:video|videos|brief|media|comments|comment|verdict)\b/g),
      ]
        .map((m) => m[0])
        .filter((w) => /^(create|get|list|revise|publish|unpublish|cancel|plan|add|set)_/.test(w))
      for (const w of named) expect(allowed, `prompt names ${w}`).toContain(w)
      return named
    }

    const pr = await get(key, 'pr_video', { pr_url: 'https://github.com/acme/app/pull/42' })
    expect(pr).toContain('https://github.com/acme/app/pull/42')
    expect(pr).toContain('create_video')
    expect(pr).toContain('plan_video')
    expect(pr).toContain('wait for my go-ahead')
    mentionsOnly(pr, toolNames)

    const loc = await get(key, 'localize_video', {
      video_id: 'vid_abc',
      languages: 'German, French ,Japanese',
    })
    expect(loc).toContain('into German, French, Japanese')
    expect(loc).toContain('3 runs, one per language')
    expect(loc).toContain('revise_video with from_version')
    mentionsOnly(loc, toolNames)

    const cut = await get(key, 'social_cut', { video_id: 'vid_abc' })
    expect(cut).toContain('15-second 9:16 social cut')
    mentionsOnly(cut, toolNames)
    mentionsOnly(await get(key, 'changelog_video', { notes: '- Faster deploys' }), toolNames)

    // Without AI Gateway the recipes skip planning; reviewers aren't told to revise.
    h.deps.gateway.isAvailable = false
    expect(await get(key, 'pr_video', { pr_url: 'https://github.com/acme/app/pull/42' })).not.toContain(
      'plan_video',
    )
    const rita = await apiKey(h, await person(h, 'u_reviewer', 'reviewer'))
    const { tools: reviewerTools } = (await mcpCall(h, rita, 'tools/list', {})) as {
      tools: { name: string }[]
    }
    const review = await get(rita, 'review_video', { video_id: 'vid_abc', version: '2' })
    expect(review).toContain('version 2')
    expect(review).toContain('set_verdict')
    expect(review).not.toContain('revise_video')
    mentionsOnly(review, new Set(reviewerTools.map((t) => t.name)))
    expect(await get(key, 'review_video', { video_id: 'vid_abc' })).toContain(
      'revise_video with the comment_ids',
    )
  })

  it('says so in the server instructions', async () => {
    const h = harness()
    const init = (await mcpCall(h, await apiKey(h, h.member), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })) as { instructions: string; capabilities: Record<string, unknown> }
    expect(init.capabilities.prompts).toBeDefined()
    expect(init.instructions).toContain('prompts/list')
  })
})
