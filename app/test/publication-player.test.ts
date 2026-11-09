// The publication DTO's `player` snippet (cli-and-sdk plan §7): this site's /player.js and the share page while
// published, null once unpublished; the same string reaches the SDK, the CLI and the MCP.
import { describe, expect, it } from 'vitest'
import { harness, readyVideo } from './helpers.js'

describe('publication player snippet', () => {
  it('is set while published and null once unpublished', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const pub = await h.json<{ player: string; urls: { page: string } }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
    )
    const site = h.deps.config.siteUrl
    expect(pub.player).toBe(
      `<script type="module" src="${site}/player.js"></script><video-agent-player src="${pub.urls.page}"></video-agent-player>`,
    )
    await h.call('DELETE', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member })
    const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    const gone = v.versions[0].publications.find(
      (p: { player: string | null; unpublishedAt: string | null }) => p.unpublishedAt,
    )
    expect(gone.player).toBeNull()
  })
})
