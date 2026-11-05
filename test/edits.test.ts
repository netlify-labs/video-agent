// Edit drafts (plan v2 §8): per-person drafts of editable versions, re-applied by the server, previewed through a
// draft-scoped capability, and swept when they expire.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundleFileKey } from '../src/domain/bundles.js'
import { runCleanup } from '../src/domain/cleanup.js'
import { editRevPrefix } from '../src/domain/edits.js'
import type { TestDeps } from './fakes.js'
import { font, harness, person, png, PROMPT, upload, type Harness } from './helpers.js'
import { loadEdge } from './edge.js'
import { tarGz } from './tarball.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))
const edge = async (url: string) =>
  (await loadEdge('preview'))(new Request(url), { deploy: { published: true } })

/** A ready video whose v1 keeps contract v1 (the spike S8 fixture, or its copy with a music layer). */
async function editableVideo(
  h: Harness,
  html = fx('index.html'),
  extra: { name: string; body: string | Uint8Array }[] = [],
) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: fx('summary.json') },
    ...extra,
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

interface Edit {
  id: string
  rev: number
  baseN: number
  newerVersion: number | null
  palette: string[]
  composition: { duration: number; beats: { id: string; start: number; duration: number }[] }
}
const open = (h: Harness, id: string, as = h.member) =>
  h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as })
const save = (h: Harness, editId: string, body: object, as = h.member) =>
  h.call('PUT', `/api/v1/edits/${editId}`, { as, body })

