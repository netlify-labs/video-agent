// Openverse jobs: a slow Openverse never surfaces as a timeout. A request tries briefly and answers inline when it can,
// else 202 with a job that the background step finishes (retrying timeouts and 5xx with backoff, waiting out 429s).
// Polling is owner-only; identical requests share a job; starts are rate-limited per person; the sweep re-dispatches
// lost jobs and deletes expired ones. Openverse is a fake fetch that can hang until the caller gives up.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { openverseTiming, resetOpenverseCache } from '../src/domain/openverse.js'
import { JOBS_PER_MINUTE, runOpenverseJob, sweepOpenverseJobs } from '../src/domain/openverse-jobs.js'
import type { TestDeps } from './fakes.js'
import { apiKey, harness, mcpCall, person, pgStore, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const MP3 = new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const FILE_HOST = 'https://files.example-audio.org'
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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A request that never answers: it fails only when the caller aborts it, like a fetch to a stalled server. */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })

type Answer = 'ok' | 'hang' | 503 | { status: 429; retryAfter: string }

/**
 * A fake Openverse whose next answers are scripted: `queue` is used first, then `mode` for everything else. Search
 * and item lookups share the script; files always download.
 */
function openverse(h: Harness, n = 2) {
  const state = {
    mode: 'ok' as Answer,
    queue: [] as Answer[],
    items: Array.from({ length: n }, (_, i) => item(i + 1)),
  }
  h.deps.outbound.handler = (u, init) => {
    if (u.origin === FILE_HOST)
      return new Response(MP3, { headers: { 'content-length': String(MP3.byteLength) } })
    const answer = state.queue.shift() ?? state.mode
    if (answer === 'hang') return hang(init)
    if (answer === 503) return json({ detail: 'boom' }, 503)
    if (typeof answer === 'object')
      return json({ detail: 'Request was throttled.' }, 429, { 'retry-after': answer.retryAfter })
    if (u.pathname === '/v1/audio/')
      return json({ result_count: state.items.length, page_count: 1, results: state.items })
    const one = /^\/v1\/audio\/([0-9a-f-]+)\/$/.exec(u.pathname)
    const it = state.items.find((x) => x.id === one?.[1])
    return it ? json(it) : json({ detail: 'Not found.' }, 404)
  }
  return state
}

/** Short timings, and sleeps that move the fake clock instead of waiting (each one is recorded). */
function fastTiming(h: Harness) {
  const slept: number[] = []
  openverseTiming.inlineMs = 40
  openverseTiming.job = { timeoutMs: 80, downloadMs: 500, retries: 3, maxWaitMs: 120_000 }
  openverseTiming.mcpWaitMs = 150
  openverseTiming.pollMs = 20
  openverseTiming.sleep = async (ms) => {
    slept.push(ms)
    h.deps.clock.advance(ms)
  }
  return slept
}

function setup(opts: Parameters<typeof harness>[1] = {}) {
  const h = harness({}, opts)
  current = h.deps
  const ov = openverse(h)
  const slept = fastTiming(h)
  return { h, ov, slept }
}

interface Job {
  id: string
  kind: 'search' | 'import'
  status: 'queued' | 'running' | 'done' | 'failed'
  search: { items: { id: string; mediaId: string | null }[]; total: number } | null
  media: { id: string; kind: string; source: { id: string; licenseLabel: string } | null } | null
  created: boolean | null
  error: { code: string; message: string } | null
  expiresAt: string
}

const searchCalls = (h: Harness) => h.deps.outbound.calls.filter((c) => c.url.includes('/v1/audio/?'))
const search = (h: Harness, q: string, as = h.member) =>
  h.call('GET', `/api/v1/media/openverse/search?${q}`, { as })
const importIt = (h: Harness, n: number, as = h.member) =>
  h.call('POST', '/api/v1/media/openverse/import', { as, body: { id: id(n) } })
const getJob = async (h: Harness, jobId: string, as = h.member) =>
  h.call('GET', `/api/v1/media/openverse/jobs/${jobId}`, { as })

