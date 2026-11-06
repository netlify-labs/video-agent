// /v/{slug}.json: the oEmbed the share page advertises, plus the player's metadata (cli-and-sdk plan §5.3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { embedHtml } from '../src/lib/credit-html.js'
import { pubKey } from '../src/domain/videos.js'
import { loadEdge } from './edge.js'
import { LQIP, previewFixtures, type TestDeps } from './fakes.js'
import { harness, readyVideo, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const ORIGIN = 'https://video.example.com'
const get = async (path: string, method = 'GET') =>
  (await loadEdge('public'))(new Request(`${ORIGIN}${path}`, { method }), { deploy: { published: true } })
const publish = async (h: Harness, id: string) =>
  h.json<{ slug: string; embed: string }>(
    await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
  )
type OEmbed = Record<string, unknown> & { video_agent: Record<string, unknown> }

const OEMBED_VIDEO_FIELDS = ['type', 'version', 'html', 'width', 'height'] as const

describe('/v/{slug}.json', () => {
  let logs: string[] = []
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
    logs = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    current = null
  })

  it('serves oEmbed 1.0 and the player block for a published version with every preview', async () => {
    const h = harness()
    current = h.deps
    h.deps.nextPreviews = { files: previewFixtures(), lqip: LQIP }
    const id = await readyVideo(h)
    const pub = await publish(h, id)

    const res = await get(`/v/${pub.slug}.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json+oembed; charset=utf-8')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const body = (await res.json()) as OEmbed
    for (const f of OEMBED_VIDEO_FIELDS) expect(body[f], f).toBeDefined()
    const base = `${ORIGIN}/v/${pub.slug}`
    expect(body).toMatchObject({
      type: 'video',
      version: '1.0',
      provider_url: ORIGIN,
      thumbnail_url: `${base}.jpg`,
    })
    expect(typeof body.title).toBe('string')
    expect(typeof body.provider_name).toBe('string')
    expect(body.width).toBeGreaterThan(0)
    expect(body.thumbnail_width).toBe(body.width)
    expect(body.video_agent).toEqual({
      videoId: id,
      versionN: 1,
      page: base,
      mp4: `${base}.mp4`,
      poster: `${base}.jpg`,
      posterWebp: `${base}.webp`,
      captions: `${base}.vtt`,
      durationSec: expect.any(Number) as number,
      credits: [],
      lqip: LQIP,
      hover: `${base}.hover.mp4`,
    })
    // The same snippet the publish dialog shows.
    expect(body.html).toBe(pub.embed.replaceAll(h.deps.config.siteUrl, ORIGIN))
    // The hover clip it names is served.
    const clip = await get(`/v/${pub.slug}.hover.mp4`)
    expect(clip.status).toBe(200)
    expect(clip.headers.get('content-type')).toBe('video/mp4')
    expect(JSON.parse(logs.find((l) => l.includes('public.oembed')) ?? '{}')).toMatchObject({
      slug: pub.slug,
      status: 200,
    })
  })

  it('answers HEAD with the headers and no body', async () => {
    const h = harness()
    current = h.deps
    const pub = await publish(h, await readyVideo(h, h.member))
    const res = await get(`/v/${pub.slug}.json`, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json+oembed')
    expect(await res.text()).toBe('')
  })

  it('404s for an unknown slug and once unpublished', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const pub = await publish(h, id)
    expect((await get(`/v/${pub.slug}.json`)).status).toBe(200)
    await h.call('DELETE', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member })
    for (const slug of [pub.slug, 'zzzzzzzz']) {
      const res = await get(`/v/${slug}.json`)
      expect(res.status).toBe(404)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('a version without previews has null placeholders, and its hover clip 404s', async () => {
    const h = harness()
    current = h.deps
    const pub = await publish(h, await readyVideo(h, h.member))
    const body = (await (await get(`/v/${pub.slug}.json`)).json()) as OEmbed
    expect(body.video_agent).toMatchObject({ posterWebp: null, lqip: null, hover: null })
    expect((await get(`/v/${pub.slug}.hover.mp4`)).status).toBe(404)
  })

  it('an older mirror (no lqip, no hover key) reads as nulls, and CC BY credits travel with it', async () => {
    const h = harness()
    current = h.deps
    const pub = await publish(h, await readyVideo(h, h.member))
    const raw = await h.deps.blobs.get('internal', pubKey(pub.slug))
    const mirror = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as Record<
      string,
      unknown
    > & {
      keys: Record<string, unknown>
    }
    const credits = [
      {
        role: 'Music',
        title: 'Track <1>',
        creator: 'Artist',
        creatorUrl: 'https://example.com/a',
        licenseLabel: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://example.com/t',
      },
    ]
    delete mirror.lqip
    delete mirror.keys.hover
    await h.deps.blobs.set('internal', pubKey(pub.slug), JSON.stringify({ ...mirror, credits }))
    const body = (await (await get(`/v/${pub.slug}.json`)).json()) as OEmbed
    expect(body.video_agent).toMatchObject({ lqip: null, hover: null, credits })
    const base = `${ORIGIN}/v/${pub.slug}`
    expect(body.html).toBe(
      embedHtml(base, null, { width: body.width as number, height: body.height as number }, credits),
    )
    expect(body.html).toContain('Track &#60;1&#62;')
  })
})
