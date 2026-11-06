// Preview bundles (plan v2 §7): extracted from each ready version's source archive, validated, immutable, staged
// then committed, and never resurrected for a deleted video.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  bundleFileKey,
  bundleIndexKey,
  contractForEngine,
  contractOf,
  ensureBundle,
  missingLocalFiles,
  readBundleIndex,
} from '../src/domain/bundles.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { readTarGz, TarError } from '../src/lib/tar.js'
import { harness, PROMPT, readyVideo } from './helpers.js'
import { tarGz } from './tarball.js'

describe('tar reader', () => {
  it('reads regular files under video/, with GNU long names and pax paths', () => {
    const long = `video/${'deep/'.repeat(30)}scene.html`
    const files = readTarGz(
      tarGz([
        { name: 'video/', type: '5' },
        { name: 'video/index.html', body: '<h1>hi</h1>' },
        { name: 'video/assets/', type: '5' },
        { name: 'video/assets/logo.svg', body: '<svg/>' },
        { name: '././@LongLink', type: 'L', body: long },
        { name: 'video/deep/trunc', body: 'long one' },
        { name: 'PaxHeader', type: 'x', body: '30 path=video/pax/named.css\n' },
        { name: 'video/ignored-name', body: 'pax one' },
      ]),
    )
    expect([...files.keys()].sort()).toEqual(
      ['assets/logo.svg', 'index.html', long.slice('video/'.length), 'pax/named.css'].sort(),
    )
    expect(new TextDecoder().decode(files.get('index.html'))).toBe('<h1>hi</h1>')
  })

  it.each([
    ['traversal', [{ name: 'video/../AGENTS.md', body: 'x' }], /Unsafe path/],
    ['outside video/', [{ name: 'netlify.toml', body: 'x' }], /outside video/],
    ['absolute', [{ name: '/etc/passwd', body: 'x' }], /outside video/],
    ['symlink', [{ name: 'video/link', type: '2', linkname: '/etc/passwd' }], /Links and special files/],
    [
      'hard link',
      [{ name: 'video/hard', type: '1', linkname: 'video/index.html' }],
      /Links and special files/,
    ],
    ['empty segment', [{ name: 'video//x.html', body: 'x' }], /Unsafe path/],
  ])('refuses %s', (_name, entries, msg) => {
    expect(() => readTarGz(tarGz(entries))).toThrow(msg)
  })

  it('refuses bombs: too many entries, too large a file, too much in total, not gzip', () => {
    const limits = { maxEntries: 5, maxTotalBytes: 1000, maxFileBytes: 600 }
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `video/f${i}`, body: 'x' }))
    expect(() => readTarGz(tarGz(many), limits)).toThrow(/More than 5 entries/)
    expect(() => readTarGz(tarGz([{ name: 'video/big', body: 'x'.repeat(700) }]), limits)).toThrow(/over 600/)
    const two = [
      { name: 'video/a', body: 'x'.repeat(550) },
      { name: 'video/b', body: 'x'.repeat(550) },
    ]
    expect(() => readTarGz(tarGz(two), limits)).toThrow(/more than 1000/)
    // A tiny gzip that expands past the cap stops at decompression.
    expect(() => readTarGz(tarGz([{ name: 'video/z', body: '\0'.repeat(5_000_000) }]), limits)).toThrow(
      TarError,
    )
    expect(() => readTarGz(new TextEncoder().encode('plain'))).toThrow(/Not a readable/)
  })
})