beforeEach(() => {
  vi.stubGlobal('Netlify', { env: { get: () => undefined } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  current = null
})

describe('Openverse search jobs', () => {
  it('answers inline when Openverse is quick, and keeps the result for other instances', async () => {
    const { h } = setup()
    const res = await search(h, 'q=calm')
    expect(res.status).toBe(200)
    expect((await h.json<{ items: unknown[] }>(res)).items).toHaveLength(2)
    expect(h.deps.platform.openverseJobs).toEqual([])
    // Another instance (an empty in-memory cache) answers the same search from the stored result.
    resetOpenverseCache()
    fastTiming(h)
    const again = await search(h, 'q=calm', h.admin)
    expect(again.status).toBe(200)
    expect(searchCalls(h)).toHaveLength(1)
  })

  it('hands a slow search to a job, which the background step finishes; polling returns the tracks', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const res = await search(h, 'q=calm+piano')
    expect(res.status).toBe(202)
    const job = await h.json<Job>(res)
    expect(job).toMatchObject({ kind: 'search', status: 'queued', search: null, error: null })
    expect(res.headers.get('location')).toBe(`/api/v1/media/openverse/jobs/${job.id}`)
    expect(h.deps.platform.openverseJobs).toEqual([job.id])
    expect((await h.json<Job>(await getJob(h, job.id))).status).toBe('queued')

    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, job.id)).toBe('done')
    // Running it again (a duplicate dispatch) does nothing.
    expect(await runOpenverseJob(h.deps, job.id)).toBe('skipped')
    const done = await h.json<Job>(await getJob(h, job.id))
    expect(done.status).toBe('done')
    expect(done.search?.items.map((t) => t.id)).toEqual([id(1), id(2)])
    expect(done.search?.items[0]?.mediaId).toBeNull()
    // Recent searches are instant: the finished job answers the same search, without asking Openverse again.
    const calls = searchCalls(h).length
    resetOpenverseCache()
    fastTiming(h)
    const cached = await search(h, 'q=calm+piano', h.admin)
    expect(cached.status).toBe(200)
    expect(searchCalls(h)).toHaveLength(calls)
  })

  it('shows a job only to the person who started it', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const job = await h.json<Job>(await search(h, 'q=calm'))
    expect((await getJob(h, job.id, h.admin)).status).toBe(404)
    expect([401, 403]).toContain((await getJob(h, job.id, h.outsider)).status)
    expect((await getJob(h, 'ovj_nope')).status).toBe(404)
    expect((await getJob(h, job.id)).status).toBe(200)
  })

  it('shares one job between identical searches, and starts another for a different page', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const [a, b] = await Promise.all([search(h, 'q=calm'), search(h, 'q=calm')])
    const ja = await h.json<Job>(a)
    const jb = await h.json<Job>(b)
    expect(jb.id).toBe(ja.id)
    expect(h.deps.platform.openverseJobs).toEqual([ja.id])
    // Asking again while it runs returns the same job without trying Openverse.
    const before = searchCalls(h).length
    expect((await h.json<Job>(await search(h, 'q=calm'))).id).toBe(ja.id)
    expect(searchCalls(h)).toHaveLength(before)
    const other = await h.json<Job>(await search(h, 'q=calm&page=2'))
    expect(other.id).not.toBe(ja.id)
  })

  it('limits how many searches a person starts per minute', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    for (let i = 0; i < JOBS_PER_MINUTE; i++) expect((await search(h, `q=song+${i}`)).status).toBe(202)
    const limited = await search(h, 'q=one+more')
    expect(limited.status).toBe(429)
    expect((await h.json(limited)).error.message).toMatch(/Too many music searches/)
    // Someone else isn't limited, and a minute later neither is this person.
    expect((await search(h, 'q=one+more', h.admin)).status).toBe(202)
    h.deps.clock.advance(61_000)
    expect((await search(h, 'q=one+more')).status).toBe(202)
  })

  it('retries timeouts and 5xx with backoff in the job, and fails plainly when Openverse stays down', async () => {
    const { h, ov, slept } = setup()
    ov.mode = 'hang'
    const job = await h.json<Job>(await search(h, 'q=calm'))
    ov.mode = 'ok'
    ov.queue = ['hang', 503]
    expect(await runOpenverseJob(h.deps, job.id)).toBe('done')
    expect(slept).toEqual([2000, 5000])
    expect(h.deps.logs.join('\n')).toContain('openverse.retry')

    slept.length = 0
    ov.mode = 'hang'
    const down = await h.json<Job>(await search(h, 'q=other'))
    ov.mode = 503
    expect(await runOpenverseJob(h.deps, down.id)).toBe('failed')
    expect(slept).toEqual([2000, 5000, 15000])
    expect(searchCalls(h).slice(-4)).toHaveLength(4)
    expect((await h.json<Job>(await getJob(h, down.id))).error).toEqual({
      code: 'upstream_error',
      message: "Openverse didn't answer. Try again shortly.",
    })
  })

  it("waits out a 429's Retry-After in the job, but not one longer than two minutes", async () => {
    const { h, ov, slept } = setup()
    ov.mode = 'hang'
    const job = await h.json<Job>(await search(h, 'q=calm'))
    ov.mode = 'ok'
    ov.queue = [{ status: 429, retryAfter: '30' }]
    expect(await runOpenverseJob(h.deps, job.id)).toBe('done')
    expect(slept).toEqual([30_000])

    slept.length = 0
    ov.mode = 'hang'
    const busy = await h.json<Job>(await search(h, 'q=busy'))
    ov.mode = 'ok'
    ov.queue = [{ status: 429, retryAfter: '300' }]
    expect(await runOpenverseJob(h.deps, busy.id)).toBe('failed')
    expect(slept).toEqual([])
    expect((await h.json<Job>(await getJob(h, busy.id))).error?.code).toBe('rate_limited')
  })

  it('still answers 202 when the dispatch is lost; the sweep dispatches it again, then gives up', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    h.deps.platform.onOpenverseJob = () => Promise.reject(new Error('network'))
    const res = await search(h, 'q=calm')
    expect(res.status).toBe(202)
    const job = await h.json<Job>(res)
    expect(h.deps.logs.join('\n')).toContain('openverse.dispatch_failed')
    h.deps.platform.onOpenverseJob = null
    h.deps.clock.advance(31_000)
    await sweepOpenverseJobs(h.deps)
    expect(h.deps.platform.openverseJobs).toEqual([job.id, job.id])
    // Nobody ever ran it: after five minutes it fails instead of spinning forever.
    h.deps.clock.advance(5 * 60_000)
    await sweepOpenverseJobs(h.deps)
    expect((await h.json<Job>(await getJob(h, job.id))).status).toBe('failed')
  })

  it('fails a job cut off with its function, and the sweep deletes expired jobs', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const job = await h.json<Job>(await search(h, 'q=calm'))
    expect(await h.deps.store.claimOpenverseJob(job.id, h.deps.clock.now().toISOString())).toBe(true)
    h.deps.clock.advance(17 * 60_000)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 5 })
    const failed = await h.json<Job>(await getJob(h, job.id))
    expect(failed.error?.message).toMatch(/took too long/)
    h.deps.clock.advance(14 * 60_000)
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 5 })
    expect(await h.deps.store.getOpenverseJob(job.id)).toBeNull()
    expect((await getJob(h, job.id)).status).toBe(404)
  })
})

