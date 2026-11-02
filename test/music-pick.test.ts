// Music picked before a run (src/domain/music-pick.ts): a version that asks for music with no track, inherited track or
// brand music waits in finding_music while background Openverse jobs search and import a track, which joins the
// version's media like a picked one. Failures and a slow Openverse never block the run: it starts without music.
// Openverse is a fake fetch; the AI Gateway is the scripted fake.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contextMeta } from '../src/generated/context.js'
import { runManifestKey } from '../src/lib/run-manifest.js'
import { chooseTrack, heuristicQuery, MUSIC_PICK_BUDGET_MS } from '../src/domain/music-pick.js'
import { openverseTiming } from '../src/domain/openverse.js'
import { runOpenverseJob } from '../src/domain/openverse-jobs.js'
import { wakeMusicPick } from '../src/domain/reconciler.js'
import type { OpenverseTrack } from '../src/lib/openverse-rules.js'
import type { AttemptRow } from '../src/domain/types.js'
import type { TestDeps } from './fakes.js'
import { harness, pgStore, PROMPT, upload, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const MP3 = new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const FILE_HOST = 'https://files.example-audio.org'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const item = (n: number, o: { license?: string; seconds?: number; title?: string } = {}) => ({
  id: id(n),
  title: o.title ?? `Track ${n}`,
  foreign_landing_url: `https://www.jamendo.com/track/${n}`,
  url: `${FILE_HOST}/t${n}.mp3`,
  creator: `Artist ${n}`,
  creator_url: `https://www.jamendo.com/artist/${n}`,
  license: o.license ?? 'by',
  license_version: o.license === 'cc0' ? '1.0' : '4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'jamendo',
  category: 'music',
  genres: ['electronic'],
  filesize: MP3.byteLength,
  filetype: 'mp3',
  mature: false,
  duration: (o.seconds ?? 95) * 1000,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A fake Openverse: searches answer with `items` (or `searchStatus`, or per query `byQuery`), item lookups by id; files
 * always download.
 */
function openverse(h: Harness, items = [item(1), item(2, { license: 'cc0' })]) {
  const state = {
    items,
    searchStatus: 200,
    byQuery: {} as Record<string, number | ReturnType<typeof item>[]>,
    all: [] as ReturnType<typeof item>[],
  }
  h.deps.outbound.handler = (u) => {
    if (u.origin === FILE_HOST)
      return new Response(MP3, { headers: { 'content-length': String(MP3.byteLength) } })
    if (u.pathname === '/v1/audio/') {
      const answer = state.byQuery[u.searchParams.get('q') ?? ''] ?? state.searchStatus
      if (typeof answer === 'number' && answer !== 200) return json({ detail: 'no' }, answer)
      const results = Array.isArray(answer) ? answer : state.items
      return json({ result_count: results.length, page_count: 1, results })
    }
    const one = /^\/v1\/audio\/([0-9a-f-]+)\/$/.exec(u.pathname)
    const it = [
      ...state.items,
      ...state.all,
      ...Object.values(state.byQuery).flatMap((x) => (Array.isArray(x) ? x : [])),
    ].find((x) => x.id === one?.[1])
    return it ? json(it) : json({ detail: 'Not found.' }, 404)
  }
  return state
}

const searches = (h: Harness) =>
  h.deps.outbound.calls.filter((c) => c.url.includes('/v1/audio/?')).map((c) => new URL(c.url).searchParams)
const create = async (h: Harness, body: Record<string, unknown> = {}) =>
  (
    await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: PROMPT, sound: 'music', ...body },
      }),
    )
  ).id
const attempt = async (h: Harness, vid: string, n = 1) =>
  (await h.attempts(vid)).find((a) => a.versionN === n) as AttemptRow
const tick = (h: Harness) => h.drive(1)
const gatewayReply = (h: Harness, body: unknown) => h.deps.gateway.replies.push(JSON.stringify(body))

beforeEach(() => {
  vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  openverseTiming.sleep = async () => undefined
})
afterEach(() => {
  vi.unstubAllGlobals()
  contextMeta.music = null
  current = null
})

