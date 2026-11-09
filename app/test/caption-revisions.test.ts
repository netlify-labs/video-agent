// Caption revisions without a render (plan 2026-11-02 §2.6, §6.6, bead va-2qq.3.14): text-only corrections with
// compare-and-swap on the revision, new immutable files behind revision-aware signed paths, the render's files and
// hashes untouched, the video's ETag bumped, and the publication mirror following by generation (never older, never
// after unpublishing) with a durable retry. A new version with the same narration op carries the corrections.
import { describe, expect, it, vi } from 'vitest'
import { carriedCaptions, cleanCueText, narrationOpHash } from '../server/domain/captions.js'
import { runCleanup } from '../server/domain/cleanup.js'
import { pubKey } from '../server/domain/videos.js'
import { sha256Hex } from '../server/lib/crypto.js'
import { parseVtt, writeVtt, type VttCue } from '../server/lib/vtt.js'
import type { Store } from '../server/store/types.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { contractSource, harness, person, pgStore, stubNetlify, type Harness } from './helpers.js'
import { BUS, draftNarration, narratedDraft, narrationOp, render, report } from './narration-render.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]

/** The render's captions: two narration cues and an on-screen one. */
const CUES: VttCue[] = [
  { id: 'nc_aaaaaaaaaaaa', start: 1, end: 2.5, text: 'Welcome to web hooks.' },
  { id: '2', start: 3, end: 4, text: 'Org settings' },
  { id: 'nc_bbbbbbbbbbbb', start: 4.25, end: 6, text: 'Deliveries retry\nfor a day.' },
]
const RENDER_VTT = writeVtt(CUES)

const edge = async (name: 'files' | 'public', url: string) =>
  (await loadEdge(name))(new Request(new URL(url, 'https://video.example.com')), {
    deploy: { published: true },
  })

/** Renders the draft as the next version, with the render's captions; returns that version's n. */
async function renderNarrated(h: Harness, id: string, editId: string) {
  // Editable, so a later draft can start from it.
  h.deps.nextSource = contractSource()
  h.deps.nextBus = BUS
  h.deps.nextExtra = {
    files: {
      'captions.vtt': new TextEncoder().encode(RENDER_VTT),
      'transcript.txt': new TextEncoder().encode('Welcome to web hooks.\n\nDeliveries retry for a day.\n'),
    },
    manifest: { narration: report() },
  }
  expect((await render(h, editId)).status).toBe(202)
  await h.drive(4)
  const v = (await h.deps.store.listVersions(id))[0]!
  expect(v.status).toBe('ready')
  return v.n
}

async function narratedVersion(h: Harness) {
  const d = await narratedDraft(h, 2)
  const n = await renderNarrated(h, d.id, d.editId)
  return { ...d, n }
}

const revise = (h: Harness, id: string, n: number, body: unknown, as = h.member) =>
  h.call('POST', `/api/v1/videos/${id}/versions/${n}/captions`, { as, body })
const fix = (cues: VttCue[], i: number, text: string) => cues.map((c, j) => (j === i ? { ...c, text } : c))
const code = async (res: Response) => ({
  status: res.status,
  code: ((await res.json()) as { error?: { code: string } }).error?.code,
})
const mirrorOf = (h: Harness, slug: string) =>
  JSON.parse(h.deps.blobs.text('internal', pubKey(slug)) ?? 'null') as {
    keys: { captions: string; transcript?: string }
    captionsGeneration?: number
  } | null

describe('caption text', () => {
  it('drops control characters and the timing arrow, trims lines and keeps at most three', () => {
    expect(cleanCueText('  Hello\u0007  world --> now ')).toBe('Hello world → now')
    expect(cleanCueText('a\nb\nc\nd')).toBe('a\nb\nc d')
    expect(cleanCueText(' \n ')).toBeNull()
  })

  it('round-trips through WebVTT with ids, escaping markup', () => {
    const cues = fix(CUES, 0, 'Tom & <b>Jerry</b>')
    const vtt = writeVtt(cues)
    expect(vtt).toContain(
      'nc_aaaaaaaaaaaa\n00:00:01.000 --> 00:00:02.500\nTom &amp; &lt;b&gt;Jerry&lt;/b&gt;\n',
    )
    expect(parseVtt(vtt)).toEqual(cues)
    expect(parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo id\n')).toEqual([
      { id: '1', start: 1, end: 2, text: 'No id' },
    ])
  })
})

