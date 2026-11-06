// The sandboxed preview (plan v2 §7, design from spike S2): minting a capability for a ready version, and the
// /preview edge function serving only that bundle's manifest files under the path-scoped CSP.
import { describe, expect, it, vi } from 'vitest'
import type { TestDeps } from './fakes.js'
import { injectPreviewScripts, parsePreviewPath, previewCsp, previewContentType } from '../src/lib/preview.js'
import { running } from './fakes.js'
import { harness, PROMPT, readyVideo, stubNetlify, type Harness } from './helpers.js'
import { loadEdge } from './edge.js'
import { tarGz } from './tarball.js'

// The edge function reads Blobs through @netlify/blobs: back it with the test's fake store.
let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const mint = async (h: Harness, id: string, as = h.member) =>
  h.json<{ url: string }>(await h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as }))

async function edge(url: string, init: RequestInit = {}) {
  return (await loadEdge('preview'))(new Request(url, init), { deploy: { published: true } })
}

describe('preview helpers', () => {
  it('parses capability paths and refuses traversal', () => {
    const sig = 'a'.repeat(64)
    expect(parsePreviewPath(`/preview/vid_1/v2/123.x.${sig}/assets/logo.svg`)).toMatchObject({
      jobId: 'vid_1',
      versionN: 2,
      exp: 123,
      epoch: undefined,
      path: 'assets/logo.svg',
    })
    expect(parsePreviewPath(`/preview/vid_1/v2/123.7.${sig}/index.html`)?.epoch).toBe(7)
    expect(parsePreviewPath(`/preview/vid_1/v2/123.x.${sig}/%2e%2e/secret`)).toBeNull()
    expect(parsePreviewPath(`/preview/vid_1/v2/123.x.${sig}/a//b`)).toBeNull()
    expect(parsePreviewPath(`/preview/vid_1/v2/123.x.short/index.html`)).toBeNull()
  })

  it('injects the runtime first and the bridge last', () => {
    expect(injectPreviewScripts('<html><head><title>x</title></head><body><p>hi</p></body></html>')).toBe(
      '<html><head><script src="_hf/runtime.js"></script><title>x</title></head><body><p>hi</p><script src="_hf/bridge.js"></script></body></html>',
    )
    // Older compositions' CDN GSAP points at the vendored copy under the capability.
    expect(
      injectPreviewScripts(
        '<head><script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script></head>',
      ),
    ).toBe(
      '<head><script src="_hf/runtime.js"></script><script src="_hf/gsap.js"></script></head><script src="_hf/bridge.js"></script>',
    )
    expect(
      injectPreviewScripts('<script src="https://unpkg.com/gsap@3.12.5/dist/gsap.js"></script>'),
    ).toContain('<script src="_hf/gsap.js"></script>')
    expect(injectPreviewScripts('<!DOCTYPE html><p>x</p>')).toBe(
      '<!DOCTYPE html><script src="_hf/runtime.js"></script><p>x</p><script src="_hf/bridge.js"></script>',
    )
    expect(injectPreviewScripts('<p>bare</p>')).toBe(
      '<script src="_hf/runtime.js"></script><p>bare</p><script src="_hf/bridge.js"></script>',
    )
  })

  it('scopes every CSP source to the capability path', () => {
    const csp = previewCsp('https://v.example.com/preview/vid_1/v2/cap/')
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('connect-src https://v.example.com/preview/vid_1/v2/cap/')
    expect(csp).not.toContain("'self'")
    expect(previewContentType('a/b.woff2')).toBe('font/woff2')
    expect(previewContentType('x.unknown')).toBe('application/octet-stream')
  })
})