describe('a version that needs music', () => {
  it('picks, imports and snapshots a track, then starts the run with it in the manifest and prompt', async () => {
    const h = harness()
    current = h.deps
    openverse(h, [item(1, { seconds: 12 }), item(2, { license: 'cc0' }), item(3)])
    gatewayReply(h, { query: 'Calm ambient piano!', fallback: 'ambient' })
    const vid = await create(h, { durationSec: 30 })
    await tick(h)

    // The fast model chose the words; Openverse was searched for CC0 and CC BY music with them.
    const call = h.deps.gateway.calls.find((c) => c.kind === 'messages')
    expect(call?.model).toBe('claude-haiku-4-5')
    expect(call?.user).toContain('<data name="request">')
    expect(searches(h).map((p) => [p.get('q'), p.get('license'), p.get('category')])).toEqual([
      ['calm ambient piano', 'cc0,by', 'music'],
    ])
    const calls = await h.deps.store.listGatewayCalls({ since: '2000-01-01' })
    expect(calls.map((c) => [c.kind, c.callerId, c.ok])).toEqual([['music_query', 'u_member', true]])

    // Long enough and CC0 wins; the author owns the library item, which carries its provenance.
    const a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({
      status: 'picked',
      query: 'calm ambient piano',
      querySource: 'gateway',
      openverseId: id(2),
      title: 'Track 2',
    })
    const mediaId = a.musicPick?.mediaId ?? ''
    const m = await h.deps.store.getMedia(mediaId)
    expect(m).toMatchObject({ uploaderId: 'u_member', kind: 'audio', source: 'openverse', sourceId: id(2) })
    const media = await h.deps.store.listVersionMedia(vid, 1)
    expect(media.map((r) => [r.mediaId, r.kind, r.position])).toEqual([[mediaId, 'audio', 0]])

    // The run started with the track: in its manifest (prepare-run hydrates it) and named in its prompt.
    expect(a.stage).not.toBe('finding_music')
    const start = h.deps.runner.starts.find((s) => s.requestId === a.id)
    expect(start?.prompt).toContain(`assets/media/${mediaId}.mp3`)
    expect(start?.prompt).not.toContain('scripts/openverse.ts search')
    const manifest = JSON.parse(
      new TextDecoder().decode((await h.deps.blobs.get('sources', runManifestKey(vid, a.id))) ?? undefined),
    ) as { media: { key: string }[] }
    expect(manifest.media.map((x) => x.key)).toEqual([m?.cleanKey])

    // The video shows the picked track on the version.
    const dto = await h.json<{ versions: { music: Record<string, unknown> }[] }>(
      await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
    )
    expect(dto.versions[0]?.music).toEqual({
      status: 'picked',
      query: 'calm ambient piano',
      title: 'Track 2',
      mediaId,
      reason: null,
      source: 'openverse',
      tried: [{ query: 'calm ambient piano', outcome: 'chosen' }],
    })
  })

  it('credits a CC BY pick on the version automatically', async () => {
    const h = harness()
    current = h.deps
    openverse(h, [item(7)])
    h.deps.gateway.isAvailable = false
    const vid = await create(h)
    await h.drive(4)
    const v = await h.json<{ versions: { status: string; credits: { mediaId: string; text: string }[] }[] }>(
      await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
    )
    const mediaId = (await attempt(h, vid)).musicPick?.mediaId
    expect(v.versions[0]?.status).toBe('ready')
    expect(v.versions[0]?.credits).toEqual([
      expect.objectContaining({
        mediaId,
        text: '"Track 7" by Artist 7, CC BY 4.0, https://www.jamendo.com/track/7',
      }),
    ])
  })

  it('reuses a track already in the library instead of importing it again', async () => {
    const h = harness()
    current = h.deps
    openverse(h, [item(1)])
    h.deps.gateway.isAvailable = false
    const first = await create(h)
    await tick(h)
    const second = await create(h)
    await tick(h)
    const [a, b] = [await attempt(h, first), await attempt(h, second)]
    expect(b.musicPick?.status).toBe('picked')
    expect(b.musicPick?.mediaId).toBe(a.musicPick?.mediaId)
    expect(b.musicPick?.importJobId).toBeNull()
  })

  it('a revision inherits the picked track and picks nothing new', async () => {
    const h = harness()
    current = h.deps
    openverse(h)
    h.deps.gateway.isAvailable = false
    const vid = await create(h)
    await h.drive(4)
    const picked = (await attempt(h, vid)).musicPick?.mediaId
    const before = searches(h).length
    await h.call('POST', `/api/v1/videos/${vid}/versions`, { as: h.member, body: { prompt: 'Warmer.' } })
    await h.drive(1)
    const a2 = await attempt(h, vid, 2)
    expect(a2.musicPick ?? null).toBeNull()
    expect(searches(h)).toHaveLength(before)
    expect((await h.deps.store.listVersionMedia(vid, 2)).map((m) => m.mediaId)).toEqual([picked])
    expect(h.deps.runner.starts.find((s) => s.requestId === a2.id)?.prompt).toContain(
      `assets/media/${picked}`,
    )
  })
})