describe('edit drafts', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  it('a version whose contract finalize never recorded becomes editable once its bundle is made', async () => {
    const h = harness()
    current = h.deps
    const id = await editableVideo(h)
    // Finalize's bundle step failed: no record, no bundle.
    await h.deps.store.updateVersion(id, 1, { contract: null })
    await h.deps.blobs.delete('bundles', `${id}/v1/manifest.json`)
    const before = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(before.versions[0].editable).toBe(false)
    // Opening its preview makes the bundle, and records that it keeps the contract.
    expect((await h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as: h.member })).status).toBe(
      200,
    )
    const after = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(after.versions[0].editable).toBe(true)
    expect((await open(h, id)).status).toBe(201)
  })

  it('opens one draft per person per version, with the composition to edit', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const first = await open(h, id)
    expect(first.status).toBe(201)
    const e = await h.json<Edit>(first)
    expect(e).toMatchObject({ rev: 0, baseN: 1, newerVersion: null })
    expect(e.composition.beats.map((b) => b.id)).toEqual(['intro', 'demo', 'outro'])
    expect(e.palette).toContain('#14b8a6')
    const again = await open(h, id)
    expect(again.status).toBe(200)
    expect((await h.json<Edit>(again)).id).toBe(e.id)
    const bob = await person(h, 'u_bob')
    const bobs = await h.json<Edit>(await open(h, id, bob))
    expect(bobs.id).not.toBe(e.id)
  })

  it('only creators and admins edit, and only editable versions', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const rita = await person(h, 'u_rita', 'reviewer')
    expect((await open(h, id, rita)).status).toBe(403)
    const plain = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    const res = await h.call('POST', `/api/v1/videos/${plain.id}/versions/1/edits`, { as: h.member })
    expect(res.status).toBe(409)
    expect((await h.json(res)).error.message).toContain('Ask for a revision instead')
  })

  it('a rev of a version on another engine records no contract (render-engines §4.1)', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    const manifest = async (rev: number) =>
      JSON.parse(
        new TextDecoder().decode(
          await h.deps.blobs.get('bundles', `${editRevPrefix(id, 1, e.id, rev)}manifest.json`),
        ),
      )
    await save(h, e.id, { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4.5 }] })
    expect((await manifest(1)).contract).toEqual({ version: 1, violations: [] })
    // Only a bug could put a draft on a Remotion version; the rev still says it isn't editable.
    await h.deps.store.updateVersion(id, 1, { engine: 'remotion' })
    await save(h, e.id, { rev: 1, ops: [{ op: 'retime', beat: 'intro', duration: 5 }] })
    expect((await manifest(2)).contract).toEqual({
      version: null,
      violations: ["Editing isn't available for Remotion videos yet."],
    })
  })

  it('saves the full op list as the next rev, re-applied on the server', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    const saved = await h.json<Edit>(
      await save(h, e.id, { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4.5 }] }),
    )
    expect(saved.rev).toBe(1)
    expect(saved.composition.duration).toBe(10.5)
    expect(saved.composition.beats.map((b) => b.start)).toEqual([0, 4.5, 7.5])
    const html = new TextDecoder().decode(
      await h.deps.blobs.get('bundles', `${editRevPrefix(id, 1, e.id, 1)}f/index.html`),
    )
    expect(html).toMatch(/data-va-beat="intro"[^>]*data-duration="4.5"/)
    // Only the newest rev's bundle is kept.
    expect(await h.deps.blobs.list('bundles', editRevPrefix(id, 1, e.id, 0))).toEqual([])
    const more = await h.json<Edit>(
      await save(h, e.id, {
        rev: 1,
        ops: [
          { op: 'retime', beat: 'intro', duration: 4.5 },
          { op: 'text', id: 'outro-cta', text: 'Start free' },
        ],
      }),
    )
    expect(more.rev).toBe(2)
    expect((await h.json<Edit>(await h.call('GET', `/api/v1/edits/${e.id}`, { as: h.member }))).rev).toBe(2)
  })

  it('refuses stale revs, impossible edits and colours off the palette', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    await save(h, e.id, { rev: 0, ops: [] })
    const stale = await save(h, e.id, { rev: 0, ops: [] })
    expect(stale.status).toBe(409)
    expect((await h.json(stale)).error.message).toContain('another tab')
    const last = await save(h, e.id, {
      rev: 1,
      ops: [
        { op: 'delete', beat: 'intro' },
        { op: 'delete', beat: 'demo' },
        { op: 'delete', beat: 'outro' },
      ],
    })
    expect(last.status).toBe(400)
    expect((await h.json(last)).error.message).toContain("last beat can't be deleted")
    expect(
      (await save(h, e.id, { rev: 1, ops: [{ op: 'color', role: 'accent', value: '#123456' }] })).status,
    ).toBe(400)
    expect(
      (await save(h, e.id, { rev: 1, ops: [{ op: 'color', role: 'accent', value: '#f4f5f7' }] })).status,
    ).toBe(200)
    expect((await save(h, e.id, { rev: 2, ops: [{ op: 'nope' }] })).status).toBe(400)
  })

  it('drafts are private to their author, and report a newer version', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    const bob = await person(h, 'u_bob')
    expect((await h.call('GET', `/api/v1/edits/${e.id}`, { as: bob })).status).toBe(404)
    expect((await save(h, e.id, { rev: 0, ops: [] }, bob)).status).toBe(404)
    await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    expect(
      (await h.json<Edit>(await h.call('GET', `/api/v1/edits/${e.id}`, { as: h.member }))).newerVersion,
    ).toBe(2)
  })

  it('previews the current rev through a draft-scoped capability', async () => {
    const h = harness()
    current = h.deps
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    await save(h, e.id, { rev: 0, ops: [{ op: 'text', id: 'intro-title', text: 'Draft title' }] })
    const link = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/edits/${e.id}/preview`, { as: h.member }),
    )
    expect(link.url).toMatch(new RegExp(`/preview/${id}/v1/[^/]+/e/${e.id}/r1/index\\.html$`))
    const res = await edge(link.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Draft title')
    // The runtime and bridge are served inside the draft too, or the editor's preview can't play or seek.
    vi.stubGlobal('fetch', async () => new Response('/* runtime */'))
    for (const f of ['_hf/runtime.js', '_hf/bridge.js', '_hf/gsap.js'])
      expect((await edge(link.url.replace('index.html', f))).status).toBe(200)
    // The draft capability doesn't open the version, and the version capability doesn't open the draft.
    expect((await edge(link.url.replace(`e/${e.id}/r1/`, ''))).status).toBe(403)
    const version = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/videos/${id}/versions/1/preview`, { as: h.member }),
    )
    expect((await edge(version.url.replace('index.html', `e/${e.id}/r1/index.html`))).status).toBe(403)
    const bob = await person(h, 'u_bob')
    expect((await h.call('GET', `/api/v1/edits/${e.id}/preview`, { as: bob })).status).toBe(404)
  })

  it('swaps a media slot for a library item: served from the library, snapshotted when rendered', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    current = h.deps
    const id = await editableVideo(h)
    const up = async (bytes: Uint8Array, name: string) =>
      h.json<{ id: string }>(await upload(h, h.member, bytes, `filename=${name}`))
    const pngBytes = png(64, 32)
    const logo = await up(pngBytes, 'logo.png')
    const typeface = await up(font(), 'brand.woff2')
    const e = await h.json<Edit>(await open(h, id))
    const swap = (src: string, kind = 'image') => ({ op: 'media', slot: 'logo', src, kind, fit: 'cover' })

    // Only a ready item of the slot's kind can go in.
    for (const bad of [
      swap(`assets/media/${typeface.id}.woff2`),
      swap('assets/media/med_nope.png'),
      swap(`assets/media/${logo.id}.png`, 'video'),
    ])
      expect((await save(h, e.id, { rev: 0, ops: [bad] })).status).toBe(400)

    const saved = await save(h, e.id, { rev: 0, ops: [swap(`assets/media/${logo.id}.png`)] })
    expect(saved.status).toBe(200)
    // A save writes only what changed; the swapped-in file is served from the library.
    expect((await h.deps.blobs.list('bundles', `${editRevPrefix(id, 1, e.id, 1)}f/`)).sort()).toEqual([
      `${editRevPrefix(id, 1, e.id, 1)}f/index.html`,
      `${editRevPrefix(id, 1, e.id, 1)}f/summary.json`,
    ])
    const link = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/edits/${e.id}/preview`, { as: h.member }),
    )
    const html = await (await edge(link.url)).text()
    expect(html).toMatch(new RegExp(`src="assets/media/${logo.id}\\.png"[^>]*object-fit: cover`))
    const img = await edge(link.url.replace('index.html', `assets/media/${logo.id}.png`))
    expect(img.status).toBe(200)
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(pngBytes)
    // Unchanged files still come from the base version.
    expect((await edge(link.url.replace('index.html', 'summary.json'))).status).toBe(200)

    const res = await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: h.member })
    expect(res.status).toBe(202)
    expect((await h.deps.store.listVersionMedia(id, 2)).map((r) => r.mediaId)).toContain(logo.id)
    // Deleting the item from the library afterwards doesn't touch the rendered version's snapshot.
    await h.call('DELETE', `/api/v1/media/${logo.id}`, { as: h.member })
    expect((await h.deps.store.listVersionMedia(id, 2)).map((r) => r.mediaId)).toContain(logo.id)
  })

  it('a version that no longer passes the editing check gets a clear 409, not a server error', async () => {
    const h = harness()
    current = h.deps
    const music = readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')
    const id = await editableVideo(h, music, [{ name: 'video/assets/media/poster.png', body: png(16, 16) }])
    // As if a stricter rule had shipped after the version was made: a gain past HyperFrames' maximum.
    await h.deps.blobs.set(
      'bundles',
      bundleFileKey(id, 1, 'index.html'),
      new TextEncoder().encode(music.replace('data-volume="0.8"', 'data-volume="9"')),
    )
    const res = await open(h, id)
    expect(res.status).toBe(409)
    expect((await h.json<{ error: { message: string } }>(res)).error.message).toMatch(
      /can't be edited in the browser \(Audio "music" needs data-volume between 0 and 4\.\)/,
    )
  })

  it('swaps, levels and mutes the music: library audio only, served from the library, snapshotted', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    current = h.deps
    const music = readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')
    const id = await editableVideo(h, music, [{ name: 'video/assets/media/poster.png', body: png(16, 16) }])
    const up = async (bytes: Uint8Array, name: string) =>
      h.json<{ id: string }>(await upload(h, h.member, bytes, `filename=${name}`))
    const toneBytes = tone()
    const track = await up(toneBytes, 'theme.mp3')
    const picture = await up(png(64, 32), 'logo.png')
    const e = await h.json<Edit & { composition: { audio: { id: string; src: string }[] } }>(
      await open(h, id),
    )
    expect(e.composition.audio).toEqual([
      {
        id: 'music',
        role: 'music',
        label: 'Music',
        src: 'assets/media/med_theme01.mp3',
        volume: 0.8,
        muted: false,
        beat: null,
      },
    ])
    const audio = (o: object) => ({ op: 'audio', id: 'music', ...o })

    // Only a ready audio item from the library (or a sound file the video already has) can go in.
    for (const bad of [
      audio({ src: `assets/media/${picture.id}.png` }),
      audio({ src: 'assets/media/med_nope.mp3' }),
      audio({ src: 'assets/media/poster.png' }),
      audio({ volume: 4.5 }),
      audio({ id: 'nope', volume: 0.5 }),
    ])
      expect((await save(h, e.id, { rev: 0, ops: [bad] })).status).toBe(400)

    const saved = await h.json<{ composition: { audio: unknown[] } }>(
      await save(h, e.id, {
        rev: 0,
        ops: [audio({ src: `assets/media/${track.id}.mp3`, volume: 0.4, muted: true })],
      }),
    )
    expect(saved.composition.audio).toEqual([
      expect.objectContaining({ src: `assets/media/${track.id}.mp3`, volume: 0.4, muted: true }),
    ])
    const link = await h.json<{ url: string }>(
      await h.call('GET', `/api/v1/edits/${e.id}/preview`, { as: h.member }),
    )
    const html = await (await edge(link.url)).text()
    expect(html).toMatch(
      new RegExp(`<audio id="music"[^>]*src="assets/media/${track.id}\\.mp3"[^>]*data-volume="0"`),
    )
    const file = await edge(link.url.replace('index.html', `assets/media/${track.id}.mp3`))
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(toneBytes)

    expect((await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: h.member })).status).toBe(202)
    expect((await h.deps.store.listVersionMedia(id, 2)).map((r) => [r.mediaId, r.kind])).toContainEqual([
      track.id,
      'audio',
    ])
  })

  it('discarding or expiring removes the draft and its bundle', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json<Edit>(await open(h, id))
    expect((await h.call('DELETE', `/api/v1/edits/${e.id}`, { as: h.member })).status).toBe(204)
    expect((await h.call('GET', `/api/v1/edits/${e.id}`, { as: h.member })).status).toBe(404)
    expect(await h.deps.blobs.list('bundles', `${id}/v1/e/${e.id}/`)).toEqual([])
    const e2 = await h.json<Edit>(await open(h, id))
    h.deps.clock.advance(8 * 24 * 3600_000)
    expect((await h.call('GET', `/api/v1/edits/${e2.id}`, { as: h.member })).status).toBe(404)
    await runCleanup(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    expect(await h.deps.store.getEdit(e2.id)).toBeNull()
    expect(await h.deps.blobs.list('bundles', `${id}/v1/e/${e2.id}/`)).toEqual([])
  })
})