describe('preview links and the edge function', () => {
  stubNetlify(() => {
    current = null
  })

  it('mints a link for a ready version; the edge serves index.html with scripts and §7 headers', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h)
    const link = await mint(h, id)
    expect(link.url).toMatch(
      new RegExp(`^https://video\\.example\\.com/preview/${id}/v1/\\d+\\.x\\.[0-9a-f]{64}/index\\.html$`),
    )
    const res = await edge(link.url)
    expect(res.status).toBe(200)
    const html = await res.text()
    // After the doctype (no <head> in this composition), so the page stays in standards mode.
    expect(html.startsWith('<!doctype html><script src="_hf/runtime.js"></script>')).toBe(true)
    expect(html.endsWith('<script src="_hf/bridge.js"></script>')).toBe(true)
    const base = link.url.replace(/index\.html$/, '')
    expect(res.headers.get('content-security-policy')).toBe(previewCsp(base))
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('permissions-policy')).toBe('microphone=()')
    // Another manifest file, with Range.
    const part = await edge(base + 'summary.json', { headers: { range: 'bytes=0-0' } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('{')
  })

  it('refuses paths outside the manifest, tampered or expired capabilities, other bundles', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h)
    const link = await mint(h, id)
    const base = link.url.replace(/index\.html$/, '')
    expect((await edge(base + 'nope.js')).status).toBe(404)
    expect(
      (await edge(base.replace(/[0-9a-f](?=\/$)/, (c: string) => (c === 'a' ? 'b' : 'a')) + 'index.html'))
        .status,
    ).toBe(403)
    // The same capability can't open v2 of the video or another video.
    expect((await edge(base.replace('/v1/', '/v2/') + 'index.html')).status).toBe(403)
    const expired = base.replace(/\/(\d+)\.x\./, (_m: string, e: string) => `/${Number(e) - 100000}.x.`)
    expect((await edge(expired + 'index.html')).status).toBe(403)
    expect((await edge(link.url, { method: 'POST' })).status).toBe(405)
  })

  it('private videos: links carry the access epoch and stop working after a privacy change', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h)
    const before = await mint(h, id)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await edge(before.url)).status).toBe(403)
    const after = await mint(h, id)
    expect(after.url).toMatch(/\/\d+\.\d+\.[0-9a-f]{64}\/index\.html$/)
    expect((await edge(after.url)).status).toBe(200)
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    await h.call('GET', '/api/v1/me', { as: bob })
    expect((await h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as: bob })).status).toBe(404)
  })

  it('only ready versions, and the edge serves production deploys only', async () => {
    const h = harness()
    current = h.deps
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    expect((await h.call('GET', `/api/v1/videos/${v.id}/versions/1/preview`, { as: h.member })).status).toBe(
      409,
    )
    await h.drive(4)
    const link = await mint(h, v.id)
    const handler = await loadEdge('preview')
    expect((await handler(new Request(link.url), { deploy: { published: false } })).status).toBe(404)
  })

  it('serves the vendored runtime and bridge under the capability', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h)
    const link = await mint(h, id)
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (u: URL) => {
      fetched.push(u.pathname)
      return new Response('/* runtime */')
    })
    const res = await edge(link.url.replace('index.html', '_hf/runtime.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(fetched).toEqual(['/_preview/runtime.js'])
  })

  it('serves a running version live snapshot under the same capability', async () => {
    const h = harness()
    current = h.deps
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(2)
    const [a] = await h.attempts(v.id)
    const token = /--token (\S+)/.exec(h.deps.runner.starts.at(-1)?.prompt ?? '')?.[1] ?? ''
    const bundle = Buffer.from(
      tarGz([
        { name: 'video/index.html', body: '<!doctype html><head></head><body><h1>wip</h1></body>' },
        { name: 'video/style.css', body: 'h1{}' },
      ]),
    ).toString('base64')
    await h.call('POST', `/api/internal/runs/${a?.id}/checkpoint`, {
      origin: null,
      headers: { authorization: `Bearer ${token}` },
      body: { seq: 3, message: 'Writing', bundle },
    })
    const link = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/videos/${v.id}/versions/1/preview?live=1`, { as: h.member }),
    )
    const res = await edge(link.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<h1>wip</h1><script src="_hf/bridge.js"></script>')
    const css = await edge(link.url.replace('index.html', 'style.css'))
    expect(await css.text()).toBe('h1{}')
    // The runtime and bridge are served inside live/ too, or the snapshot can't play.
    vi.stubGlobal('fetch', async () => new Response('/* runtime */'))
    for (const f of ['_hf/runtime.js', '_hf/bridge.js'])
      expect((await edge(link.url.replace('index.html', f))).status).toBe(200)
    expect((await edge(link.url.replace('/live/s3/', '/live/s2/'))).status).toBe(404)
    // The CSP base is the capability, so live/ paths stay inside it.
    expect(res.headers.get('content-security-policy')).toContain(
      link.url.replace(/live\/s3\/index\.html$/, ''),
    )
  })
})
