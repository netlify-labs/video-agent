// Backfilling preview variants onto versions rendered before them: admins only, write-once, checked like finalize.
import { describe, expect, it } from 'vitest'
import { harness, person, raw, readyVideo, type Harness } from './helpers.js'

const webp = () => new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 1, 2, 3])
const LQIP = 'data:image/webp;base64,UklGRhoAAABXRUJQ'
const put = (h: Harness, as: string, id: string, name: string, body: Uint8Array) =>
  raw(h, as, 'PUT', `/api/v1/videos/${id}/versions/1/previews/${name}`, body)

interface Files {
  posterSources?: { type: string; srcset: string }[]
  lqip?: string
}
const filesOf = async (h: Harness, id: string) =>
  (
    await h.json<{ versions: { files: Files | null }[] }>(
      await h.call('GET', `/api/v1/videos/${id}`, { as: h.admin }),
    )
  ).versions[0]?.files

describe('preview backfill', () => {
  it('an admin adds variants and the placeholder once each; the version then offers them', async () => {
    const h = harness()
    const id = await readyVideo(h)
    expect((await filesOf(h, id))?.posterSources).toBeUndefined()
    for (const name of ['poster-480.webp', 'poster-960.webp'])
      expect((await put(h, h.admin, id, name, webp())).status).toBe(201)
    expect((await put(h, h.admin, id, 'lqip', new TextEncoder().encode(LQIP))).status).toBe(201)
    const f = await filesOf(h, id)
    expect(f?.posterSources?.map((s) => s.type)).toEqual(['image/webp'])
    expect(f?.lqip).toBe(LQIP)
    expect(await h.deps.blobs.get('videos', `${id}/v1/poster-480.webp`)).toEqual(webp())
    // Write-once: neither a variant nor the placeholder is replaced.
    expect((await put(h, h.admin, id, 'poster-480.webp', webp())).status).toBe(409)
    expect((await put(h, h.admin, id, 'lqip', new TextEncoder().encode(LQIP))).status).toBe(409)
  })

  it('refuses non-admins, wrong formats, bad placeholders, unknown names and versions without output', async () => {
    const h = harness()
    const id = await readyVideo(h)
    expect((await put(h, h.member, id, 'poster-480.webp', webp())).status).toBe(403)
    const reviewer = await person(h, 'u_rita', 'reviewer')
    expect((await put(h, reviewer, id, 'poster-480.webp', webp())).status).toBe(403)
    // An AVIF name with WebP bytes, an empty clip, a placeholder that isn't a data URI.
    expect((await put(h, h.admin, id, 'poster-480.avif', webp())).status).toBe(400)
    expect((await put(h, h.admin, id, 'clip.webm', new Uint8Array())).status).toBe(400)
    expect((await put(h, h.admin, id, 'lqip', new TextEncoder().encode('url(javascript:x)'))).status).toBe(
      400,
    )
    // The required outputs are out of reach.
    expect((await put(h, h.admin, id, 'poster.jpg', webp())).status).toBe(400)
    expect((await put(h, h.admin, id, 'video.mp4', webp())).status).toBe(400)
    const queued = await h.json(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: 'Another short video about webhooks.' },
      }),
    )
    expect((await put(h, h.admin, queued.id as string, 'poster-480.webp', webp())).status).toBe(404)
    expect((await filesOf(h, id))?.posterSources).toBeUndefined()
  })
})
