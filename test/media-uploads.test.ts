// Upload sessions (plan v2 §9, §14 rule 24): parts, resume, duplicates, hashes, completion lease, background
// assembly with verification, quota, ownership and the sweep.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { PART_SIZE } from '../src/domain/media-uploads.js'
import type { TestDeps } from './fakes.js'
import { harness, type Harness } from './helpers.js'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** The fixture clip padded with a trailing `free` box: still a valid MP4, just big enough to need three parts. */
function bigClip(total = 9 * 1024 * 1024) {
  const clip = new Uint8Array(readFileSync(new URL('./fixtures/a169.mp4', import.meta.url)))
  const pad = total - clip.byteLength
  const out = new Uint8Array(total)
  out.set(clip)
  new DataView(out.buffer).setUint32(clip.byteLength, pad)
  out.set(new TextEncoder().encode('free'), clip.byteLength + 4)
  return out
}

function raw(
  h: Harness,
  as: string,
  method: string,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return h.app.fetch(
    new Request(`https://video.example.com${path}`, {
      method,
      headers: {
        cookie: as,
        origin: 'https://video.example.com',
        'content-type': 'application/octet-stream',
        ...headers,
      },
      body,
    }),
    { context: { deploy: { published: true }, waitUntil: () => undefined } },
  )
}

interface Session {
  id: string
  partCount: number
  uploaded: number[]
  status: string
  mediaId: string | null
  error: string | null
}
const start = async (h: Harness, as: string, file: Uint8Array, declared = sha(file)) =>
  h.json<Session>(
    await h.call('POST', '/api/v1/media/uploads', {
      as,
      body: { filename: 'launch.mp4', size: file.byteLength, sha256: declared },
    }),
  )
const part = (h: Harness, as: string, id: string, i: number, file: Uint8Array, override?: Uint8Array) => {
  const body = override ?? file.subarray(i * PART_SIZE, Math.min(file.byteLength, (i + 1) * PART_SIZE))
  return raw(h, as, 'PUT', `/api/v1/media/uploads/${id}/parts/${i}`, body, { 'x-part-sha256': sha(body) })
}
const session = async (h: Harness, as: string, id: string) =>
  h.json<Session>(await h.call('GET', `/api/v1/media/uploads/${id}`, { as }))
const complete = (h: Harness, as: string, id: string) =>
  h.call('POST', `/api/v1/media/uploads/${id}/complete`, { as, body: {} })
const partsInStore = (deps: TestDeps, id: string) => deps.blobs.list('media', `uploads/${id}/`)

