// Recorded narration's outputs (plan 2026-11-02 §6.7, bead va-2qq.3.16): a narrated render's narration.mp3 and
// transcript.txt are checked and kept next to the version's other files, hashed among its outputs, delivered through
// signed private links, and follow the version's publication. The transcript is a separate consent: the share page
// offers it only when the publisher chose to show it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pubKey } from '../src/domain/videos.js'
import { transcriptText } from '../src/lib/narration-captions.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { harness, pgStore, type Harness } from './helpers.js'
import { BUS, narratedDraft, render, report, tone } from './narration-render.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const TRANSCRIPT = transcriptText([
  { text: 'Welcome to webhooks.' },
  { text: 'Deliveries retry\nfor a day <and> more.' },
])

const edge = async (name: 'files' | 'public', url: string) =>
  (await loadEdge(name))(new Request(new URL(url, 'https://video.example.com')), {
    deploy: { published: true },
  })

/** A ready narrated v2 with both outputs (or the ones given). */
async function narratedVersion(h: Harness, files: Record<string, Uint8Array> = {}) {
  const { id, editId } = await narratedDraft(h, 1)
  h.deps.nextBus = BUS
  h.deps.nextExtra = {
    files: {
      'narration.mp3': tone(),
      'transcript.txt': new TextEncoder().encode(TRANSCRIPT),
      ...files,
    },
    manifest: { narration: report() },
  }
  expect((await render(h, editId)).status).toBe(202)
  await h.drive(4)
  expect((await h.deps.store.getVersion(id, 2))?.status).toBe('ready')
  return id
}

describe('narration outputs', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  it('writes the transcript as a paragraph per cue', () => {
    expect(TRANSCRIPT).toBe('Welcome to webhooks.\n\nDeliveries retry for a day <and> more.\n')
    expect(transcriptText([{ text: '  ' }])).toBe('')
  })

  it.each([
    ['memory', async () => undefined],
    ['postgres', pgStore],
  ])('keeps both, hashed among the outputs, with signed links in the DTO (%s)', async (_name, make) => {
    const store = await make()
    const h = harness({}, store ? { store } : {})
    current = h.deps
    const id = await narratedVersion(h)
    const out = (await h.deps.store.getOutput(id, 2))!
    expect(await h.deps.blobs.get('videos', `${id}/v2/narration.mp3`)).toEqual(tone())
    expect(h.deps.blobs.text('videos', `${id}/v2/transcript.txt`)).toBe(TRANSCRIPT)
    expect(h.deps.blobs.meta.get(`videos:${id}/v2/narration.mp3`)).toMatchObject({
      contentType: 'audio/mpeg',
    })
    expect(out.sha256['narration.mp3']).toBe(sha256Hex(tone()))
    expect(out.sha256['transcript.txt']).toBe(sha256Hex(TRANSCRIPT))
    expect((await h.deps.store.getVersion(id, 2))?.captions).toMatchObject({
      files: { vtt: 'captions.vtt', transcript: 'transcript.txt' },
      sha256: { transcript: sha256Hex(TRANSCRIPT) },
    })

    const dto = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    const [v2, v1] = dto.versions
    expect(v2.links).toMatchObject({
      narrationAudio: `https://video.example.com/api/v1/videos/${id}/versions/2/narration-audio`,
      transcript: `https://video.example.com/api/v1/videos/${id}/versions/2/transcript`,
    })
    expect(v1.links.narrationAudio).toBeUndefined()
    expect(v1.links.transcript).toBeUndefined()

    for (const [file, name, type] of [
      ['narration-audio', 'narration.mp3', 'audio/mpeg'],
      ['transcript', 'transcript.txt', 'text/plain; charset=utf-8'],
    ] as const) {
      const res = await h.call('GET', `/api/v1/videos/${id}/versions/2/${file}`, { as: h.member })
      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location).toMatch(new RegExp(`^/files/${id}/v2/${name.replace('.', '\\.')}\\?exp=`))
      const served = await edge('files', location)
      expect(served.status).toBe(200)
      expect(served.headers.get('content-type')).toBe(type)
      // A version without recorded narration has neither.
      expect((await h.call('GET', `/api/v1/videos/${id}/versions/1/${file}`, { as: h.member })).status).toBe(
        404,
      )
    }
  })

  it('leaves out an output that is not what it claims, and keeps the version ready', async () => {
    const h = harness()
    const id = await narratedVersion(h, { 'narration.mp3': new TextEncoder().encode('not an mp3 at all') })
    const out = (await h.deps.store.getOutput(id, 2))!
    expect(out.sha256['narration.mp3']).toBeUndefined()
    expect(await h.deps.blobs.get('videos', `${id}/v2/narration.mp3`)).toBeNull()
    expect(out.sha256['transcript.txt']).toBe(sha256Hex(TRANSCRIPT))
    const skipped = h.deps.logs
      .map((l) => JSON.parse(l) as { event: string; file?: string })
      .filter((l) => l.event === 'finalize.narration_output_skipped')
    expect(skipped.map((l) => l.file)).toEqual(['narration.mp3'])
  })

  it('publishes the audio with the version; the transcript only when the publisher chose to show it', async () => {
    const h = harness()
    current = h.deps
    const id = await narratedVersion(h)
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/2/publish`, { as: h.member }),
    )
    const base = `https://video.example.com/v/${pub.slug}`
    expect(pub.showTranscript).toBe(false)
    expect(pub.urls).toMatchObject({ narration: `${base}.mp3` })
    expect(pub.urls.transcript).toBeUndefined()
    const mirror = JSON.parse(h.deps.blobs.text('internal', pubKey(pub.slug)) ?? '{}')
    expect(mirror.keys).toMatchObject({
      narration: `${id}/v2/narration.mp3`,
      transcript: `${id}/v2/transcript.txt`,
    })
    expect(mirror.showTranscript).toBe(false)
    expect((await edge('public', `/v/${pub.slug}.mp3`)).status).toBe(200)
    expect((await edge('public', `/v/${pub.slug}.txt`)).status).toBe(404)
    expect(await (await edge('public', `/v/${pub.slug}`)).text()).not.toContain('data-transcript')

    // Publishing again changes only the choice, on the same link.
    const again = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/2/publish`, {
        as: h.member,
        body: { showTranscript: true },
      }),
    )
    expect(again.slug).toBe(pub.slug)
    expect(again.urls.transcript).toBe(`${base}.txt`)
    expect((await h.deps.store.getPublication(pub.slug))?.showTranscript).toBe(true)
    const page = await (await edge('public', `/v/${pub.slug}`)).text()
    expect(page).toContain('<details data-transcript><summary>Transcript</summary>')
    expect(page).toContain('<p>Welcome to webhooks.</p><p>Deliveries retry for a day &#60;and&#62; more.</p>')
    const txt = await edge('public', `/v/${pub.slug}.txt`)
    expect(txt.status).toBe(200)
    expect(await txt.text()).toBe(TRANSCRIPT)

    // A version without narration has neither, whatever the choice.
    const v1 = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, {
        as: h.member,
        body: { showTranscript: true },
      }),
    )
    expect(v1.urls.narration).toBeUndefined()
    expect(v1.urls.transcript).toBeUndefined()
    expect((await edge('public', `/v/${v1.slug}.mp3`)).status).toBe(404)
    expect(await (await edge('public', `/v/${v1.slug}`)).text()).not.toContain('data-transcript')
  })
})
