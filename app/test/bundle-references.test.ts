// Reference entries (plan 2026-11-02 §6.2): the narration bus is uploaded on its own, kept by key in the videos
// store with its entry pinned next to the source archive, restored by key + sha256, and previewed under the
// version's capability, never a draft's.
import { describe, expect, it, vi } from 'vitest'
import { bundleFileKey, ensureBundle, readBundleIndex, readReferences } from '../server/domain/bundles.js'
import { editScope } from '../server/domain/edits.js'
import { isManifest } from '../server/domain/finalize.js'
import { getSettings } from '../server/domain/settings.js'
import { REFERENCES_FILE, referencesKey } from '../server/lib/bundle-references.js'
import { NARRATION_SRC } from '../server/lib/contract.js'
import { sha256Hex, signPath } from '../server/lib/crypto.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'
import { readTarGz } from '../server/lib/tar.js'
import type { TestDeps } from './fakes.js'
import { loadEdge } from './edge.js'
import { harness, person, readyVideo, stubNetlify, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

/** A WAV-sized stand-in: finalize and the preview check digests, not samples. */
const BUS = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251))

async function narrated(h: Harness) {
  h.deps.nextSource = tarGz([
    {
      name: 'video/index.html',
      body: `<!doctype html><audio id="va-narration" src="${NARRATION_SRC}"></audio>`,
    },
    { name: 'video/summary.json', body: '{}' },
  ])
  h.deps.nextBus = BUS
  return readyVideo(h)
}

const dropBundle = async (h: Harness, id: string) => {
  for (const k of await h.deps.blobs.list('bundles', `${id}/v1/`)) await h.deps.blobs.delete('bundles', k)
}

describe('reference entries', () => {
  it('finalize keeps the bus by key, pins its entry and leaves the archive as it was', async () => {
    const h = harness()
    const id = await narrated(h)
    const out = await h.deps.store.getOutput(id, 1)
    expect(await h.deps.blobs.get('videos', `${id}/v1/narration-bus.wav`)).toEqual(BUS)
    const raw = await h.deps.blobs.get('sources', referencesKey(id, 1))
    expect(out?.sha256[REFERENCES_FILE]).toBe(sha256Hex(raw ?? ''))
    expect(await readReferences(h.deps, out!)).toEqual([
      {
        path: NARRATION_SRC,
        key: `${id}/v1/narration-bus.wav`,
        sha256: sha256Hex(BUS),
        bytes: BUS.byteLength,
      },
    ])
    const gz = await h.deps.blobs.get('sources', out!.sourceKey)
    expect([...readTarGz(gz!).keys()].sort()).toEqual(['index.html', 'summary.json'])
    // The preview bundle lists it, served from the videos store, not copied into the bundle.
    const index = await readBundleIndex(h.deps, id, 1)
    expect(index?.files.find((f) => f.path === NARRATION_SRC)).toEqual({
      path: NARRATION_SRC,
      size: BUS.byteLength,
      sha256: sha256Hex(BUS),
      src: { store: 'videos', key: `${id}/v1/narration-bus.wav` },
    })
    expect(await h.deps.blobs.list('bundles', `${id}/v1/f/assets/`)).toEqual([])
  })

  it('versions without references keep their outputs and bundles exactly as before', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const out = await h.deps.store.getOutput(id, 1)
    expect(Object.keys(out!.sha256).sort()).toEqual(
      ['captions.vtt', 'poster.jpg', 'preview.gif', 'source.tar.gz', 'video.mp4'].sort(),
    )
    expect(await readReferences(h.deps, out!)).toEqual([])
    expect(await h.deps.blobs.get('sources', referencesKey(id, 1))).toBeNull()
  })

  it('a revision restores the parent bus by key, from a hash-pinned run manifest', async () => {
    const h = harness()
    const id = await narrated(h)
    await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Shorter title', fromVersion: 1 },
    })
    await h.drive(2)
    const req = h.deps.runner.starts[1]
    const sha = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
    const raw = new TextDecoder().decode(
      (await h.deps.blobs.get('sources', runManifestKey(id, req?.requestId ?? ''))) ?? new Uint8Array(),
    )
    const m = verifyRunManifest(raw, { attemptId: req?.requestId ?? '', sha256: sha })
    expect(m.source?.references).toEqual([
      {
        path: NARRATION_SRC,
        key: `${id}/v1/narration-bus.wav`,
        sha256: sha256Hex(BUS),
        bytes: BUS.byteLength,
      },
    ])
  })

  it('refuses a bus or an entry list that does not match its digest', async () => {
    const h = harness()
    const id = await narrated(h)
    await dropBundle(h, id)
    await h.deps.blobs.set('videos', `${id}/v1/narration-bus.wav`, new Uint8Array([1, 2, 3]))
    await expect(ensureBundle(h.deps, id, 1)).rejects.toThrow(/bus\.wav doesn't match its hash/)
    expect(await readBundleIndex(h.deps, id, 1)).toBeNull()
    await h.deps.blobs.set('videos', `${id}/v1/narration-bus.wav`, BUS)
    const raw = h.deps.blobs.text('sources', referencesKey(id, 1)) ?? ''
    await h.deps.blobs.set('sources', referencesKey(id, 1), raw.replace(`${id}/v1/`, `${id}/v9/`))
    await expect(ensureBundle(h.deps, id, 1)).rejects.toThrow(/references don't match their hash/)
    await h.deps.blobs.set('sources', referencesKey(id, 1), raw)
    expect((await ensureBundle(h.deps, id, 1))?.files.map((f) => f.path)).toContain(NARRATION_SRC)
  })

  it("checks the run's reference list: known paths, once each, with a digest and a size", () => {
    const m = (references: unknown) => ({
      jobId: 'vid_1',
      attemptId: 'att_1',
      title: 't',
      summary: 's',
      files: Object.fromEntries(
        ['video.mp4', 'poster.jpg', 'preview.gif', 'captions.vtt', 'source.tar.gz'].map((f) => [
          f,
          { sha256: 'a'.repeat(64), bytes: 1 },
        ]),
      ),
      ...(references === undefined ? {} : { references }),
    })
    const ok = { path: NARRATION_SRC, sha256: 'b'.repeat(64), bytes: 10 }
    expect(isManifest(m(undefined), 'att_1')).toBe(true)
    expect(isManifest(m([ok]), 'att_1')).toBe(true)
    for (const bad of [
      [{ ...ok, path: 'assets/other.wav' }],
      [ok, ok],
      [{ ...ok, sha256: 'nope' }],
      [{ ...ok, bytes: 0 }],
      [{ ...ok, bytes: 1024 ** 3 }],
      'x',
    ])
      expect(isManifest(m(bad), 'att_1')).toBe(false)
  })
})