describe('no pick needed', () => {
  it('skips a version with an audio track, one with brand music, and a silent one', async () => {
    const h = harness()
    current = h.deps
    openverse(h)
    const track = await h.json<{ id: string }>(await upload(h, h.member, MP3, 'filename=theme.mp3'))
    const withTrack = await create(h, { mediaIds: [track.id] })
    const silent = await create(h, { sound: 'silent' })
    contextMeta.music = { file: 'context/brand/music.mp3', genre: 'lofi', tempo: 'slow' }
    const brand = await create(h, { sound: 'music_sfx' })
    await tick(h)
    for (const vid of [withTrack, silent, brand]) {
      const a = await attempt(h, vid)
      expect(a.musicPick ?? null).toBeNull()
      expect(a.stage).toBe('running')
    }
    expect(h.deps.outbound.calls).toHaveLength(0)
    expect(h.deps.gateway.calls).toHaveLength(0)
    const brandPrompt = h.deps.runner.starts.find((s) => s.prompt.includes(brand))?.prompt
    expect(brandPrompt).toContain("use the brand's music, context/brand/music.mp3")
  })
})

describe('the search words', () => {
  it('come from the request when the AI Gateway is off or answers badly', async () => {
    expect(heuristicQuery('A calm, relaxing tour of the dashboard')).toEqual({
      query: 'calm ambient',
      fallbackQuery: 'upbeat electronic',
    })
    expect(heuristicQuery('Cinematic launch trailer for our corporate customers')).toEqual({
      query: 'cinematic epic',
      fallbackQuery: 'corporate background',
    })
    expect(heuristicQuery('Show the settings page')).toEqual({
      query: 'upbeat electronic',
      fallbackQuery: 'background instrumental',
    })

    const h = harness()
    current = h.deps
    openverse(h)
    h.deps.gateway.isAvailable = false
    const off = await create(h, { prompt: 'A playful walkthrough of the new editor.' })
    await tick(h)
    expect((await attempt(h, off)).musicPick).toMatchObject({
      query: 'playful quirky',
      querySource: 'heuristic',
    })

    h.deps.gateway.isAvailable = true
    h.deps.gateway.replies.push('Sure! Here is a query: upbeat')
    const bad = await create(h, { prompt: 'A calm product tour.' })
    await tick(h)
    expect((await attempt(h, bad)).musicPick).toMatchObject({
      query: 'calm ambient',
      querySource: 'heuristic',
    })
    expect(h.deps.gateway.calls.filter((c) => c.kind === 'messages')).toHaveLength(1)
  })

  it('chooses CC0 among long enough tracks, else the longest, and avoids vocals when it can', () => {
    const t = (n: number, o: Parameters<typeof item>[1] = {}) => {
      const raw = item(n, o)
      return {
        id: raw.id,
        title: raw.title,
        durationSec: raw.duration / 1000,
        license: raw.license,
        genres: raw.genres,
        importable: true,
      } as OpenverseTrack
    }
    expect(chooseTrack([t(1), t(2, { license: 'cc0' })], 30)?.id).toBe(id(2))
    expect(chooseTrack([t(1, { seconds: 10 }), t(2, { license: 'cc0', seconds: 20 })], 30)?.id).toBe(id(2))
    expect(chooseTrack([t(1, { seconds: 10 }), t(2, { seconds: 40 })], 30)?.id).toBe(id(2))
    expect(chooseTrack([t(1, { title: 'Song with vocals' }), t(2)], 30)?.id).toBe(id(2))
    expect(chooseTrack([t(1, { title: 'Vocals only' })], 30)?.id).toBe(id(1))
    expect(chooseTrack([{ ...t(1), importable: false }], 30)).toBeNull()
  })
})

