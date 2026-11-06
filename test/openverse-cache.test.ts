// Fast music search: finished Openverse searches are stored for every instance, fresh for a day and served stale (then
// refreshed once in the background) for two weeks; library matches come without asking Openverse; a daily warm-up
// refreshes common and popular searches, spaced out; the sweep drops old searches. Openverse is a fake that can be
// slow (it never answers until the caller gives up) or count every call.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { openverseTiming, resetOpenverseCache, searchRequest } from '../src/domain/openverse.js'
import {
  COMMON_SEARCHES,
  planWarmup,
  queueOpenverseJob,
  runOpenverseJob,
  startWarmup,
  sweepOpenverseJobs,
  SYSTEM_USER_ID,
} from '../src/domain/openverse-jobs.js'
import type { TestDeps } from './fakes.js'
import { apiKey, harness, mcpCall, pgStore, stubNetlify, upload, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const MP3 = new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const FILE_HOST = 'https://files.example-audio.org'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const item = (n: number) => ({
  id: id(n),
  title: `Track ${n}`,
  foreign_landing_url: `https://www.jamendo.com/track/${n}`,
  url: `${FILE_HOST}/t${n}.mp3`,
  creator: `Artist ${n}`,
  license: 'by',
  license_version: '4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'jamendo',
  category: 'music',
  genres: ['ambient'],
  filesize: MP3.byteLength,
  filetype: 'mp3',
  mature: false,
  duration: 95_000,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake Openverse: 'slow' never answers (until the caller gives up), 'ok' answers at once. */
function openverse(h: Harness) {
  const state = { mode: 'ok' as 'ok' | 'slow' }
  h.deps.outbound.handler = (u, init) => {
    if (u.origin === FILE_HOST)
      return new Response(MP3, { headers: { 'content-length': String(MP3.byteLength) } })
    if (state.mode === 'slow')
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    if (u.pathname === '/v1/audio/')
      return json({ result_count: 2, page_count: 1, results: [item(1), item(2)] })
    const one = /^\/v1\/audio\/([0-9a-f-]+)\/$/.exec(u.pathname)
    return one?.[1] ? json(item(Number(one[1].slice(-12)))) : json({ detail: 'Not found.' }, 404)
  }
  return state
}

/** Short timings, and sleeps that move the fake clock instead of waiting (each one is recorded). */
function fastTiming(h: Harness) {
  const slept: number[] = []
  openverseTiming.inlineMs = 40
  openverseTiming.job = { timeoutMs: 80, downloadMs: 500, retries: 0, maxWaitMs: 120_000 }
  openverseTiming.mcpWaitMs = 150
  openverseTiming.pollMs = 20
  openverseTiming.sleep = async (ms) => {
    slept.push(ms)
    h.deps.clock.advance(ms)
  }
  return slept
}

function setup(opts: Parameters<typeof harness>[1] = {}) {
  resetOpenverseCache()
  const h = harness({}, opts)
  current = h.deps
  return { h, ov: openverse(h), slept: fastTiming(h) }
}

/** Another function instance: its own deps and memory, the same database. */
function otherInstance(h: Harness) {
  resetOpenverseCache()
  const other = harness({}, { store: h.deps.store })
  current = other.deps
  other.deps.clock.t = h.deps.clock.t
  return { h: other, ov: openverse(other), slept: fastTiming(other) }
}

interface Search {
  items: { id: string; mediaId: string | null }[]
  fetchedAt: string | null
  stale: boolean
}
const searchCalls = (h: Harness) => h.deps.outbound.calls.filter((c) => c.url.includes('/v1/audio/?')).length
const search = (h: Harness, q: string, as = h.member) =>
  h.call('GET', `/api/v1/media/openverse/search?${q}`, { as })
const keyFor = (q: string) => searchRequest({ q, license: 'cc0,by', category: 'music' }).key

stubNetlify(() => {
  current = null
})

describe.each([
  ['memory', () => setup()],
  ['Postgres', async () => setup({ store: await pgStore() })],
])('Stored searches (%s)', (_name, make) => {
  it('answers a repeat at once on another instance, even when Openverse is slow', async () => {
    const { h } = await make()
    const first = await search(h, 'q=Calm++Piano')
    expect(first.status).toBe(200)
    expect(await h.json<Search>(first)).toMatchObject({
      stale: false,
      fetchedAt: h.deps.clock.now().toISOString(),
    })

    const b = otherInstance(h)
    b.ov.mode = 'slow'
    b.h.deps.clock.advance(3 * HOUR)
    // Openverse would time out (and answer 202 with a job); the stored search answers instead.
    const again = await search(b.h, 'q=calm+piano', b.h.admin)
    expect(again.status).toBe(200)
    const body = await b.h.json<Search>(again)
    expect(body.items.map((t) => t.id)).toEqual([id(1), id(2)])
    expect(body.stale).toBe(false)
    expect(searchCalls(b.h)).toBe(0)
    expect(b.h.deps.platform.openverseJobs).toEqual([])
  })

  it('serves a stale search at once and queues one background refresh', async () => {
    const { h, ov } = await make()
    await search(h, 'q=calm')
    const fetchedAt = h.deps.clock.now().toISOString()
    h.deps.clock.advance(DAY + HOUR)
    resetOpenverseCache()
    fastTiming(h)
    ov.mode = 'slow'
    const stale = await search(h, 'q=calm')
    expect(stale.status).toBe(200)
    expect(await h.json<Search>(stale)).toMatchObject({ stale: true, fetchedAt })
    // Asking again (anyone) doesn't queue another refresh, and none count against a person's rate limit.
    expect((await search(h, 'q=calm', h.admin)).status).toBe(200)
    expect(h.deps.platform.openverseJobs).toHaveLength(1)
    const jobId = h.deps.platform.openverseJobs[0] ?? ''
    const job = await h.deps.store.getOpenverseJob(jobId)
    expect(job).toMatchObject({ userId: SYSTEM_USER_ID, kind: 'search', status: 'queued' })
    expect(await h.deps.store.countOpenverseJobs('u_member', '2000-01-01T00:00:00.000Z')).toBe(0)

    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, jobId)).toBe('done')
    resetOpenverseCache()
    fastTiming(h)
    const fresh = await h.json<Search>(await search(h, 'q=calm'))
    expect(fresh).toMatchObject({ stale: false, fetchedAt: h.deps.clock.now().toISOString() })
    expect(h.deps.platform.openverseJobs).toHaveLength(1)
  })

  it('stops serving a search after two weeks; the sweep deletes it and old use counts', async () => {
    const { h, ov } = await make()
    await search(h, 'q=calm')
    await h.deps.store.putOpenverseSearch({
      key: keyFor('fresh'),
      result: { items: [], page: 1, pageCount: 1, total: 0 },
      fetchedAt: new Date(h.deps.clock.now().getTime() + 10 * DAY).toISOString(),
    })
    h.deps.clock.advance(15 * DAY)
    resetOpenverseCache()
    fastTiming(h)
    ov.mode = 'slow'
    expect((await search(h, 'q=calm')).status).toBe(202)
    await sweepOpenverseJobs(h.deps)
    expect(await h.deps.store.getOpenverseSearch(keyFor('calm'))).toBeNull()
    expect(await h.deps.store.getOpenverseSearch(keyFor('fresh'))).not.toBeNull()
    // The day's count (today's search) stays; the one from fifteen days ago is gone.
    expect(await h.deps.store.topOpenverseSearches('2000-01-01', 10)).toEqual([
      { key: keyFor('calm'), count: 1 },
    ])
    // Over the cap, the most recently fetched are kept.
    for (const [i, q] of ['a1', 'a2', 'a3'].entries())
      await h.deps.store.putOpenverseSearch({
        key: keyFor(q),
        result: { items: [], page: 1, pageCount: 1, total: 0 },
        fetchedAt: new Date(h.deps.clock.now().getTime() + i * HOUR).toISOString(),
      })
    expect(
      await h.deps.store.deleteOldOpenverseSearches({ fetchedBefore: '2000-01-01T00:00:00.000Z', keep: 2 }),
    ).toBe(2)
    expect(await h.deps.store.getOpenverseSearch(keyFor('a3'))).not.toBeNull()
    expect(await h.deps.store.getOpenverseSearch(keyFor('a2'))).not.toBeNull()
    expect(await h.deps.store.getOpenverseSearch(keyFor('a1'))).toBeNull()
    expect(await h.deps.store.getOpenverseSearch(keyFor('fresh'))).toBeNull()
  })

  it('never stores library membership: it is looked up for each request', async () => {
    const { h } = await make()
    const imported = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/media/openverse/import', { as: h.member, body: { id: id(1) } }),
    )
    const found = await h.json<Search>(await search(h, 'q=calm'))
    expect(found.items[0]?.mediaId).toBe(imported.id)
    const row = await h.deps.store.getOpenverseSearch(keyFor('calm'))
    expect(JSON.stringify(row?.result)).not.toContain('mediaId')
    expect(JSON.stringify(row?.result)).not.toContain(imported.id)
    // Deleted from the library: the same stored search no longer says it's there.
    expect((await h.call('DELETE', `/api/v1/media/${imported.id}`, { as: h.member })).status).toBe(204)
    resetOpenverseCache()
    fastTiming(h)
    const after = await h.json<Search>(await search(h, 'q=calm'))
    expect(after.items[0]?.mediaId).toBeNull()
    expect(searchCalls(h)).toBe(1)
  })
})