describe('Openverse import jobs', () => {
  it('imports inline when Openverse is quick', async () => {
    const { h } = setup()
    const res = await importIt(h, 1)
    expect(res.status).toBe(201)
    expect((await importIt(h, 1)).status).toBe(200)
    expect(h.deps.platform.openverseJobs).toEqual([])
  })

  it('hands a slow import to a job whose result is the library item', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const res = await importIt(h, 1)
    expect(res.status).toBe(202)
    const job = await h.json<Job>(res)
    expect(job).toMatchObject({ kind: 'import', status: 'queued', media: null })
    // Pressing Import again while it runs returns the same job.
    expect((await h.json<Job>(await importIt(h, 1))).id).toBe(job.id)
    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, job.id)).toBe('done')
    const done = await h.json<Job>(await getJob(h, job.id))
    expect(done).toMatchObject({
      status: 'done',
      created: true,
      media: { kind: 'audio', source: { id: id(1), licenseLabel: 'CC BY 4.0' } },
    })
    // Now it's in the library: importing again answers at once, and searches mark it.
    const again = await importIt(h, 1)
    expect(again.status).toBe(200)
    expect((await h.json<{ id: string }>(again)).id).toBe(done.media?.id)
    const found = await h.json<{ items: { id: string; mediaId: string | null }[] }>(await search(h, 'q=x'))
    expect(found.items.find((t) => t.id === id(1))?.mediaId).toBe(done.media?.id)
  })

  it('fails an import job for a refused or missing track with the reason', async () => {
    const { h, ov } = setup()
    ov.mode = 'hang'
    const job = await h.json<Job>(await importIt(h, 9))
    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, job.id)).toBe('failed')
    expect((await h.json<Job>(await getJob(h, job.id))).error).toEqual({
      code: 'not_found',
      message: "That track isn't on Openverse (any more).",
    })
  })
})