describe('when the pick fails', () => {
  it('three failed searches in a row with no audio in the library start the run without music', async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h)
    ov.searchStatus = 400
    h.deps.gateway.isAvailable = false
    const vid = await create(h)
    await tick(h)
    // Openverse counts as down after three failures in a row; the library has nothing either.
    expect(searches(h).map((p) => p.get('q'))).toEqual([
      'upbeat electronic',
      'background instrumental',
      'corporate',
    ])
    const a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({
      status: 'skipped',
      usedFallback: true,
      reason: "Openverse isn't answering. The library has no audio to use instead.",
    })
    expect(a.stage).toBe('running')
    expect(await h.deps.store.listVersionMedia(vid, 1)).toEqual([])
    // The run's own Openverse helper is the backup.
    expect(h.deps.runner.starts.find((s) => s.requestId === a.id)?.prompt).toContain(
      'npx tsx scripts/openverse.ts search',
    )
  })

  it('starts the run without music once the budget runs out, and shows Finding music until then', async () => {
    const h = harness()
    current = h.deps
    openverse(h)
    h.deps.gateway.isAvailable = false
    h.deps.platform.onOpenverseJob = null // The background jobs never run.
    const vid = await create(h)
    await h.drive(3)
    let a = await attempt(h, vid)
    expect(a.stage).toBe('finding_music')
    expect(h.deps.runner.starts).toHaveLength(0)
    const progress = await h.json<{ stage: string; music: { status: string; query: string } }>(
      await h.call('GET', `/api/v1/videos/${vid}/progress`, { as: h.member }),
    )
    expect(progress).toMatchObject({
      stage: 'finding_music',
      music: { status: 'searching', query: 'upbeat electronic' },
    })
    const v = await h.json<{ status: string; versions: { status: string; stage: string }[] }>(
      await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
    )
    expect([v.status, v.versions[0]?.status, v.versions[0]?.stage]).toEqual([
      'running',
      'running',
      'finding_music',
    ])
    await h.drive(Math.ceil(MUSIC_PICK_BUDGET_MS / 61_000))
    a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({
      status: 'skipped',
      reason: 'Openverse found no track in time. The library has no audio to use instead.',
    })
    expect(h.deps.runner.starts.map((s) => s.requestId)).toEqual([a.id])
  })

  it('can be cancelled while finding music', async () => {
    const h = harness()
    current = h.deps
    openverse(h)
    h.deps.gateway.isAvailable = false
    h.deps.platform.onOpenverseJob = null
    const vid = await create(h)
    await tick(h)
    expect((await attempt(h, vid)).stage).toBe('finding_music')
    expect((await h.call('POST', `/api/v1/videos/${vid}/versions/1/cancel`, { as: h.member })).status).toBe(
      202,
    )
    const a = await attempt(h, vid)
    expect(a.stage).toBe('cancelled')
    // The search finishing later wakes nothing, and no run ever starts.
    const searchJob = a.musicPick?.searchJobId ?? ''
    await runOpenverseJob(h.deps, searchJob)
    await wakeMusicPick(h.deps, searchJob)
    await h.drive(8)
    expect(h.deps.runner.starts).toHaveLength(0)
    expect(await h.deps.store.listVersionMedia(vid, 1)).toEqual([])
    expect(await h.deps.store.countSlotHolders()).toBe(0)
  })
})