describe('Library matches', () => {
  it('returns matching library audio, Openverse imports first, without asking Openverse', async () => {
    const { h } = setup()
    await h.call('POST', '/api/v1/media/openverse/import', { as: h.member, body: { id: id(1) } })
    const uploaded = await h.json<{ id: string }>(
      await upload(h, h.member, MP3, 'filename=theme.mp3&caption=Calm%20piano%20by%20an%20artist'),
    )
    await upload(h, h.member, MP3, 'filename=other.mp3&caption=Drums')
    const calls = h.deps.outbound.calls.length
    const res = await h.call('GET', '/api/v1/media/openverse/library?q=artist', { as: h.member })
    expect(res.status).toBe(200)
    const body = await h.json<{ items: { id: string; urls: { file: string } | null; source: unknown }[] }>(
      res,
    )
    expect(body.items).toHaveLength(2)
    expect(body.items[0]?.source).toMatchObject({ name: 'openverse', id: id(1) })
    expect(body.items[0]?.urls?.file).toMatch(/^\/media\/med_\w+\/file\?exp=/)
    expect(body.items[1]?.id).toBe(uploaded.id)
    // Every word matched ranks first; nothing matches nothing.
    const piano = await h.json<{ items: { id: string }[] }>(
      await h.call('GET', '/api/v1/media/openverse/library?q=calm+piano', { as: h.member }),
    )
    expect(piano.items.map((m) => m.id)).toEqual([uploaded.id])
    const none = await h.json<{ items: unknown[] }>(
      await h.call('GET', '/api/v1/media/openverse/library?q=jazz', { as: h.member }),
    )
    expect(none.items).toEqual([])
    expect(h.deps.outbound.calls.length).toBe(calls)
  })

  it('search_music answers a stored search at once and lists library matches in in_library', async () => {
    const { h, ov } = setup()
    const key = await apiKey(h, h.member)
    await upload(h, h.member, MP3, 'filename=calm.mp3&caption=Calm%20piano%20bed')
    await search(h, 'q=calm+piano')
    resetOpenverseCache()
    fastTiming(h)
    ov.mode = 'slow'
    const r = (await mcpCall(h, key, 'tools/call', {
      name: 'search_music',
      arguments: { query: 'calm piano' },
    })) as { structuredContent: Record<string, any> }
    expect(r.structuredContent.status).toBe('done')
    expect(r.structuredContent.tracks).toHaveLength(2)
    expect(r.structuredContent.in_library).toEqual([
      expect.objectContaining({ title: 'Calm piano bed', media_id: expect.stringMatching(/^med_/) }),
    ])
    expect(r.structuredContent.next_actions[0]).toMatch(/In the library already/)
    expect(searchCalls(h)).toBe(1)
  })

  it('common searches are listed for quick picks', async () => {
    const { h } = setup()
    const res = await h.call('GET', '/api/v1/media/openverse/common', { as: h.member })
    expect((await h.json<{ queries: string[] }>(res)).queries).toEqual([...COMMON_SEARCHES])
  })
})

