// Version file delivery: signed URLs in the DTO (no redirect hop), expiries snapped to a window so URLs repeat, and
// browser-only caching with 304s on /files, while signatures, expiry and private-video revocation still hold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIVATE_URL_TTL_SEC, PUBLIC_URL_TTL_SEC, stableExp } from '../src/domain/files.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { etagMatches } from '../src/lib/media/range.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { apiKey, harness, PROMPT, readyVideo, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const edge = async (url: string, init: RequestInit = {}) =>
  (await loadEdge('files'))(new Request(new URL(url, 'https://video.example.com'), init), {
    deploy: { published: true },
  })

type Files = { poster: string; gif: string } | null
const getVideo = async (h: Harness, id: string, as = h.member) =>
  h.json<{ etag: string; versions: { n: number; files: Files }[] }>(
    await h.call('GET', `/api/v1/videos/${id}`, { as }),
  )
const redirect = async (h: Harness, id: string, file = 'poster') =>
  (await h.call('GET', `/api/v1/videos/${id}/versions/1/${file}`, { as: h.member })).headers.get(
    'location',
  ) ?? ''
const expOf = (u: string) => Number(new URL(u, 'https://x').searchParams.get('exp'))
const nowSec = (h: Harness) => Math.floor(h.deps.clock.t / 1000)

describe('stableExp', () => {
  it('keeps every lifetime in (ttl/2, ttl] and repeats within a window', () => {
    for (const ttl of [600, 3600]) {
      const seen = new Set<number>()
      for (let now = 1_800_000_000; now < 1_800_000_000 + 2 * ttl; now += 7) {
        const exp = stableExp(now, ttl)
        expect(exp - now).toBeGreaterThan(ttl / 2)
        expect(exp - now).toBeLessThanOrEqual(ttl)
        seen.add(exp)
      }
      // About four windows in two TTLs, not one URL per request.
      expect(seen.size).toBeLessThanOrEqual(5)
    }
  })

  it('compares entity tags weakly', () => {
    expect(etagMatches('"a"', '"a"')).toBe(true)
    expect(etagMatches('W/"a"', '"a"')).toBe(true)
    expect(etagMatches('"b", W/"a"', '"a"')).toBe(true)
    expect(etagMatches('*', '"a"')).toBe(true)
    expect(etagMatches('"b"', '"a"')).toBe(false)
    expect(etagMatches(null, '"a"')).toBe(false)
  })
})