describe('when Openverse is slow or down', () => {
  /** Imports an Openverse track into the library through the API, as the member. */
  const importTrack = async (h: Harness, ov: ReturnType<typeof openverse>, t: ReturnType<typeof item>) => {
    ov.all.push(t)
    const r = await h.call('POST', '/api/v1/media/openverse/import', { as: h.member, body: { id: t.id } })
    expect(r.status).toBe(201)
    return (await h.json<{ id: string }>(r)).id
  }

  it('tries the next words in order (fallback, then broad ones that fit) until one yields a track', async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h)
    h.deps.gateway.isAvailable = false
    ov.byQuery = {
      'upbeat electronic': 504,
      'background instrumental': [],
      corporate: 504,
      ambient: [item(3, { title: 'Soft Focus' })],
    }
    const vid = await create(h)
    await tick(h)
    // Each search is tried once: the next words are the retry, not the same failing query again.
    expect(searches(h).map((p) => p.get('q'))).toEqual([
      'upbeat electronic',
      'background instrumental',
      'corporate',
      'ambient',
    ])
    const a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({
      status: 'picked',
      source: 'openverse',
      query: 'ambient',
      title: 'Soft Focus',
      openverseId: id(3),
      tried: [
        { query: 'upbeat electronic', outcome: 'failed' },
        { query: 'background instrumental', outcome: 'empty' },
        { query: 'corporate', outcome: 'failed' },
        { query: 'ambient', outcome: 'chosen' },
      ],
    })
    expect((await h.deps.store.listVersionMedia(vid, 1)).map((m) => m.mediaId)).toEqual([
      a.musicPick?.mediaId,
    ])
  })

  it('a track that fails to import moves on to the next words', async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h, [])
    h.deps.gateway.isAvailable = false
    ov.byQuery = { 'upbeat electronic': [item(4)], 'background instrumental': [item(5)] }
    // The first track's lookup 404s, so its import fails.
    const handler = h.deps.outbound.handler
    h.deps.outbound.handler = (u, init) =>
      u.pathname === `/v1/audio/${id(4)}/` ? json({}, 404) : handler(u, init)
    const vid = await create(h)
    await tick(h)
    expect((await attempt(h, vid)).musicPick).toMatchObject({
      status: 'picked',
      openverseId: id(5),
      tried: [
        { query: 'upbeat electronic', outcome: 'import_failed' },
        { query: 'background instrumental', outcome: 'chosen' },
      ],
    })
  })

  it("uses the library's best match when every search fails, and credits a CC BY track", async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h, [])
    h.deps.gateway.isAvailable = false
    const match = await importTrack(h, ov, item(21, { title: 'Electronic Launch Party' }))
    h.deps.clock.advance(1000)
    await importTrack(h, ov, item(20, { title: 'Quiet Morning' }))
    h.deps.clock.advance(1000)
    // Newest, and its name matches the mood, but an upload has no licence or credit to go with it.
    await upload(h, h.member, MP3, 'filename=upbeat-electronic.mp3')
    ov.searchStatus = 504
    const vid = await create(h)
    await h.drive(4)
    const a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({
      status: 'picked',
      source: 'library',
      mediaId: match,
      title: 'Electronic Launch Party',
      reason: null,
    })
    expect(searches(h)).toHaveLength(3)
    expect((await h.deps.store.listVersionMedia(vid, 1)).map((m) => m.mediaId)).toEqual([match])
    const v = await h.json<{
      versions: { status: string; music: { source: string }; credits: { mediaId: string; text: string }[] }[]
    }>(await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }))
    expect(v.versions[0]?.status).toBe('ready')
    expect(v.versions[0]?.music.source).toBe('library')
    expect(v.versions[0]?.credits).toEqual([
      expect.objectContaining({
        mediaId: match,
        text: '"Electronic Launch Party" by Artist 21, CC BY 4.0, https://www.jamendo.com/track/21',
      }),
    ])
  })

  it('among equally good imports, picks the most recently used', async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h, [])
    h.deps.gateway.isAvailable = false
    const used = await importTrack(h, ov, item(30, { title: 'Corporate One' }))
    h.deps.clock.advance(1000)
    await importTrack(h, ov, item(31, { title: 'Corporate Two' }))
    // The older one was used in a video since, so it's the more recent.
    const other = await create(h, { mediaIds: [used] })
    await h.drive(4)
    expect((await h.deps.store.listVersionMedia(other, 1)).map((m) => m.mediaId)).toEqual([used])
    ov.searchStatus = 504
    const vid = await create(h)
    await h.drive(1)
    expect((await attempt(h, vid)).musicPick).toMatchObject({ source: 'library', mediaId: used })
  })

  it("never picks audio the author can't see: deleted, unfinished or rejected items", async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h, [])
    h.deps.gateway.isAvailable = false
    const plain = await h.json<{ id: string }>(await upload(h, h.member, MP3, 'filename=theme.mp3'))
    h.deps.clock.advance(1000)
    const deleted = await importTrack(h, ov, item(40, { title: 'Upbeat Electronic Corporate' }))
    expect((await h.call('DELETE', `/api/v1/media/${deleted}`, { as: h.member })).status).toBe(204)
    const row = await h.deps.store.getMedia(plain.id)
    if (!row) throw new Error('no upload')
    for (const [n, status] of [
      [1, 'verifying'],
      [2, 'rejected'],
      [3, 'uploading'],
    ] as const)
      await h.deps.store.insertMedia({
        ...row,
        ...(await h.deps.store.getMedia(deleted)),
        deletedAt: null,
        id: `med_hidden${n}`,
        uploaderId: n === 1 ? 'u_member' : 'u_admin',
        status,
        sourceId: id(90 + n),
        createdAt: h.deps.clock.now().toISOString(),
      })
    ov.searchStatus = 504
    const vid = await create(h)
    await h.drive(1)
    expect((await attempt(h, vid)).musicPick).toMatchObject({ source: 'library', mediaId: plain.id })
  })

  it('goes to the library once the budget is spent, without searching on (Openverse slow, not failing)', async () => {
    const h = harness()
    current = h.deps
    const ov = openverse(h, [])
    h.deps.gateway.isAvailable = false
    const plain = await h.json<{ id: string }>(await upload(h, h.member, MP3, 'filename=theme.mp3'))
    // Every search answers empty after 100 s.
    ov.searchStatus = 200
    const run = h.deps.platform.onOpenverseJob
    h.deps.platform.onOpenverseJob = async (jobId) => {
      await run?.(jobId)
      h.deps.clock.advance(100_000)
    }
    const vid = await create(h)
    const started = h.deps.clock.now().getTime()
    await tick(h)
    const a = await attempt(h, vid)
    // Four searches started within the 5 minutes (at 0, 100, 200 and 300 s); the fifth would start after it.
    expect(searches(h)).toHaveLength(4)
    expect(a.musicPick).toMatchObject({ status: 'picked', source: 'library', mediaId: plain.id })
    expect(a.musicPick?.tried?.map((t) => t.outcome)).toEqual(['empty', 'empty', 'empty', 'empty'])
    expect(Date.parse(a.musicPick?.endedAt ?? '') - started).toBeLessThanOrEqual(
      MUSIC_PICK_BUDGET_MS + 100_000,
    )
    expect(h.deps.runner.starts.map((s) => s.requestId)).toEqual([a.id])
  })
})