describe('Music picks and stored searches', () => {
  it("a server pick's search answers from a stored search without asking Openverse", async () => {
    const { h, ov } = setup()
    await search(h, 'q=ambient')
    resetOpenverseCache()
    fastTiming(h)
    ov.mode = 'slow'
    const job = await queueOpenverseJob(h.deps, 'u_member', 'search', keyFor('ambient'), { q: 'ambient' })
    expect(job.status).toBe('done')
    expect((job.result as { items: unknown[] }).items).toHaveLength(2)
    expect(h.deps.platform.openverseJobs).toEqual([])
  })
})

describe('Daily warm-up', () => {
  it('queues only missing or stale searches, once, and spaces out its Openverse calls', async () => {
    const { h } = setup()
    const now = h.deps.clock.now().getTime()
    const page = { items: [], page: 1, pageCount: 1, total: 0 }
    // Fresh: skipped. Stale or nearly so: refreshed.
    for (const q of COMMON_SEARCHES.slice(0, 15))
      await h.deps.store.putOpenverseSearch({
        key: keyFor(q),
        result: page,
        fetchedAt: new Date(now - HOUR).toISOString(),
      })
    await h.deps.store.putOpenverseSearch({
      key: keyFor('upbeat'),
      result: page,
      fetchedAt: new Date(now - 23 * HOUR).toISOString(),
    })
    // A popular search people made two days ago: refreshed too; a later page isn't counted.
    for (let i = 0; i < 3; i++) await search(h, 'q=Synthwave+Night')
    await search(h, 'q=calm&page=2')
    await h.deps.store.putOpenverseSearch({
      key: keyFor('synthwave night'),
      result: page,
      fetchedAt: new Date(now - 2 * DAY).toISOString(),
    })
    resetOpenverseCache()
    const slept = fastTiming(h)
    const calls = searchCalls(h)

    const plan = await planWarmup(h.deps)
    expect(plan).toEqual([
      keyFor('upbeat'),
      ...COMMON_SEARCHES.slice(15).map((q) => keyFor(q)),
      keyFor('synthwave night'),
    ])
    const started = await startWarmup(h.deps)
    expect(started.keys).toBe(5)
    expect(h.deps.platform.openverseJobs).toEqual([started.jobId])
    expect((await startWarmup(h.deps)).jobId).toBe(started.jobId)
    expect(h.deps.platform.openverseJobs).toHaveLength(1)

    expect(await runOpenverseJob(h.deps, started.jobId ?? '')).toBe('done')
    expect(searchCalls(h) - calls).toBe(5)
    // Three at a time, but every start at least the gap after the one before.
    expect(slept).toEqual(Array(4).fill(openverseTiming.warmGapMs))
    expect((await h.deps.store.getOpenverseJob(started.jobId ?? ''))?.result).toEqual({
      refreshed: 5,
      skipped: 0,
      failed: 0,
      left: 0,
    })
    // Everything is fresh now: the next run queues nothing.
    expect(await startWarmup(h.deps)).toEqual({ jobId: null, keys: 0 })
  })

  it('stops when Openverse says it is busy', async () => {
    const { h } = setup()
    let n = 0
    h.deps.outbound.handler = () => {
      n++
      return new Response('{}', { status: 429, headers: { 'retry-after': '600' } })
    }
    const started = await startWarmup(h.deps)
    expect(started.keys).toBe(COMMON_SEARCHES.length)
    openverseTiming.warmConcurrency = 1
    await runOpenverseJob(h.deps, started.jobId ?? '')
    expect(n).toBe(1)
    expect((await h.deps.store.getOpenverseJob(started.jobId ?? ''))?.result).toMatchObject({
      refreshed: 0,
      failed: 1,
      left: COMMON_SEARCHES.length - 1,
    })
  })
})
