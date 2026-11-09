// Large library media in preview bundles (screen-recording plan §1, va-rsk5.2.9): an item over BY_KEY_MIN is listed
// in the bundle index with `src: { store: 'media' }` and served by the preview edge function from the media store
// (with Range), instead of being copied into the bundles store; smaller items are still copied; the version stays
// editable. One JSON line per entry: { jobId, n, path, mode, bytes }.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BY_KEY_MIN, bundleFileKey, bundleIndexKey, ensureBundle } from '../server/domain/bundles.js'
import { NO_PROVENANCE, type MediaRow, type VersionMediaRow } from '../server/domain/types.js'
import { sha256Hex } from '../server/lib/crypto.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { harness, PROMPT, readyVideo, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

/** A library clip of `size` bytes in the media store, listed in v1's version_media. */
async function clip(h: Harness, jobId: string, id: string, size: number) {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) & 0xff
  const key = `${id}/original.mp4`
  await h.deps.blobs.set('media', key, bytes)
  const at = h.deps.clock.now().toISOString()
  const row: MediaRow = {
    id,
    uploaderId: 'u_member',
    kind: 'video',
    status: 'ready',
    rejectReason: null,
    filename: `${id}.mp4`,
    title: null,
    caption: null,
    mime: 'video/mp4',
    ext: 'mp4',
    bytes: size,
    originalKey: key,
    originalSha256: sha256Hex(bytes),
    cleanKey: key,
    cleanSha256: sha256Hex(bytes),
    width: 320,
    height: 180,
    durationSec: 3,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role: null,
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
  }
  await h.deps.store.insertMedia(row)
  const vm: VersionMediaRow = {
    jobId,
    versionN: 1,
    mediaId: id,
    position: 0,
    kind: 'video',
    key,
    sha256: sha256Hex(bytes),
    filename: `${id}.mp4`,
    caption: null,
  }
  await h.deps.store.insertVersionMedia([vm])
  return bytes
}

/** v1's bundle made again, now that its version_media lists the clips. */
async function rebuild(h: Harness, jobId: string) {
  await h.deps.blobs.delete('bundles', bundleIndexKey(jobId, 1))
  const index = await ensureBundle(h.deps, jobId, 1)
  if (!index) throw new Error('no bundle')
  for (const f of index.files.filter((e) => e.path.startsWith('assets/media/')))
    log({ jobId, n: 1, path: f.path, mode: f.src?.store === 'media' ? 'by-key' : 'copy', bytes: f.size })
  return index
}

describe('preview bundles: large library media by key', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  it('lists a clip over 8 MiB by key and copies a small one; the version stays editable', async () => {
    const h = harness()
    current = h.deps
    // A contract-1 composition whose stylesheet uses the big clip, so a missing file would make it not editable.
    const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
    h.deps.nextSource = tarGz([
      { name: 'video/index.html', body: fx('index.html') },
      { name: 'video/summary.json', body: fx('summary.json') },
      { name: 'video/style.css', body: ".bg { background: url('assets/media/med_big.mp4') }" },
    ])
    const v = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    const id = v.id
    await clip(h, id, 'med_big', BY_KEY_MIN + 1)
    const small = await clip(h, id, 'med_small', 1024 * 1024)
    const index = await rebuild(h, id)
    const big = index.files.find((f) => f.path === 'assets/media/med_big.mp4')
    expect(big).toMatchObject({ size: BY_KEY_MIN + 1, src: { store: 'media', key: 'med_big/original.mp4' } })
    expect(await h.deps.blobs.get('bundles', bundleFileKey(id, 1, 'assets/media/med_big.mp4'))).toBeNull()
    const copied = index.files.find((f) => f.path === 'assets/media/med_small.mp4')
    expect(copied?.src).toBeUndefined()
    expect(await h.deps.blobs.get('bundles', bundleFileKey(id, 1, 'assets/media/med_small.mp4'))).toEqual(
      small,
    )
    expect(index.contract?.version).toBe(1)
  })

  it('the preview edge function serves the by-key clip from the media store with Range', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h)
    const bytes = await clip(h, id, 'med_big', BY_KEY_MIN + 1)
    await rebuild(h, id)
    const link = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as: h.member }),
    )
    const base = link.url.replace(/index\.html$/, '')
    const edge = await loadEdge('preview')
    const res = await edge(
      new Request(`${base}assets/media/med_big.mp4`, { headers: { range: 'bytes=4096-4097' } }),
      {
        deploy: { published: true },
      },
    )
    log({ jobId: id, n: 1, path: 'assets/media/med_big.mp4', mode: 'by-key', status: res.status })
    expect(res.status).toBe(206)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.subarray(4096, 4098))
    const missing = await edge(new Request(`${base}assets/media/med_none.mp4`), {
      deploy: { published: true },
    })
    expect(missing.status).toBe(404)
  })
})
