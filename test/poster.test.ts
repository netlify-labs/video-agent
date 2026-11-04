// Picked posters (src/domain/poster.ts): a frame or an uploaded image, checked (type, width, the video's shape) and
// stored under new immutable names; the DTO's signed links, the redirect route and the files edge follow; a published
// version's share page follows at once; a reset goes back to the render's poster without reusing a name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pubKey } from '../src/domain/videos.js'
import type { Store } from '../src/store/types.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { harness, person, pgStore, readyVideo, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))
afterEach(() => {
  current = null
})

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]

const edge = async (name: 'files' | 'public', url: string) =>
  (await loadEdge(name))(new Request(new URL(url, 'https://video.example.com')), {
    deploy: { published: true },
  })

/** A JPEG header with just a SOF0 segment: enough for classify() to read its size. `tag` makes the bytes unique. */
function jpeg(w: number, h: number, tag = 0): string {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, tag, 0x00]
  // prettier-ignore
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)
  b.push(0xff, 0xd9)
  return Buffer.from(b).toString('base64')
}

/** A VP8X WebP header of the given size. */
function webp(w: number, h: number): string {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0)
  b.writeUInt32LE(22, 4)
  b.write('WEBPVP8X', 8)
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(w - 1, 24, 3)
  b.writeUIntLE(h - 1, 27, 3)
  return b.toString('base64')
}

const LQIP = `data:image/webp;base64,${webp(16, 9)}`

const setPoster = (h: Harness, id: string, body: unknown, as = h.member) =>
  h.call('PUT', `/api/v1/videos/${id}/versions/1/poster`, { as, body })
const version = async (h: Harness, id: string) =>
  (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).versions[0]
const mirrorOf = (h: Harness, slug: string) =>
  JSON.parse(h.deps.blobs.text('internal', pubKey(slug)) ?? 'null') as {
    keys: { poster: string; posterWebp?: string | null }
  } | null

describe.each(stores)('picked posters (%s)', (_name, store) => {
  it('a frame: new files, signed links, the redirect and the files edge follow; reset goes back', async () => {
    const s = await store()
    const h = harness({}, s ? { store: s } : {})
    current = h.deps
    const id = await readyVideo(h, h.member)
    const before = await version(h, id)
    expect(before.poster).toBeNull()
    expect(before.files.poster).toContain('/poster.jpg?')

    const r = await setPoster(h, id, {
      source: 'frame',
      at: 1.25,
      jpg: jpeg(1920, 1080, 1),
      webp480: webp(480, 270),
      webp960: webp(960, 540),
      lqip: LQIP,
    })
    expect(r.status).toBe(200)
    expect(await h.json(r)).toEqual({ source: 'frame', at: 1.25 })

    const v = await version(h, id)
    expect(v.poster).toEqual({ source: 'frame', at: 1.25 })
    expect(v.files.poster).toContain(`/files/${id}/v1/poster.r1.jpg?`)
    expect(v.files.posterSources).toEqual([
      {
        type: 'image/webp',
        srcset: expect.stringMatching(/poster-480\.r1\.webp\?.* 480w, .*poster-960\.r1\.webp\?.* 960w/),
      },
    ])
    expect(v.files.lqip).toBe(LQIP)
    // The signed link serves the picked bytes.
    const served = await edge('files', new URL(v.files.poster).pathname + new URL(v.files.poster).search)
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).toString('base64')).toBe(jpeg(1920, 1080, 1))
    // The redirect route signs the picked name too.
    const link = await h.call('GET', `/api/v1/videos/${id}/versions/1/poster`, { as: h.member })
    expect(link.status).toBe(302)
    expect(link.headers.get('location')).toContain('/poster.r1.jpg?')

    // Reset: the render's poster again, and the next pick gets a new name (r2), never r1's.
    expect((await h.call('DELETE', `/api/v1/videos/${id}/versions/1/poster`, { as: h.member })).status).toBe(
      204,
    )
    const reset = await version(h, id)
    expect(reset.poster).toBeNull()
    expect(reset.files.poster).toContain('/poster.jpg?')
    expect((await setPoster(h, id, { source: 'upload', jpg: jpeg(1280, 720, 2) })).status).toBe(200)
    const again = await version(h, id)
    expect(again.poster).toEqual({ source: 'upload', at: null })
    expect(again.files.poster).toContain('/poster.r2.jpg?')
    // No WebPs sent: no picture sources, and not the render's either (they show a different frame).
    expect(again.files.posterSources).toBeUndefined()
  })

  it('moves the ETag', async () => {
    const s = await store()
    const h = harness({}, s ? { store: s } : {})
    current = h.deps
    const id = await readyVideo(h, h.member)
    const before = await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })
    expect((await setPoster(h, id, { source: 'upload', jpg: jpeg(1920, 1080) })).status).toBe(200)
    const after = await h.call('GET', `/api/v1/videos/${id}`, {
      as: h.member,
      headers: { 'if-none-match': before.headers.get('etag') ?? '' },
    })
    expect(after.status).toBe(200)
  })
})