describe('caption revisions', () => {
  stubNetlify(() => {
    current = null
  })

  it.each(stores)(
    'a correction writes new files behind new signed paths, leaves the render as it was and moves the ETag (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      current = h.deps
      const { id, n } = await narratedVersion(h)
      const out0 = (await h.deps.store.getOutput(id, n))!
      const etag0 = (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).etag
      const res = await revise(h, id, n, {
        expectedRev: 0,
        cues: fix(CUES, 0, 'Welcome to webhooks & more.'),
      })
      expect(res.status).toBe(200)
      expect(await h.json(res)).toEqual({ status: 'ok', policy: 'sidecar', rev: 1 })

      const vtt = h.deps.blobs.text('videos', `${id}/v${n}/captions.r1.vtt`) ?? ''
      expect(parseVtt(vtt).map((c) => c.text)).toEqual([
        'Welcome to webhooks & more.',
        'Org settings',
        'Deliveries retry\nfor a day.',
      ])
      const transcript = h.deps.blobs.text('videos', `${id}/v${n}/transcript.r1.txt`)
      expect(transcript).toBe('Welcome to webhooks & more.\n\nDeliveries retry for a day.\n')
      expect((await h.deps.store.getVersion(id, n))?.captions).toMatchObject({
        rev: 1,
        generation: 1,
        files: { vtt: 'captions.r1.vtt', transcript: 'transcript.r1.txt' },
        sha256: { vtt: sha256Hex(vtt), transcript: sha256Hex(transcript ?? '') },
      })
      // The render's own files and hashes stay as they were.
      expect(h.deps.blobs.text('videos', `${id}/v${n}/captions.vtt`)).toBe(RENDER_VTT)
      expect((await h.deps.store.getOutput(id, n))?.sha256).toEqual(out0.sha256)

      const dto = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
      expect(dto.etag).not.toBe(etag0)
      expect(dto.versions[0].captions).toEqual({ status: 'ok', policy: 'sidecar', rev: 1 })
      for (const [file, name] of [
        ['captions', 'captions.r1.vtt'],
        ['transcript', 'transcript.r1.txt'],
      ] as const) {
        const location =
          (await h.call('GET', `/api/v1/videos/${id}/versions/${n}/${file}`, { as: h.member })).headers.get(
            'location',
          ) ?? ''
        expect(location).toMatch(new RegExp(`^/files/${id}/v${n}/${name.replace(/\./g, '\\.')}\\?exp=`))
        const served = await edge('files', location)
        expect(served.status).toBe(200)
        expect(served.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/)
        expect(await served.text()).toBe(h.deps.blobs.text('videos', `${id}/v${n}/${name}`))
      }
      // A signature for one revision doesn't open another.
      const r1 =
        (await h.call('GET', `/api/v1/videos/${id}/versions/${n}/captions`, { as: h.member })).headers.get(
          'location',
        ) ?? ''
      expect((await edge('files', r1.replace('captions.r1.vtt', 'captions.r2.vtt'))).status).toBe(403)
    },
    60_000,
  )

  it.each(stores)('compare-and-swap: a stale or concurrent correction is a 409 (%s)', async (_name, make) => {
    const store = await make()
    const h = harness({}, store ? { store } : {})
    const { id, n } = await narratedVersion(h)
    const [a, b] = await Promise.all([
      revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'First fix.') }),
      revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'Second fix.') }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const stale = await revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'Late.') })
    expect(await code(stale)).toEqual({ status: 409, code: 'conflict' })
    const v = (await h.deps.store.getVersion(id, n))!
    expect(v.captions?.rev).toBe(1)
    // The winner's file is the one the version points to.
    const won = parseVtt(h.deps.blobs.text('videos', `${id}/v${n}/${v.captions!.files.vtt}`) ?? '')[0]?.text
    expect(['First fix.', 'Second fix.']).toContain(won)
    // The next correction builds on rev 1.
    expect((await revise(h, id, n, { expectedRev: 1, cues: fix(CUES, 0, 'Third.') })).status).toBe(200)
  })

  it('changes text only, and only where the policy and the caller allow it', async () => {
    const h = harness()
    const { id, n } = await narratedVersion(h)
    const bad = async (cues: unknown) => code(await revise(h, id, n, { expectedRev: 0, cues }))
    expect(await bad(CUES.map((c, i) => (i === 1 ? { ...c, start: 3.1 } : c)))).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    expect(await bad(CUES.map((c, i) => (i === 1 ? { ...c, id: 'nc_other' } : c)))).toMatchObject({
      status: 400,
    })
    expect(await bad(CUES.slice(1))).toMatchObject({ status: 400 })
    expect(await bad(fix(CUES, 2, '   '))).toMatchObject({ status: 400 })
    // A version whose captions came from its render alone (no narration) can't be corrected here.
    expect(await code(await revise(h, id, 1, { expectedRev: 0, cues: [] }))).toEqual({
      status: 409,
      code: 'conflict',
    })
    // Other Creators and reviewers can't; the admin can.
    const other = await person(h, 'u_other', 'creator')
    expect((await revise(h, id, n, { expectedRev: 0, cues: CUES }, other)).status).toBe(403)
    expect(
      (await revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'By the admin.') }, h.admin)).status,
    ).toBe(200)
    // Burned-in captions go through a render.
    const v = (await h.deps.store.getVersion(id, n))!
    await h.deps.store.updateVersion(id, n, { captions: { ...v.captions!, policy: 'burned' } })
    expect(await code(await revise(h, id, n, { expectedRev: 1, cues: CUES }))).toEqual({
      status: 409,
      code: 'conflict',
    })
    expect((await h.deps.store.getVersion(id, n))?.captions?.rev).toBe(1)
  })

  it('a published version: the mirror and the public VTT follow, by generation', async () => {
    const h = harness()
    current = h.deps
    const { id, n } = await narratedVersion(h)
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/${n}/publish`, {
        as: h.member,
        body: { showTranscript: true },
      }),
    )
    expect(mirrorOf(h, pub.slug)).toMatchObject({
      keys: { captions: `${id}/v${n}/captions.vtt` },
      captionsGeneration: 0,
    })
    expect((await revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'Public fix.') })).status).toBe(200)
    expect(mirrorOf(h, pub.slug)).toMatchObject({
      keys: { captions: `${id}/v${n}/captions.r1.vtt`, transcript: `${id}/v${n}/transcript.r1.txt` },
      captionsGeneration: 1,
    })
    expect(await (await edge('public', `/v/${pub.slug}.vtt`)).text()).toContain('Public fix.')
    expect(await (await edge('public', `/v/${pub.slug}.txt`)).text()).toContain('Public fix.')

    // A late sync of generation 1, after generation 2 is in the mirror, changes nothing.
    expect((await revise(h, id, n, { expectedRev: 1, cues: fix(CUES, 0, 'Newer fix.') })).status).toBe(200)
    await h.deps.store.insertCleanup({
      id: 'late',
      kind: 'sync_captions',
      store: 'internal',
      prefix: `${pubKey(pub.slug)}#g1`,
      nextActionAt: h.deps.clock.now().toISOString(),
      doneAt: null,
    })
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(mirrorOf(h, pub.slug)).toMatchObject({
      keys: { captions: `${id}/v${n}/captions.r2.vtt` },
      captionsGeneration: 2,
    })
    // Publishing again keeps the current revision.
    await h.call('POST', `/api/v1/videos/${id}/versions/${n}/publish`, {
      as: h.member,
      body: { showTranscript: false },
    })
    expect(mirrorOf(h, pub.slug)).toMatchObject({
      keys: { captions: `${id}/v${n}/captions.r2.vtt` },
      captionsGeneration: 2,
    })
  })

  it('a failed mirror write is retried by the sweep; unpublishing first makes it a no-op', async () => {
    const h = harness()
    current = h.deps
    const { id, n } = await narratedVersion(h)
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/versions/${n}/publish`, { as: h.member }),
    )
    const set = h.deps.blobs.set.bind(h.deps.blobs)
    let failing = true
    h.deps.blobs.set = async (store, key, data, meta) => {
      if (failing && store === 'internal' && key === pubKey(pub.slug)) throw new Error('blobs down')
      return set(store, key, data, meta)
    }
    expect((await revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'Retried fix.') })).status).toBe(200)
    expect(mirrorOf(h, pub.slug)?.captionsGeneration).toBe(0)
    // Not due yet, then due: the sweep applies it.
    failing = false
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(mirrorOf(h, pub.slug)?.captionsGeneration).toBe(0)
    h.deps.clock.advance(61_000)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(mirrorOf(h, pub.slug)).toMatchObject({
      keys: { captions: `${id}/v${n}/captions.r1.vtt` },
      captionsGeneration: 1,
    })

    // Again failing, then unpublished before the retry: the retry never brings the mirror back.
    failing = true
    expect((await revise(h, id, n, { expectedRev: 1, cues: fix(CUES, 0, 'Racing fix.') })).status).toBe(200)
    expect(
      (await h.call('DELETE', `/api/v1/videos/${id}/versions/${n}/publish`, { as: h.member })).status,
    ).toBe(204)
    failing = false
    h.deps.clock.advance(61_000)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(mirrorOf(h, pub.slug)).toBeNull()
    expect((await edge('public', `/v/${pub.slug}.vtt`)).status).toBe(404)
    // A correction after unpublishing queues nothing and writes no mirror.
    expect((await revise(h, id, n, { expectedRev: 2, cues: fix(CUES, 0, 'After.') })).status).toBe(200)
    expect(mirrorOf(h, pub.slug)).toBeNull()
    const logs = h.deps.logs.map((l) => JSON.parse(l) as { event: string; outcome?: string })
    expect(logs.filter((l) => l.event === 'captions.mirror_sync').map((l) => l.outcome)).toEqual([
      'applied',
      'unpublished',
    ])
  })

  it.each(stores)(
    'a new version with the same narration op carries the corrections; a changed op is transcribed again (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const { id, n, op } = await narratedVersion(h)
      expect((await revise(h, id, n, { expectedRev: 0, cues: fix(CUES, 0, 'Carried fix.') })).status).toBe(
        200,
      )
      const from = (await h.deps.store.getVersion(id, n))!
      expect(from.narration?.opHash).toBe(narrationOpHash(from.frozen!.narration!.op))

      const same = await renderNarrated(h, id, await draftNarration(h, id, n, op))
      const carried = (await h.deps.store.getVersion(id, same))!
      expect(carried.narration?.opHash).toBe(from.narration?.opHash)
      expect(carried.captions).toMatchObject({
        rev: 1,
        generation: 1,
        files: { vtt: 'captions.r1.vtt', transcript: 'transcript.r1.txt' },
        carriedFrom: { n, rev: 1 },
      })
      expect(h.deps.blobs.text('videos', `${id}/v${same}/captions.r1.vtt`)).toContain('Carried fix.')

      const takes = op.clips.map((c) => c.mediaId)
      const moved = await renderNarrated(h, id, await draftNarration(h, id, same, narrationOp(takes, 2)))
      const fresh = (await h.deps.store.getVersion(id, moved))!
      expect(fresh.narration?.opHash).not.toBe(from.narration?.opHash)
      expect(fresh.captions).toMatchObject({ rev: 0, files: { vtt: 'captions.vtt' } })
      expect(fresh.captions?.carriedFrom).toBeUndefined()
    },
    90_000,
  )

  it('carries nothing without a correction or across caption policies', async () => {
    const h = harness()
    const captions = {
      status: 'ok' as const,
      policy: 'sidecar' as const,
      rev: 0,
      files: { vtt: 'captions.vtt', transcript: null },
      sha256: { vtt: 'a'.repeat(64), transcript: null },
      generation: 0,
    }
    const base = {
      n: 2,
      narration: {
        op: {},
        recipe: { pipeline: 1, ffmpegVersion: '', settings: {} },
        bus: { key: 'k', sha256: 's', samples: 1 },
        opHash: 'h',
      },
      captions,
    }
    expect(await carriedCaptions(h.deps, 'vid_1', 3, base, { opHash: 'h', captions })).toBeNull()
    const revised = {
      ...base,
      captions: { ...captions, rev: 2, files: { vtt: 'captions.r2.vtt', transcript: null } },
    }
    expect(
      await carriedCaptions(h.deps, 'vid_1', 3, revised, {
        opHash: 'h',
        captions: { ...captions, policy: 'burned' },
      }),
    ).toBeNull()
    expect(await carriedCaptions(h.deps, 'vid_1', 3, revised, { opHash: 'other', captions })).toBeNull()
  })
})
