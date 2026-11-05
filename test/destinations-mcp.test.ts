// Publish destinations over MCP (docs/plans/2026-11-04-publish-destinations.md §6.4): list_destinations (with a
// destination's targets), publish_video to a destination, unpublish_video by publication; the share page default.
import { describe, expect, it } from 'vitest'
import { apiKey, harness, mcpCall, readyVideo } from './helpers.js'

const tool = async (h: ReturnType<typeof harness>, key: string, name: string, args: object) => {
  const r = await mcpCall(h, key, 'tools/call', { name, arguments: args })
  return JSON.parse(r.content[0].text)
}

describe('destinations over MCP', () => {
  it('lists destinations and targets, publishes to one and removes it', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const dest = await h.json(
      await h.call('POST', '/api/v1/admin/destinations', {
        as: h.admin,
        body: { name: 'Sites', url: 'https://r.example.com/hook' },
      }),
    )
    await h.deps.store.updateDestination(dest.id, { capabilities: { targets: true, targetNoun: 'site' } })
    h.deps.http.receiver = ({ headers }) =>
      headers['x-video-agent-event'] === 'targets'
        ? {
            status: 200,
            body: JSON.stringify({
              targets: [{ id: 's1', name: 'Site one', description: null, url: null, metadata: null }],
            }),
          }
        : { status: 202, body: JSON.stringify({ status: 'accepted' }) }
    const key = await apiKey(h, h.member)
    const listed = await tool(h, key, 'list_destinations', { video_id: id, destination: dest.id })
    expect(listed.destinations.map((d: { id: string }) => d.id)).toEqual(['share_page', dest.id])
    expect(listed.targets).toEqual([
      { id: 's1', name: 'Site one', description: null, url: null, metadata: null },
    ])

    const pub = await tool(h, key, 'publish_video', {
      video_id: id,
      destination: dest.id,
      target: listed.targets[0],
    })
    expect(pub.publication).toMatchObject({ kind: 'http', status: 'queued', target: { name: 'Site one' } })
    const removed = await tool(h, key, 'unpublish_video', { video_id: id, publication: pub.publication.id })
    expect(removed).toMatchObject({ unpublished: true, publication: { desired: 'removed' } })

    // Without a destination, publish_video still means the share page.
    const share = await tool(h, key, 'publish_video', { video_id: id })
    expect(share.urls.page).toMatch(/\/v\//)
  })
})