describe('picked posters', () => {
  it('rejects the wrong type, width, shape, a missing second and a bad placeholder', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const bad = async (body: unknown) => {
      const r = await setPoster(h, id, body)
      expect(r.status).toBe(400)
      return (await h.json(r)).error.message as string
    }
    expect(await bad({ source: 'upload', jpg: webp(1920, 1080) })).toMatch(/JPEG/)
    expect(await bad({ source: 'upload', jpg: jpeg(200, 112) })).toMatch(/320 to 1920 px wide/)
    expect(await bad({ source: 'upload', jpg: jpeg(1080, 1080) })).toMatch(/video's shape/)
    expect(await bad({ source: 'frame', jpg: jpeg(1920, 1080) })).toMatch(/second inside the video/)
    expect(await bad({ source: 'frame', at: 99, jpg: jpeg(1920, 1080) })).toMatch(/second inside the video/)
    expect(await bad({ source: 'upload', jpg: jpeg(1920, 1080), webp960: webp(1920, 1080) })).toMatch(
      /px wide/,
    )
    expect(await bad({ source: 'upload', jpg: jpeg(1920, 1080), lqip: 'data:text/html,hi' })).toMatch(
      /data URI/,
    )
    expect(await bad({ source: 'upload', jpg: 'not base64!' })).toMatch(/base64/)
    expect((await version(h, id)).poster).toBeNull()
  })

  it('only the owner or an admin', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const other = await person(h, 'u_other', 'creator')
    expect((await setPoster(h, id, { source: 'upload', jpg: jpeg(1920, 1080) }, other)).status).toBe(403)
    expect((await h.call('DELETE', `/api/v1/videos/${id}/versions/1/poster`, { as: other })).status).toBe(403)
  })

  it('a published version: the share page shows the picked poster at once, and the render’s after a reset', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member, body: {} }),
    )
    expect(mirrorOf(h, pub.slug)?.keys.poster).toBe(`${id}/v1/poster.jpg`)

    expect(
      (await setPoster(h, id, { source: 'frame', at: 1, jpg: jpeg(1920, 1080, 7), webp960: webp(960, 540) }))
        .status,
    ).toBe(200)
    expect(mirrorOf(h, pub.slug)?.keys).toMatchObject({
      poster: `${id}/v1/poster.r1.jpg`,
      posterWebp: `${id}/v1/poster-960.r1.webp`,
    })
    const jpg = await edge('public', `/v/${pub.slug}.jpg`)
    expect(Buffer.from(await jpg.arrayBuffer()).toString('base64')).toBe(jpeg(1920, 1080, 7))
    expect((await edge('public', `/v/${pub.slug}.webp`)).status).toBe(200)
    expect(await (await edge('public', `/v/${pub.slug}`)).text()).toContain(
      `poster="https://video.example.com/v/${pub.slug}.webp"`,
    )
    // The DTO's public links offer the WebP too.
    expect((await version(h, id)).publications[0].urls.posterWebp).toBe(
      `${h.deps.config.siteUrl}/v/${pub.slug}.webp`,
    )

    expect((await h.call('DELETE', `/api/v1/videos/${id}/versions/1/poster`, { as: h.member })).status).toBe(
      204,
    )
    expect(mirrorOf(h, pub.slug)?.keys.poster).toBe(`${id}/v1/poster.jpg`)
    const back = await edge('public', `/v/${pub.slug}.jpg`)
    expect(Buffer.from(await back.arrayBuffer()).toString('base64')).not.toBe(jpeg(1920, 1080, 7))
  })

  it('an upload without WebPs: the share page uses the JPEG, never the render’s WebP', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    // The render made a 960w WebP.
    await h.deps.blobs.set('videos', `${id}/v1/poster-960.webp`, Buffer.from(webp(960, 540), 'base64'), {
      size: '30',
    })
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member, body: {} }),
    )
    expect((await setPoster(h, id, { source: 'upload', jpg: jpeg(1920, 1080) })).status).toBe(200)
    expect(mirrorOf(h, pub.slug)?.keys.posterWebp).toBeNull()
    expect((await edge('public', `/v/${pub.slug}.webp`)).status).toBe(404)
    expect(await (await edge('public', `/v/${pub.slug}`)).text()).toContain(
      `poster="https://video.example.com/v/${pub.slug}.jpg"`,
    )
  })
})