describe('version file delivery', () => {
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
    // The edge function reads the wall clock: follow the harness clock.
    vi.spyOn(Date, 'now').mockImplementation(() => h.deps.clock.t)
    return h
  }

  it('the DTO carries signed poster and GIF URLs that repeat within a window', async () => {
    const h = setup()
    const queued = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    expect(queued.versions[0].files).toBeNull()
    await h.drive(4)
    const a = await getVideo(h, queued.id)
    const files = a.versions[0]?.files
    expect(files?.poster).toMatch(
      new RegExp(
        `^https://video\\.example\\.com/files/${queued.id}/v1/poster\\.jpg\\?exp=\\d+&sig=[0-9a-f]{64}$`,
      ),
    )
    expect(files?.gif).toContain(`/files/${queued.id}/v1/preview.gif?exp=`)
    const life = expOf(files?.poster ?? '') - nowSec(h)
    expect(life).toBeGreaterThan(PUBLIC_URL_TTL_SEC / 2)
    expect(life).toBeLessThanOrEqual(PUBLIC_URL_TTL_SEC)
    // Same URLs a minute later and from the list; new ones once the window rolls over.
    h.deps.clock.advance(60_000)
    expect((await getVideo(h, queued.id)).versions[0]?.files).toEqual(files)
    const list = await h.json(await h.call('GET', '/api/v1/videos', { as: h.member }))
    expect(list.items[0].versions[0].files).toEqual(files)
    h.deps.clock.advance(PUBLIC_URL_TTL_SEC * 1000)
    expect((await getVideo(h, queued.id)).versions[0]?.files?.poster).not.toBe(files?.poster)
  })

  it('the redirect route keeps working and its target repeats too', async () => {
    const h = setup()
    const id = await readyVideo(h)
    const first = await redirect(h, id)
    expect(first).toMatch(new RegExp(`^/files/${id}/v1/poster\\.jpg\\?exp=\\d+&sig=[0-9a-f]{64}$`))
    expect(expOf(first) - nowSec(h)).toBeGreaterThan(300)
    expect(expOf(first) - nowSec(h)).toBeLessThanOrEqual(600)
    h.deps.clock.advance(30_000)
    expect(await redirect(h, id)).toBe(first)
    expect(await redirect(h, id, 'video')).toMatch(/\/v1\/video\.mp4\?exp=/)
    const dl = (await h.call('GET', `/api/v1/videos/${id}/versions/1/video?download=1`, { as: h.member }))
      .headers
    expect(dl.get('location')).toMatch(/&download=1$/)
    expect(dl.get('cache-control')).toBe('private, no-store')
  })

  it('/files: browser-only caching for the signature lifetime, 304 on a matching ETag, ranges', async () => {
    const h = setup()
    const id = await readyVideo(h)
    const url = (await getVideo(h, id)).versions[0]?.files?.poster ?? ''
    const res = await edge(url)
    expect(res.status).toBe(200)
    const cc = res.headers.get('cache-control') ?? ''
    const maxAge = Number(/^private, max-age=(\d+), immutable$/.exec(cc)?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(expOf(url) - nowSec(h))
    expect(cc).not.toContain('public')
    expect(res.headers.get('netlify-cdn-cache-control')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const etag = res.headers.get('etag') ?? ''
    expect(etag).not.toBe('')

    for (const inm of [etag, `W/${etag}`]) {
      const again = await edge(url, { headers: { 'if-none-match': inm } })
      expect(again.status).toBe(304)
      expect(again.headers.get('etag')).toBe(etag)
      expect(again.headers.get('cache-control')).toBe(cc)
      expect(await again.text()).toBe('')
    }
    expect((await edge(url, { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
    const part = await edge(url, { headers: { range: 'bytes=0-1' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toMatch(/^bytes 0-1\/\d+$/)
    expect(part.headers.get('cache-control')).toBe(cc)

    // Max-age shrinks with the remaining lifetime, and an expired URL is refused uncached (even with an ETag).
    h.deps.clock.advance((expOf(url) - nowSec(h) - 10) * 1000)
    expect((await edge(url)).headers.get('cache-control')).toBe('private, max-age=10, immutable')
    h.deps.clock.advance(11_000)
    for (const init of [{}, { headers: { 'if-none-match': etag } }]) {
      const expired = await edge(url, init)
      expect(expired.status).toBe(403)
      expect(expired.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('/files refuses tampered signatures before any 304', async () => {
    const h = setup()
    const id = await readyVideo(h)
    const url = (await getVideo(h, id)).versions[0]?.files?.poster ?? ''
    const etag = (await edge(url)).headers.get('etag') ?? ''
    const bad = url.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`)
    const res = await edge(bad, { headers: { 'if-none-match': etag } })
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // A poster URL can't be turned into the video or another version.
    expect((await edge(url.replace('poster.jpg', 'video.mp4'))).status).toBe(403)
    expect((await edge(url.replace('/v1/', '/v2/'))).status).toBe(403)
  })

  it('private videos: short-lived epoch-bound URLs, revoked on every privacy change, hidden from others', async () => {
    const h = setup()
    const id = await readyVideo(h)
    const publicUrl = (await getVideo(h, id)).versions[0]?.files?.poster ?? ''
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await edge(publicUrl)).status).toBe(403)
    expect((await edge(publicUrl, { headers: { 'if-none-match': '"e"' } })).status).toBe(403)

    const priv = (await getVideo(h, id)).versions[0]?.files?.poster ?? ''
    expect(priv).toMatch(/\?exp=\d+&e=\d+&sig=[0-9a-f]{64}$/)
    const life = expOf(priv) - nowSec(h)
    expect(life).toBeGreaterThan(PRIVATE_URL_TTL_SEC / 2)
    expect(life).toBeLessThanOrEqual(PRIVATE_URL_TTL_SEC)
    const ok = await edge(priv)
    expect(ok.status).toBe(200)
    expect(Number(/max-age=(\d+)/.exec(ok.headers.get('cache-control') ?? '')?.[1])).toBeLessThanOrEqual(
      PRIVATE_URL_TTL_SEC,
    )
    // The redirect for a private video stays within the private TTL too.
    expect(expOf(await redirect(h, id)) - nowSec(h)).toBeLessThanOrEqual(PRIVATE_URL_TTL_SEC)

    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    await h.call('GET', '/api/v1/me', { as: bob })
    expect((await h.call('GET', `/api/v1/videos/${id}`, { as: bob })).status).toBe(404)
    const list = await h.json(await h.call('GET', '/api/v1/videos', { as: bob }))
    expect(JSON.stringify(list)).not.toContain('/files/')

    // Back to public and private again: the epoch moves, so the first private URL stops working.
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: false } })
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await edge(priv)).status).toBe(403)
    expect((await edge((await getVideo(h, id)).versions[0]?.files?.poster ?? '')).status).toBe(200)
  })

  it('the video ETag includes the URL window, so a 304 never revives expired URLs', async () => {
    const h = setup()
    const id = await readyVideo(h)
    const res = await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })
    const etag = res.headers.get('etag') ?? ''
    const body = await h.json<{ etag: string; versions: { files: Files }[] }>(res)
    expect(etag).toBe(body.etag.replace(/"$/, `-${expOf(body.versions[0]?.files?.poster ?? '')}"`))
    const same = await h.call('GET', `/api/v1/videos/${id}`, {
      as: h.member,
      headers: { 'if-none-match': etag },
    })
    expect(same.status).toBe(304)
    h.deps.clock.advance(PUBLIC_URL_TTL_SEC * 1000)
    const fresh = await h.call('GET', `/api/v1/videos/${id}`, {
      as: h.member,
      headers: { 'if-none-match': etag },
    })
    expect(fresh.status).toBe(200)
    // The body's etag (MCP and clients poll it for changes) doesn't move with the window.
    expect((await h.json<{ etag: string }>(fresh)).etag).toBe(body.etag)
  })

  it('webhook payloads carry no signed URLs', async () => {
    const h = setup()
    const key = await apiKey(h, h.member)
    await h.call('POST', '/api/v1/videos', {
      key,
      origin: null,
      body: { prompt: PROMPT, webhookUrl: 'https://ci.example.com/hook' },
    })
    await h.drive(4)
    expect(await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })).toBe(1)
    const body = JSON.parse(h.deps.http.calls[0]?.body ?? '{}')
    expect(body.video.versions[0].output).not.toBeNull()
    expect(body.video.versions[0].files).toBeNull()
  })
})
