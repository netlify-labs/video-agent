// The media library (plan v2 §9, §14 rules 24-27): single-request uploads, SVG clean copies, listing and
// visibility, captions, soft delete, usage counts, and the signed /media edge route.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '../src/domain/types.js'
import type { TestDeps } from './fakes.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const png = (w = 640, h = 360) =>
  new Uint8Array([
    0x89,
    ...Buffer.from('PNG\r\n\x1a\n', 'latin1'),
    ...be32(13),
    ...Buffer.from('IHDR'),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  ])
const evilSvg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5"/></svg>',
)

let current: TestDeps | null = null
vi.mock('@netlify/blobs', () => ({
  getStore: ({ name }: { name: 'internal' | 'media' }) => ({
    get: async (key: string, o?: { type?: string }) => {
      const b = await current?.blobs.get(name, key)
      if (!b) return null
      if (o?.type === 'json') return JSON.parse(new TextDecoder().decode(b)) as unknown
      if (o?.type === 'stream') return new Blob([b]).stream()
      return b
    },
    getMetadata: async (key: string) => {
      const b = await current?.blobs.get(name, key)
      return b ? { etag: '"e"', metadata: current?.blobs.meta.get(`${name}:${key}`) ?? {} } : null
    },
  }),
}))
type EdgeHandler = (req: Request, ctx: { deploy: { published: boolean } }) => Promise<Response>
const EDGE = '../netlify/edge-functions/media.ts'
const edge = async (url: string, init: RequestInit = {}) =>
  ((await import(/* @vite-ignore */ EDGE)) as { default: EdgeHandler }).default(
    new Request(`https://video.example.com${url}`, init),
    { deploy: { published: true } },
  )

