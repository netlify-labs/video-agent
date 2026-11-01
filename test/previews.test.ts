// Optional preview variants (WebP/AVIF posters, hover clip, LQIP): recorded by finalize when the run made them, signed
// into the version DTO and the embed only for versions that have them, and never required.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEdge } from './edge.js'
import { LQIP, previewFixtures, type TestDeps } from './fakes.js'
import { harness, PROMPT, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const edge = async (name: 'files' | 'public', url: string) =>
  (await loadEdge(name))(new Request(new URL(url, 'https://video.example.com')), {
    deploy: { published: true },
  })

interface Files {
  poster: string
  gif: string
  posterSources?: { type: string; srcset: string }[]
  clip?: { type: string; src: string }[]
  lqip?: string
}
const make = async (h: Harness, previews: TestDeps['nextPreviews']) => {
  h.deps.nextPreviews = previews
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const got = await h.json<{ versions: { status: string; files: Files | null }[] }>(
    await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }),
  )
  return { id: v.id as string, version: got.versions[0] }
}
const publish = async (h: Harness, id: string) =>
  h.json<{ slug: string; urls: Record<string, string>; embed: string }>(
    await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
  )

describe('preview variants', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    current = null
  })
  const setup = () => {
    const h = harness()
    current = h.deps
    vi.spyOn(Date, 'now').mockImplementation(() => h.deps.clock.t)
    return h
  }

  it('a version with every variant: signed sources best format first, the clip and the placeholder', async () => {
    const h = setup()
    const { id, version } = await make(h, { files: previewFixtures(), lqip: LQIP })
    expect(version?.status).toBe('ready')
    const f = version?.files
    expect(f?.posterSources?.map((s) => s.type)).toEqual(['image/avif', 'image/webp'])
    const webp = f?.posterSources?.[1]?.srcset ?? ''
    expect(webp).toMatch(
      new RegExp(
        `^https://video\\.example\\.com/files/${id}/v1/poster-480\\.webp\\?exp=\\d+&sig=[0-9a-f]{64} 480w, \\S+/poster-960\\.webp\\?\\S+ 960w$`,
      ),
    )
    expect(f?.clip?.map((c) => c.type)).toEqual(['video/webm', 'video/mp4'])
    expect(f?.lqip).toBe(LQIP)

    // The files edge serves each with its content type, and a signature for one name doesn't open another.
    const small = webp.split(' ')[0] ?? ''
    const cases: [string, string][] = [
      [small, 'image/webp'],
      [f?.posterSources?.[0]?.srcset.split(' ')[0] ?? '', 'image/avif'],
      [f?.clip?.[0]?.src ?? '', 'video/webm'],
      [f?.clip?.[1]?.src ?? '', 'video/mp4'],
    ]
    for (const [url, type] of cases) {
      const res = await edge('files', url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(type)
      expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/)
    }
    expect((await edge('files', small.replace('poster-480.webp', 'video.mp4'))).status).toBe(403)
    expect((await edge('files', small.replace('poster-480.webp', 'poster-960.webp'))).status).toBe(403)
    // Recorded with sizes and hashes next to the required files.
    const out = await h.deps.store.getOutput(id, 1)
    expect(Object.keys(out?.previews?.files ?? {})).toHaveLength(6)
    expect(out?.sha256['clip.webm']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('versions without variants (older renders) get none of the new fields, and still work', async () => {
    const h = setup()
    const { id, version } = await make(h, null)
    expect(version?.status).toBe('ready')
    expect(Object.keys(version?.files ?? {}).sort()).toEqual(['gif', 'poster'])
    expect((await h.deps.store.getOutput(id, 1))?.previews).toBeNull()
  })

  it('a bad or missing variant is skipped without failing the version', async () => {
    const h = setup()
    const files = previewFixtures(['poster-480.webp', 'poster-960.webp', 'clip.webm', 'clip.mp4'])
    files['clip.webm'] = new TextEncoder().encode('not a webm') // wrong magic bytes
    const { id, version } = await make(h, { files, lqip: 'data:image/svg+xml;base64,PHN2Zz4=' })
    expect(version?.status).toBe('ready')
    expect(version?.files?.posterSources?.map((s) => s.type)).toEqual(['image/webp'])
    expect(version?.files?.clip?.map((c) => c.type)).toEqual(['video/mp4'])
    expect(version?.files?.lqip).toBeUndefined()
    expect(await h.deps.blobs.get('videos', `${id}/v1/clip.webm`)).toBeNull()
  })

  it('the embed and share page use the WebP poster only when the published version has one', async () => {
    const h = setup()
    const withIt = await make(h, { files: previewFixtures(), lqip: LQIP })
    const without = await make(h, null)
    const a = await publish(h, withIt.id)
    const b = await publish(h, without.id)
    const base = (slug: string) => `https://video.example.com/v/${slug}`

    expect(a.urls.posterWebp).toBe(`${base(a.slug)}.webp`)
    expect(a.embed).toBe(
      `<video controls playsinline preload="metadata" width="1920" height="1080" style="max-width:100%;height:auto" poster="${base(a.slug)}.webp"><source src="${base(a.slug)}.mp4" type="video/mp4"><track kind="captions" src="${base(a.slug)}.vtt" srclang="en" label="Captions"></video>`,
    )
    expect(b.urls.posterWebp).toBeUndefined()
    expect(b.embed).toContain(`poster="${base(b.slug)}.jpg"`)
    expect(b.embed).toContain(`<source src="${base(b.slug)}.mp4" type="video/mp4">`)

    const webp = await edge('public', `/v/${a.slug}.webp`)
    expect(webp.status).toBe(200)
    expect(webp.headers.get('content-type')).toBe('image/webp')
    expect((await edge('public', `/v/${b.slug}.webp`)).status).toBe(404)
    expect(await (await edge('public', `/v/${a.slug}`)).text()).toContain(`poster="${base(a.slug)}.webp"`)
    const page = await (await edge('public', `/v/${b.slug}`)).text()
    expect(page).toContain(`poster="${base(b.slug)}.jpg"`)
    // Social cards keep the JPEG.
    expect(page).toContain(`og:image" content="${base(b.slug)}.jpg"`)

    // Unpublishing closes the WebP too.
    await h.call('DELETE', `/api/v1/videos/${withIt.id}/versions/1/publish`, { as: h.member })
    expect((await edge('public', `/v/${a.slug}.webp`)).status).toBe(404)
  })
})