describe('background jobs', () => {
  it('a finished search or import wakes the waiting run instead of waiting for the sweep', async () => {
    const h = harness()
    current = h.deps
    openverse(h)
    h.deps.gateway.isAvailable = false
    h.deps.platform.onOpenverseJob = null
    const vid = await create(h)
    await tick(h)
    let a = await attempt(h, vid)
    expect(a.musicPick?.status).toBe('searching')
    const searchJob = a.musicPick?.searchJobId ?? ''
    expect(await runOpenverseJob(h.deps, searchJob)).toBe('done')
    await wakeMusicPick(h.deps, searchJob)
    a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({ status: 'importing', openverseId: id(2) })
    const importJob = a.musicPick?.importJobId ?? ''
    expect(await runOpenverseJob(h.deps, importJob)).toBe('done')
    await wakeMusicPick(h.deps, importJob)
    a = await attempt(h, vid)
    expect(a.musicPick?.status).toBe('picked')
    expect(a.stage).toBe('running')
    expect(h.deps.runner.starts.map((s) => s.requestId)).toEqual([a.id])
  })
})

describe('music picks in Postgres', () => {
  it('stores the pick on the attempt and the track in the version media', async () => {
    const h = harness({}, { store: await pgStore() })
    current = h.deps
    openverse(h, [item(5)])
    gatewayReply(h, { query: 'warm acoustic guitar', fallback: null })
    const vid = await create(h)
    await h.drive(4)
    const a = await attempt(h, vid)
    expect(a.musicPick).toMatchObject({ status: 'picked', query: 'warm acoustic guitar', openverseId: id(5) })
    expect((await h.deps.store.listVersionMedia(vid, 1)).map((m) => m.mediaId)).toEqual([
      a.musicPick?.mediaId,
    ])
    const v = await h.json<{ versions: { status: string; credits: unknown[] }[] }>(
      await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
    )
    expect(v.versions[0]?.status).toBe('ready')
    expect(v.versions[0]?.credits).toHaveLength(1)
  })
})