describe('previewing the bus', () => {
  stubNetlify(() => {
    current = null
  })
  const edge = async (url: string, init: RequestInit = {}) =>
    (await loadEdge('preview'))(new Request(url, init), { deploy: { published: true } })
  const mint = async (h: Harness, id: string, as = h.member) =>
    h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as })

  it("readers of the version get it, checked, under the version's capability; others don't", async () => {
    const h = harness()
    current = h.deps
    const id = await narrated(h)
    const link = (await h.json<{ url: string }>(await mint(h, id))).url
    const bus = link.replace(/index\.html$/, NARRATION_SRC)
    const res = await edge(bus)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BUS)
    const part = await edge(bus, { headers: { range: 'bytes=10-13' } })
    expect(part.status).toBe(206)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(BUS.slice(10, 14))
    const head = await edge(bus, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe(String(BUS.byteLength))
    // The capability is the version's: tampered or for another version, it opens nothing.
    expect((await edge(bus.replace(/[0-9a-f](?=\/assets)/, (c) => (c === 'a' ? 'b' : 'a')))).status).toBe(403)
    expect((await edge(bus.replace('/v1/', '/v2/'))).status).toBe(403)
    // Private: only people who can read the version get a link, and old links stop working.
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await edge(bus)).status).toBe(403)
    const bob = await person(h, 'u_bob')
    expect((await mint(h, id, bob)).status).toBe(404)
    const fresh = (await h.json<{ url: string }>(await mint(h, id))).url
    expect((await edge(fresh.replace(/index\.html$/, NARRATION_SRC))).status).toBe(200)
  })

  it('a bus that no longer matches its digest is not served', async () => {
    const h = harness()
    current = h.deps
    const id = await narrated(h)
    const link = (await h.json<{ url: string }>(await mint(h, id))).url
    await h.deps.blobs.set('videos', `${id}/v1/narration-bus.wav`, BUS.slice(1))
    expect((await edge(link.replace(/index\.html$/, NARRATION_SRC))).status).toBe(502)
  })

  it('a draft preview has no bus: 404, even when its manifest lists one', async () => {
    const h = harness()
    current = h.deps
    const id = await narrated(h)
    const editId = '0f8e6a2c-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
    const prefix = `${id}/v1/e/${editId}/r1/`
    const index = await readBundleIndex(h.deps, id, 1)
    // Like an edit draft's: unchanged files point at the version's bundle (and the bus at the videos store).
    const files = index!.files.map((f) => ({
      ...f,
      src: f.src ?? { store: 'bundles', key: bundleFileKey(id, 1, f.path) },
    }))
    await h.deps.blobs.set('bundles', `${prefix}manifest.json`, JSON.stringify({ ...index, files }))
    const { fileSigningSecret } = await getSettings(h.deps)
    const exp = Math.floor(h.deps.clock.now().getTime() / 1000) + 600
    const sig = signPath(fileSigningSecret, editScope(id, 1, editId), exp)
    const base = `https://video.example.com/preview/${id}/v1/${exp}.x.${sig}/e/${editId}/r1/`
    expect((await edge(base + NARRATION_SRC)).status).toBe(404)
    // The draft's other files are served as usual under the same capability.
    expect((await edge(base + 'summary.json')).status).toBe(200)
  })
})