describe('preview bundles', () => {
  it('finalize extracts a manifest of the version composition (no MP4s, no stills)', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const index = await readBundleIndex(h.deps, id, 1)
    expect(index?.files.map((f) => f.path).sort()).toEqual(['index.html', 'summary.json'])
    const html = await h.deps.blobs.get('bundles', bundleFileKey(id, 1, 'index.html'))
    expect(index?.files.find((f) => f.path === 'index.html')?.sha256).toBe(
      sha256Hex(html ?? new Uint8Array()),
    )
  })

  it('extracts older versions on demand, keeps agent-made clips, skips stray renders and stills, and is idempotent', async () => {
    const h = harness()
    const id = await readyVideo(h)
    // Replace the saved source with one carrying an MP4 and stills, and drop the bundle, like a pre-F0 version.
    const out = await h.deps.store.getOutput(id, 1)
    const gz = tarGz([
      { name: 'video/index.html', body: '<h1 id="t">v1</h1>' },
      { name: 'video/assets/media/clip.mp4', body: 'mp4' },
      { name: 'video/out.mp4', body: 'stray render' },
      { name: 'video/feedback/01-c.jpg', body: 'jpg' },
    ])
    await h.deps.blobs.set('sources', out?.sourceKey ?? '', gz)
    await h.deps.store.upsertOutput({ ...out!, sha256: { ...out!.sha256, 'source.tar.gz': sha256Hex(gz) } })
    for (const k of await h.deps.blobs.list('bundles', `${id}/v1/`)) await h.deps.blobs.delete('bundles', k)
    const index = await ensureBundle(h.deps, id, 1)
    expect(index?.files.map((f) => f.path).sort()).toEqual(['assets/media/clip.mp4', 'index.html'])
    const again = await ensureBundle(h.deps, id, 1)
    expect(again?.createdAt).toBe(index?.createdAt)
  })

  it("refuses a source that doesn't match its hash", async () => {
    const h = harness()
    const id = await readyVideo(h)
    const out = await h.deps.store.getOutput(id, 1)
    await h.deps.blobs.set(
      'sources',
      out?.sourceKey ?? '',
      tarGz([{ name: 'video/index.html', body: 'tampered' }]),
    )
    for (const k of await h.deps.blobs.list('bundles', `${id}/v1/`)) await h.deps.blobs.delete('bundles', k)
    await expect(ensureBundle(h.deps, id, 1)).rejects.toThrow(/doesn't match its hash/)
    expect(await readBundleIndex(h.deps, id, 1)).toBeNull()
  })

  it('a deletion during extraction wins: nothing is left behind', async () => {
    const h = harness()
    const id = await readyVideo(h)
    for (const k of await h.deps.blobs.list('bundles', `${id}/v1/`)) await h.deps.blobs.delete('bundles', k)
    // Delete the video right as the manifest is committed.
    const set = h.deps.blobs.set.bind(h.deps.blobs)
    h.deps.blobs.set = async (store, key, data, meta) => {
      await set(store, key, data, meta)
      if (store === 'bundles' && key === bundleIndexKey(id, 1))
        await h.deps.store.updateJob(id, { deletedAt: h.deps.clock.now().toISOString() })
    }
    expect(await ensureBundle(h.deps, id, 1)).toBeNull()
    expect(await h.deps.blobs.list('bundles', `${id}/v1/`)).toEqual([])
  })

  it('deleting a video schedules cleanup of its bundles', async () => {
    const h = harness()
    const id = await readyVideo(h)
    await h.call('DELETE', `/api/v1/videos/${id}`, { as: h.member })
    const due = await h.deps.store.listDueCleanup(new Date(Date.now() + 365 * 86400_000).toISOString(), 100)
    expect(due.some((c) => c.store === 'bundles' && c.prefix === `${id}/`)).toBe(true)
  })

  it('a contract-1 composition that uses files that were never saved is not editable', () => {
    const html = (src: string) =>
      new TextEncoder().encode(
        `<div id="root" data-composition-id="x" data-va-contract="1"><img src="${src}"><img src="assets/media/med_abc.png"><script src="https://cdn.example.com/x.js"></script><img src="data:image/png;base64,AA"></div>`,
      )
    const files = new Map([['index.html', html('assets/media/poster.png')]])
    expect(missingLocalFiles(files)).toEqual(['assets/media/poster.png'])
    files.set('assets/media/poster.png', new Uint8Array([1]))
    expect(missingLocalFiles(files)).toEqual([])
    // CSS url() references count too.
    files.set('style.css', new TextEncoder().encode("h1 { background: url('fonts/missing.woff2') }"))
    expect(missingLocalFiles(files)).toEqual(['fonts/missing.woff2'])
  })
})

describe('contract per engine (render-engines §4.1)', () => {
  const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
  const files = () =>
    new Map([
      ['index.html', new TextEncoder().encode(fx('index.html'))],
      ['summary.json', new TextEncoder().encode(fx('summary.json'))],
    ])

  it('HyperFrames, or a row from before engines, gets the contract check unchanged', () => {
    expect(contractForEngine('hyperframes', files())).toEqual(contractOf(files()))
    expect(contractForEngine(undefined, files())).toEqual({ version: 1, violations: [] })
  })

  it('another engine is not editable yet, whatever its files', () => {
    expect(contractForEngine('remotion', files())).toEqual({
      version: null,
      violations: ["Editing isn't available for Remotion videos yet."],
    })
  })

  it("a Remotion version's bundle records no contract, so it isn't editable", async () => {
    const h = harness()
    // What a Remotion run would save and report (Phase 2), so finalize's engine checks pass.
    h.deps.nextSource = tarGz([
      { name: 'video/props.json', body: '{"contract":1}' },
      { name: 'video/src/Root.tsx', body: 'export const Root = () => null' },
      { name: 'video/summary.json', body: fx('summary.json') },
    ])
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.deps.store.updateVersion(v.id, 1, { engine: 'remotion' })
    await h.drive(4)
    const video = await h.json(await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }))
    expect(video.versions[0]).toMatchObject({ status: 'ready', editable: false })
    expect((await readBundleIndex(h.deps, v.id, 1))?.contract).toEqual({
      version: null,
      violations: ["Editing isn't available for Remotion videos yet."],
    })
  })
})