async function person(h: Harness, id: string, role?: Role) {
  const cookie = h.deps.identity.addUser({ id, email: `${id}@acme.com`, name: id }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  if (role) await h.call('PATCH', `/api/v1/users/${id}`, { as: h.admin, body: { role } })
  return cookie
}

/** A raw upload, the way the Media page sends a file. */
function upload(h: Harness, as: string, bytes: Uint8Array, q = 'filename=logo.png') {
  return h.app.fetch(
    new Request(`https://video.example.com/api/v1/media?${q}`, {
      method: 'POST',
      headers: {
        cookie: as,
        origin: 'https://video.example.com',
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    }),
    { context: { deploy: { published: true }, waitUntil: () => undefined } },
  )
}

interface Media {
  id: string
  kind: string
  status: string
  filename: string
  caption: string | null
  usedIn: number
  urls: { file: string; original: string; poster: string | null } | null
}

describe('media library', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  it('creators upload; the type comes from the bytes; reviewers and viewers cannot', async () => {
    const h = harness()
    const res = await upload(h, h.member, png(), 'filename=Brand%20logo.png&caption=Main%20logo')
    expect(res.status).toBe(201)
    const m = await h.json<Media>(res)
    expect(m).toMatchObject({
      kind: 'image',
      status: 'ready',
      filename: 'Brand logo.png',
      caption: 'Main logo',
    })
    expect(m.urls?.file).toMatch(new RegExp(`^/media/${m.id}/file\\?exp=\\d+&sig=[0-9a-f]{64}$`))
    const rita = await person(h, 'u_rita', 'reviewer')
    const denied = await upload(h, rita, png())
    expect(denied.status).toBe(403)
    expect((await h.json(denied)).error.message).toContain('Your role (reviewer)')
    expect(
      (await upload(h, h.member, new TextEncoder().encode('MZ\u0090 not an image'), 'filename=x.png')).status,
    ).toBe(400)
    expect((await upload(h, h.member, new Uint8Array(0))).status).toBe(400)
  })

  it('keeps an SVG original as a download and serves only the sanitized copy', async () => {
    const h = harness()
    current = h.deps
    const m = await h.json<Media>(await upload(h, h.member, evilSvg, 'filename=mark.svg'))
    expect(m.kind).toBe('svg')
    const clean = await edge(m.urls?.file ?? '')
    expect(clean.status).toBe(200)
    expect(clean.headers.get('content-type')).toBe('image/svg+xml')
    expect(clean.headers.get('x-content-type-options')).toBe('nosniff')
    expect(clean.headers.get('content-security-policy')).toContain('sandbox')
    const body = await clean.text()
    expect(body).not.toMatch(/script|onload|alert/)
    expect(body).toContain('<rect')
    const original = await edge(m.urls?.original ?? '')
    expect(original.headers.get('content-disposition')).toMatch(/^attachment; filename="mark\.svg"$/)
    expect(await original.text()).toContain('<script>')
  })

  it('the edge serves Range for files and refuses bad signatures', async () => {
    const h = harness()
    current = h.deps
    const clip = new Uint8Array(readFileSync(new URL('./fixtures/a169.mp4', import.meta.url)))
    const m = await h.json<Media>(await upload(h, h.member, clip, 'filename=clip.mp4'))
    expect(m).toMatchObject({ kind: 'video', status: 'ready' })
    const part = await edge(m.urls?.file ?? '', { headers: { range: 'bytes=0-9' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe('video/mp4')
    expect((await part.arrayBuffer()).byteLength).toBe(10)
    // Change the signature's first character (always to a different one).
    const tampered = (m.urls?.file ?? '').replace(/sig=(.)/, (_, c: string) => `sig=${c === '0' ? '1' : '0'}`)
    expect((await edge(tampered)).status).toBe(403)
    expect((await edge(`/media/${m.id}/file`)).status).toBe(403)
  })

  it('lists ready items for everyone and pending ones only for their uploader', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const vic = await person(h, 'u_vic', 'viewer')
    const a = await h.json<Media>(await upload(h, h.member, png(), 'filename=a.png'))
    h.deps.clock.advance(1000)
    await upload(h, h.member, evilSvg, 'filename=b.svg')
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.insertMedia({
      ...(await h.deps.store.getMedia(a.id))!,
      id: 'med_pendingbob000000000000',
      uploaderId: 'u_bob',
      status: 'verifying',
      createdAt: now,
      updatedAt: now,
    })
    const asVic = await h.json<{ items: Media[] }>(await h.call('GET', '/api/v1/media', { as: vic }))
    expect(asVic.items.map((m) => m.filename)).toEqual(['b.svg', 'a.png'])
    const asBob = await h.json<{ items: Media[] }>(await h.call('GET', '/api/v1/media', { as: bob }))
    expect(asBob.items[0]).toMatchObject({
      id: 'med_pendingbob000000000000',
      status: 'verifying',
      urls: null,
    })
    const svgs = await h.json<{ items: Media[] }>(await h.call('GET', '/api/v1/media?kind=svg', { as: vic }))
    expect(svgs.items.map((m) => m.kind)).toEqual(['svg'])
    expect((await h.call('GET', '/api/v1/media/med_pendingbob000000000000', { as: vic })).status).toBe(404)
  })

  it('captions and deletes: uploader or admin; deleting is soft', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const m = await h.json<Media>(await upload(h, h.member, png()))
    expect((await h.call('PATCH', `/api/v1/media/${m.id}`, { as: bob, body: { caption: 'x' } })).status).toBe(
      403,
    )
    const cap = await h.json<Media>(
      await h.call('PATCH', `/api/v1/media/${m.id}`, { as: h.member, body: { caption: ' Hero ' } }),
    )
    expect(cap.caption).toBe('Hero')
    expect((await h.call('DELETE', `/api/v1/media/${m.id}`, { as: bob })).status).toBe(403)
    expect((await h.call('DELETE', `/api/v1/media/${m.id}`, { as: h.admin })).status).toBe(204)
    expect((await h.call('GET', `/api/v1/media/${m.id}`, { as: h.member })).status).toBe(404)
    expect(
      (await h.json<{ items: Media[] }>(await h.call('GET', '/api/v1/media', { as: h.member }))).items,
    ).toEqual([])
    // The bytes stay for versions that used it.
    expect(await h.deps.blobs.list('media', `${m.id}/`)).not.toEqual([])
  })

  it('"used in N" counts only videos the viewer can see', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const m = await h.json<Media>(await upload(h, h.member, png()))
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.deps.store.insertVersionMedia([
      {
        jobId: v.id,
        versionN: 1,
        mediaId: m.id,
        position: 0,
        kind: 'image',
        key: 'k',
        sha256: 's',
        filename: 'f.png',
        caption: null,
      },
    ])
    expect((await h.json<Media>(await h.call('GET', `/api/v1/media/${m.id}`, { as: bob }))).usedIn).toBe(1)
    await h.call('PATCH', `/api/v1/videos/${v.id}`, { as: h.member, body: { private: true } })
    expect((await h.json<Media>(await h.call('GET', `/api/v1/media/${m.id}`, { as: bob }))).usedIn).toBe(0)
    expect((await h.json<Media>(await h.call('GET', `/api/v1/media/${m.id}`, { as: h.member }))).usedIn).toBe(
      1,
    )
  })
})
