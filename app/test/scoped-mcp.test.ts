// Redo a scene over MCP (plan §4.13): get_video lists each version's scenes (filling older ones), revise_video takes
// beats with from_version, and refusals pass through in plain words.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../server/domain/engines.js'
import { load, save } from '../server/lib/contract.js'
import { hyperframesScopeCheck } from '../server/lib/scope.js'
import { apiKey, harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)

beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

async function tool(h: Harness, key: string, name: string, args: Record<string, unknown>) {
  const res = await h.call('POST', '/api/mcp', {
    origin: null,
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  const body = (await res.json()) as {
    result: { structuredContent: any; isError?: boolean; content: { text: string }[] }
  }
  return {
    data: body.result.structuredContent,
    isError: body.result.isError === true,
    text: body.result.content.map((c) => c.text).join('\n'),
  }
}
async function setup() {
  const h = harness()
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: music },
    { name: 'video/summary.json', body: '{"captions":[]}' },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return { h, id: v.id as string, key: await apiKey(h, h.member) }
}

describe('redo a scene over MCP', () => {
  it('get_video lists scenes, filling an older version’s once', async () => {
    const { h, id, key } = await setup()
    await h.deps.store.updateVersion(id, 1, { beats: null })
    const r = await tool(h, key, 'get_video', { video_id: id })
    expect(r.isError).toBe(false)
    expect(r.data.versions[0].beats).toEqual([
      { id: 'intro', label: 'Opening', start: 0, duration: 3 },
      { id: 'demo', label: null, start: 3, duration: 3 },
      { id: 'outro', label: null, start: 6, duration: 3 },
    ])
    expect((await h.deps.store.getVersion(id, 1))?.beats).toHaveLength(3)
  })

  it('revise_video redoes only the scenes named, and get_video says which', async () => {
    const { h, id, key } = await setup()
    const r = await tool(h, key, 'revise_video', {
      video_id: id,
      from_version: 1,
      beats: ['demo'],
      change: 'Make the subtitle say Ship on Friday.',
    })
    expect(r.isError).toBe(false)
    expect((await h.deps.store.getVersion(id, 2))?.scope).toEqual({ beats: ['demo'] })
    const v = await tool(h, key, 'get_video', { video_id: id })
    expect(v.data.versions[0].redid_scenes).toEqual([{ id: 'demo', label: 'demo' }])
  })

  it('passes refusals through: no from_version, an unknown scene', async () => {
    const { h, id, key } = await setup()
    const missing = await tool(h, key, 'revise_video', { video_id: id, beats: ['demo'], change: 'Redo it.' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('Say which version the scenes are from (fromVersion)')
    const unknown = await tool(h, key, 'revise_video', {
      video_id: id,
      from_version: 1,
      beats: ['feature'],
      change: 'Redo it.',
    })
    expect(unknown.isError).toBe(true)
    expect((JSON.parse(unknown.text) as { error: { message: string } }).error.message).toContain(
      `There's no scene "feature". This video's scenes: intro (Opening), demo, outro.`,
    )
  })
})
