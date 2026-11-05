// Looks over MCP (plan 2026-11-04-looks §4.10): list_looks for every role (disabled looks left out), look on
// create_video, and the restyle wording on revise_video and remix_video.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import { apiKey, harness, mcpCall, person } from './helpers.js'

type Tool = {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, { description?: string }> }
}
const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>

describe('looks over MCP', () => {
  it('lists enabled looks to every role, with previews', async () => {
    const h = harness()
    await getSettings(h.deps)
    await h.deps.store.updateSettings({ disabledLooks: ['terminal'] })
    for (const role of ['viewer', 'creator'] as const) {
      const key = await apiKey(h, await person(h, `u_${role}`, role))
      const r = text(await mcpCall(h, key, 'tools/call', { name: 'list_looks', arguments: {} }))
      expect((r.looks as { id: string }[]).map((l) => l.id)).toEqual(['clean', 'kinetic'])
      expect(r.default).toBeNull()
    }
  })

  it('creates with a look, and says a different look on revise or remix is a full run', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const r = text(
      await mcpCall(h, key, 'tools/call', {
        name: 'create_video',
        arguments: { prompt: 'A short launch video for Lumen search', look: 'kinetic' },
      }),
    )
    const v = (await h.deps.store.getVersion(r.video_id as string, 1))!
    expect(v.look?.id).toBe('kinetic')
    const { tools } = (await mcpCall(h, key, 'tools/list', {})) as { tools: Tool[] }
    for (const name of ['revise_video', 'remix_video'])
      expect(tools.find((t) => t.name === name)?.inputSchema.properties?.look?.description).toContain(
        'a full run',
      )
    expect(tools.find((t) => t.name === 'create_video')?.inputSchema.properties?.look).toBeDefined()
  })
})