describe('Openverse jobs in Postgres', () => {
  it('dedupes, runs, polls and sweeps jobs', async () => {
    const { h, ov } = setup({ store: await pgStore() })
    ov.mode = 'hang'
    const [a, b] = await Promise.all([search(h, 'q=calm'), search(h, 'q=calm')])
    const job = await h.json<Job>(a)
    expect((await h.json<Job>(b)).id).toBe(job.id)
    expect(h.deps.platform.openverseJobs).toEqual([job.id])
    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, job.id)).toBe('done')
    expect((await h.json<Job>(await getJob(h, job.id))).search?.total).toBe(2)
    // A finished job doesn't block a new identical one later.
    h.deps.clock.advance(6 * 60_000)
    resetOpenverseCache()
    fastTiming(h)
    ov.mode = 'hang'
    const next = await h.json<Job>(await search(h, 'q=calm'))
    expect(next.id).not.toBe(job.id)
    ov.mode = 'hang'
    const imp = await h.json<Job>(await importIt(h, 2))
    ov.mode = 'ok'
    expect(await runOpenverseJob(h.deps, imp.id)).toBe('done')
    expect((await h.json<Job>(await getJob(h, imp.id))).media?.source?.id).toBe(id(2))
    expect(await h.deps.store.countOpenverseJobs('u_member', '2000-01-01T00:00:00.000Z')).toBe(3)
    h.deps.clock.advance(31 * 60_000)
    await sweepOpenverseJobs(h.deps)
    expect(await h.deps.store.getOpenverseJob(job.id)).toBeNull()
    expect(await h.deps.store.getOpenverseJob(imp.id)).toBeNull()
  })
})

describe('Openverse jobs over MCP', () => {
  type Call = { structuredContent: Record<string, any>; isError?: boolean }
  const tool = async (h: Harness, key: string, name: string, args: Record<string, unknown>) =>
    (await mcpCall(h, key, 'tools/call', { name, arguments: args })) as Call

  it('search_music waits for a job that finishes in time', async () => {
    const { h, ov } = setup()
    // The inline try times out; the job (run as soon as it's dispatched) gets an answer.
    ov.queue = ['hang']
    h.deps.platform.onOpenverseJob = async (jobId) => {
      await runOpenverseJob(h.deps, jobId)
    }
    const r = await tool(h, await apiKey(h, h.member), 'search_music', { query: 'calm' })
    expect(r.structuredContent.status).toBe('done')
    expect(r.structuredContent.tracks).toHaveLength(2)
  })

  it('search_music and import_music answer "pending" with a job to poll with get_music_job', async () => {
    const { h, ov } = setup()
    const key = await apiKey(h, h.member)
    ov.mode = 'hang'
    const pending = await tool(h, key, 'search_music', { query: 'calm' })
    expect(pending.structuredContent).toMatchObject({
      status: 'pending',
      kind: 'search',
      next: 'call get_music_job',
      suggested_tool_calls: [{ name: 'get_music_job', arguments: { wait_seconds: 8 } }],
    })
    const jobId = pending.structuredContent.job_id as string
    expect((await tool(h, key, 'get_music_job', { job_id: jobId })).structuredContent.status).toBe('pending')
    ov.mode = 'ok'
    await runOpenverseJob(h.deps, jobId)
    const done = await tool(h, key, 'get_music_job', { job_id: jobId, wait_seconds: 1 })
    expect(done.structuredContent.status).toBe('done')
    expect(done.structuredContent.tracks).toHaveLength(2)

    ov.mode = 'hang'
    const imp = await tool(h, key, 'import_music', { id: id(1) })
    expect(imp.structuredContent).toMatchObject({ status: 'pending', kind: 'import' })
    ov.mode = 'ok'
    await runOpenverseJob(h.deps, imp.structuredContent.job_id as string)
    const got = await tool(h, key, 'get_music_job', { job_id: imp.structuredContent.job_id })
    expect(got.structuredContent).toMatchObject({ status: 'done', already_in_library: false })
    expect(got.structuredContent.media_id).toMatch(/^med_/)
  })

  it('get_music_job reports a failed job as an error, and only to its owner', async () => {
    const { h, ov } = setup()
    const key = await apiKey(h, h.member)
    ov.mode = 'hang'
    const pending = await tool(h, key, 'search_music', { query: 'calm' })
    const jobId = pending.structuredContent.job_id as string
    ov.mode = 503
    await runOpenverseJob(h.deps, jobId)
    const failed = await tool(h, key, 'get_music_job', { job_id: jobId })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent.error).toMatchObject({ type: 'UPSTREAM_ERROR' })
    const other = await tool(h, await apiKey(h, await person(h, 'u_other', 'creator')), 'get_music_job', {
      job_id: jobId,
    })
    expect(other.structuredContent.error).toMatchObject({ type: 'NOT_FOUND' })
  })
})