describe('upload sessions', () => {
  it('uploads in parts, resumes, assembles in the background and verifies the clip', async () => {
    const h = harness()
    const file = bigClip()
    const s = await start(h, h.member, file)
    expect(s).toMatchObject({ partCount: 3, uploaded: [], status: 'open' })
    expect((await part(h, h.member, s.id, 2, file)).status).toBe(200)
    expect((await part(h, h.member, s.id, 0, file)).status).toBe(200)
    expect((await session(h, h.member, s.id)).uploaded).toEqual([0, 2])
    expect((await part(h, h.member, s.id, 1, file)).status).toBe(200)
    const done = await h.json<Session>(await complete(h, h.member, s.id))
    expect(done.status).toBe('done')
    const media = await h.json(await h.call('GET', `/api/v1/media/${done.mediaId}`, { as: h.member }))
    expect(media).toMatchObject({
      kind: 'video',
      status: 'ready',
      bytes: file.byteLength,
      width: 1920,
      height: 1080,
    })
    expect(media.durationSec).toBeCloseTo(2, 1)
    expect(await partsInStore(h.deps, s.id)).toEqual([])
    const stored = await h.deps.blobs.get('media', `${done.mediaId}/original.mp4`)
    expect(sha(stored!)).toBe(sha(file))
  })

  it('parts are immutable and checked: duplicates, changed duplicates, sizes, hashes, indexes', async () => {
    const h = harness()
    const file = bigClip()
    const s = await start(h, h.member, file)
    await part(h, h.member, s.id, 0, file)
    expect(await h.json(await part(h, h.member, s.id, 0, file))).toMatchObject({ duplicate: true })
    const changed = new Uint8Array(PART_SIZE).fill(7)
    expect((await part(h, h.member, s.id, 0, file, changed)).status).toBe(409)
    expect((await part(h, h.member, s.id, 1, file, new Uint8Array(10))).status).toBe(400)
    const corrupt = await raw(
      h,
      h.member,
      'PUT',
      `/api/v1/media/uploads/${s.id}/parts/1`,
      file.subarray(PART_SIZE, 2 * PART_SIZE),
      {
        'x-part-sha256': '0'.repeat(64),
      },
    )
    expect(corrupt.status).toBe(400)
    expect((await part(h, h.member, s.id, 3, file, new Uint8Array(1))).status).toBe(400)
    const missing = await complete(h, h.member, s.id)
    expect(missing.status).toBe(409)
    expect((await h.json(missing)).error.message).toContain('Parts still missing: 1, 2')
  })

  it('completing twice assembles once', async () => {
    const h = harness()
    h.deps.platform.onAssemble = null
    const file = bigClip()
    const s = await start(h, h.member, file)
    for (let i = 0; i < 3; i++) await part(h, h.member, s.id, i, file)
    expect((await h.json<Session>(await complete(h, h.member, s.id))).status).toBe('assembling')
    expect((await h.json<Session>(await complete(h, h.member, s.id))).status).toBe('assembling')
    expect(h.deps.platform.assemblies).toEqual([s.id])
    // Pending in the library for the uploader only.
    const pending = (await session(h, h.member, s.id)).mediaId
    expect((await h.json(await h.call('GET', `/api/v1/media/${pending}`, { as: h.member }))).status).toBe(
      'verifying',
    )
  })

  it('rejects a file whose whole hash or content is wrong, with the reason', async () => {
    const h = harness()
    const file = bigClip()
    const s = await start(h, h.member, file, 'a'.repeat(64))
    for (let i = 0; i < 3; i++) await part(h, h.member, s.id, i, file)
    const r = await h.json<Session>(await complete(h, h.member, s.id))
    expect(r.status).toBe('failed')
    expect(r.error).toContain("doesn't match the size and sha256")
    const m = await h.json(await h.call('GET', `/api/v1/media/${r.mediaId}`, { as: h.member }))
    expect(m).toMatchObject({ status: 'rejected', urls: null })
    expect(await partsInStore(h.deps, s.id)).toEqual([])
    const junk = new Uint8Array(5 * 1024 * 1024).fill(1)
    const j = await start(h, h.member, junk)
    for (let i = 0; i < 2; i++) await part(h, h.member, j.id, i, junk)
    expect((await h.json<Session>(await complete(h, h.member, j.id))).error).toContain(
      'Upload PNG, JPEG, WebP or SVG',
    )
  })

  it('reserves quota at creation and binds sessions to their uploader', async () => {
    const h = harness()
    const big = 100 * 1024 * 1024
    for (let i = 0; i < 10; i++)
      expect(
        (
          await h.call('POST', '/api/v1/media/uploads', {
            as: h.member,
            body: { filename: 'x.mp4', size: big, sha256: 'b'.repeat(64) },
          })
        ).status,
      ).toBe(201)
    const over = await h.call('POST', '/api/v1/media/uploads', {
      as: h.member,
      body: { filename: 'x.mp4', size: big, sha256: 'b'.repeat(64) },
    })
    expect(over.status).toBe(429)
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    await h.call('GET', '/api/v1/me', { as: bob })
    const file = bigClip()
    const s = await start(h, bob, file)
    expect((await h.call('GET', `/api/v1/media/uploads/${s.id}`, { as: h.member })).status).toBe(404)
    expect((await part(h, h.member, s.id, 0, file)).status).toBe(404)
    expect(
      (
        await h.call('POST', '/api/v1/media/uploads', {
          as: bob,
          body: { filename: 'x', size: big + 1, sha256: 'b'.repeat(64) },
        })
      ).status,
    ).toBe(400)
  })

  it('the sweep removes abandoned sessions and re-dispatches stuck assemblies', async () => {
    const h = harness()
    const file = bigClip()
    const abandoned = await start(h, h.member, file)
    await part(h, h.member, abandoned.id, 0, file)
    h.deps.platform.onAssemble = null
    const stuck = await start(h, h.member, file)
    for (let i = 0; i < 3; i++) await part(h, h.member, stuck.id, i, file)
    await complete(h, h.member, stuck.id)
    h.deps.clock.advance(25 * 3600_000)
    await runCleanup(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    expect(await h.deps.store.getUpload(abandoned.id)).toBeNull()
    expect(await partsInStore(h.deps, abandoned.id)).toEqual([])
    expect(h.deps.platform.assemblies).toEqual([stuck.id, stuck.id])
  })
})
