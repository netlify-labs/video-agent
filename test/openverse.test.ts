// Openverse music: the server-side search proxy (licence filtering, normalizing, token flow, caching, rate limits),
// imports (re-read by id, licence refused, bytes checked, size and redirect limits, duplicates), provenance on the item,
// and credits derived from it on the version, the embed and the public share page. Openverse is a fake fetch.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { apiKey, harness, mcpCall, person, pgStore, PROMPT, png, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const MP3 = new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const FILE_HOST = 'https://files.example-audio.org'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

interface RawOpts {
  license?: string
  version?: string
  url?: string
  filetype?: string
  filesize?: number
  duration?: number
  mature?: boolean
  alt?: { url: string; filetype: string; filesize?: number }[]
}
/** An Openverse audio result, shaped like GET /v1/audio/ (schema at https://api.openverse.org/v1/schema/). */
function raw(n: number, o: RawOpts = {}) {
  const license = o.license ?? 'by'
  return {
    id: id(n),
    title: `Track ${n}`,
    indexed_on: '2024-01-01T00:00:00Z',
    foreign_landing_url: `https://www.jamendo.com/track/${n}`,
    url: o.url ?? `${FILE_HOST}/t${n}.mp3`,
    creator: `Artist ${n}`,
    creator_url: `https://www.jamendo.com/artist/${n}`,
    license,
    license_version: o.version ?? (license === 'cc0' ? '1.0' : '4.0'),
    license_url: `https://creativecommons.org/licenses/${license}/4.0/`,
    provider: 'jamendo',
    source: 'jamendo',
    category: 'music',
    genres: ['ambient', 'piano'],
    filesize: o.filesize ?? MP3.byteLength,
    filetype: o.filetype ?? 'mp3',
    tags: [],
    alt_files: o.alt ?? null,
    attribution: `"Track ${n}" by Artist ${n} is licensed under CC ${license.toUpperCase()} 4.0.`,
    fields_matched: [],
    mature: o.mature ?? false,
    audio_set: null,
    duration: o.duration ?? 95_000,
    bit_rate: 128000,
    sample_rate: 44100,
    thumbnail: null,
    detail_url: `https://api.openverse.org/v1/audio/${id(n)}/`,
    related_url: `https://api.openverse.org/v1/audio/${id(n)}/related/`,
    waveform: `https://api.openverse.org/v1/audio/${id(n)}/waveform/`,
  }
}

type Raw = ReturnType<typeof raw>
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A fake Openverse: a catalogue of items, search over it, item lookups, tokens and the files themselves. */
function openverse(h: Harness, items: Raw[], files: Record<string, () => Response> = {}) {
  const state = {
    items,
    searchStatus: 200,
    tokens: 0,
    tokenStatus: 200,
    rejectToken: null as string | null,
  }
  h.deps.outbound.handler = (u, init) => {
    if (u.origin === 'https://api.openverse.org') {
      if (u.pathname === '/v1/auth_tokens/token/' && init.method === 'POST') {
        if (state.tokenStatus !== 200) return json({ detail: 'nope' }, state.tokenStatus)
        state.tokens++
        return json({
          access_token: `tok_${state.tokens}`,
          expires_in: 36000,
          token_type: 'Bearer',
          scope: 'read',
        })
      }
      const auth = new Headers(init.headers).get('authorization')
      if (auth && auth === state.rejectToken) return json({ detail: 'expired' }, 401)
      if (u.pathname === '/v1/audio/') {
        if (state.searchStatus === 429)
          return json({ detail: 'Request was throttled.' }, 429, { 'retry-after': '30' })
        if (state.searchStatus !== 200) return json({ detail: 'boom' }, state.searchStatus)
        return json({
          result_count: state.items.length,
          page_count: 1,
          page_size: 20,
          page: 1,
          results: state.items,
        })
      }
      const one = /^\/v1\/audio\/([0-9a-f-]+)\/$/.exec(u.pathname)
      if (one) {
        const it = state.items.find((x) => x.id === one[1])
        return it ? json(it) : json({ detail: 'Not found.' }, 404)
      }
    }
    const f = files[u.toString()]
    if (f) return f()
    if (u.origin === FILE_HOST)
      return new Response(MP3, { headers: { 'content-length': String(MP3.byteLength) } })
    return new Response('', { status: 404 })
  }
  return state
}

const calls = (h: Harness, re: RegExp) => h.deps.outbound.calls.filter((c) => re.test(c.url))
const search = (h: Harness, q: string, as = h.member) =>
  h.call('GET', `/api/v1/media/openverse/search?${q}`, { as })
const importIt = (h: Harness, body: Record<string, unknown>, as = h.member) =>
  h.call('POST', '/api/v1/media/openverse/import', { as, body })

interface Track {
  id: string
  license: string
  licenseLabel: string
  previewUrl: string | null
  importable: boolean
  mediaId: string | null
  durationSec: number | null
  creator: string | null
  filetype: string | null
}

describe('Openverse search', () => {
  it('proxies a search with CC0 + CC BY music by default and normalizes the results', async () => {
    const h = harness()
    openverse(h, [raw(1), raw(2, { license: 'cc0' })])
    const res = await search(h, 'q=calm+piano')
    expect(res.status).toBe(200)
    const body = await h.json<{ items: Track[]; page: number }>(res)
    const sent = new URL(calls(h, /\/v1\/audio\/\?/)[0]?.url ?? '')
    expect(sent.searchParams.get('q')).toBe('calm piano')
    expect(sent.searchParams.get('license')).toBe('cc0,by')
    expect(sent.searchParams.get('category')).toBe('music')
    expect(calls(h, /./)[0]?.headers['user-agent']).toMatch(/^VideoAgent\//)
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toMatchObject({
      id: id(1),
      title: 'Track 1',
      creator: 'Artist 1',
      creatorUrl: 'https://www.jamendo.com/artist/1',
      durationSec: 95,
      license: 'by',
      licenseVersion: '4.0',
      licenseLabel: 'CC BY 4.0',
      landingUrl: 'https://www.jamendo.com/track/1',
      source: 'jamendo',
      previewUrl: `${FILE_HOST}/t1.mp3`,
      filetype: 'mp3',
      importable: true,
      mediaId: null,
    })
    expect(body.items[1]?.licenseLabel).toBe('CC0 1.0')
    // All audio, for effects.
    await search(h, 'q=click&category=all')
    expect(new URL(calls(h, /\/v1\/audio\/\?/)[1]?.url ?? '').searchParams.has('category')).toBe(false)
  })

  it('never returns NC, ND, SA or other licences, or mature items, whatever Openverse sends', async () => {
    const h = harness()
    openverse(h, [
      raw(1),
      raw(2, { license: 'cc0' }),
      raw(3, { license: 'by-nc' }),
      raw(4, { license: 'by-nd' }),
      raw(5, { license: 'by-sa' }),
      raw(6, { license: 'by-nc-sa' }),
      raw(7, { license: 'pdm' }),
      raw(8, { license: 'sampling+' }),
      raw(9, { mature: true }),
    ])
    const all = await h.json<{ items: Track[] }>(await search(h, 'q=x'))
    expect(all.items.map((t) => t.license)).toEqual(['by', 'cc0'])
    const cc0 = await h.json<{ items: Track[] }>(await search(h, 'q=x&license=cc0'))
    expect(cc0.items.map((t) => t.id)).toEqual([id(2)])
    expect(new URL(calls(h, /\/v1\/audio\/\?/)[1]?.url ?? '').searchParams.get('license')).toBe('cc0')
    // Other licence filters aren't accepted at all.
    expect((await search(h, 'q=x&license=by-nc')).status).toBe(400)
  })

  it('marks what the library can’t take and drops non-https previews', async () => {
    const h = harness()
    openverse(h, [
      raw(1, { filetype: 'flac' }),
      raw(2, { filetype: 'flac', alt: [{ url: `${FILE_HOST}/t2.mp3`, filetype: 'mp3', filesize: 1000 }] }),
      raw(3, { filesize: 80 * 1024 * 1024 }),
      raw(4, { duration: 11 * 60_000 }),
      raw(5, { url: 'http://insecure.example.org/t5.mp3' }),
      // Jamendo names its MP3s by bitrate.
      raw(6, { filetype: 'mp32' }),
    ])
    const { items } = await h.json<{ items: Track[] }>(await search(h, 'q=x'))
    expect(items.map((t) => t.importable)).toEqual([false, true, false, false, false, true])
    expect(items[5]?.filetype).toBe('mp3')
    expect(items[4]?.previewUrl).toBeNull()
  })

  it('is for creators and admins only, and needs a query', async () => {
    const h = harness()
    openverse(h, [raw(1)])
    const viewer = await person(h, 'u_viewer', 'viewer')
    const reviewer = await person(h, 'u_rev', 'reviewer')
    expect((await search(h, 'q=x', viewer)).status).toBe(403)
    expect((await search(h, 'q=x', reviewer)).status).toBe(403)
    expect((await importIt(h, { id: id(1) }, viewer)).status).toBe(403)
    expect((await search(h, 'q=')).status).toBe(400)
    expect([401, 403]).toContain((await search(h, 'q=x', h.outsider)).status)
    expect(calls(h, /openverse/)).toHaveLength(0)
  })

  it('caches a search, and keys it by the normalized request', async () => {
    const h = harness()
    openverse(h, [raw(1)])
    await search(h, 'q=calm')
    await search(h, 'q=calm')
    expect(calls(h, /\/v1\/audio\/\?/)).toHaveLength(1)
    await search(h, 'q=calm&page=2')
    expect(calls(h, /\/v1\/audio\/\?/)).toHaveLength(2)
    // Past the in-memory minutes, the stored search still answers within its fresh day.
    h.deps.clock.advance(6 * 60_000)
    await search(h, 'q=++calm+&license=cc0,by&category=music&page=1')
    expect(calls(h, /\/v1\/audio\/\?/)).toHaveLength(2)
  })

  it('says Openverse is busy when rate-limited, and waits before asking again', async () => {
    const h = harness()
    const ov = openverse(h, [raw(1)])
    ov.searchStatus = 429
    const res = await search(h, 'q=calm')
    expect(res.status).toBe(429)
    expect((await h.json(res)).error).toEqual({
      code: 'rate_limited',
      message: 'Openverse is busy, try again in a minute.',
    })
    ov.searchStatus = 200
    expect((await search(h, 'q=other')).status).toBe(429)
    expect(calls(h, /\/v1\/audio\/\?/)).toHaveLength(1)
    h.deps.clock.advance(31_000)
    expect((await search(h, 'q=other')).status).toBe(200)
    // An outage hands the search to a background job (test/openverse-jobs.test.ts) instead of failing.
    ov.searchStatus = 503
    const down = await search(h, 'q=third')
    expect(down.status).toBe(202)
    expect((await h.json(down)).status).toBe('queued')
  })

  it('uses a registered app’s token, cached until it expires, and renews it on a 401', async () => {
    const h = harness({ OPENVERSE_CLIENT_ID: 'cid', OPENVERSE_CLIENT_SECRET: 'csecret' })
    const ov = openverse(h, [raw(1)])
    await search(h, 'q=a')
    await search(h, 'q=b')
    const token = calls(h, /auth_tokens/)
    expect(token).toHaveLength(1)
    expect(token[0]?.method).toBe('POST')
    expect(token[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(token[0]?.body ?? ''))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'csecret',
    })
    const searches = calls(h, /\/v1\/audio\/\?/)
    expect(searches.map((c) => c.headers.authorization)).toEqual(['Bearer tok_1', 'Bearer tok_1'])
    // Expired: a new one.
    h.deps.clock.advance(36_000_000)
    await search(h, 'q=c')
    expect(calls(h, /auth_tokens/)).toHaveLength(2)
    expect(calls(h, /\/v1\/audio\/\?/).at(-1)?.headers.authorization).toBe('Bearer tok_2')
    // Revoked: renewed once and retried.
    ov.rejectToken = 'Bearer tok_2'
    expect((await search(h, 'q=d')).status).toBe(200)
    expect(calls(h, /\/v1\/audio\/\?/).at(-1)?.headers.authorization).toBe('Bearer tok_3')
    // The secret never reaches a log.
    expect(h.deps.logs.join('\n')).not.toContain('csecret')
  })

  it('searches anonymously when the app credentials are refused', async () => {
    const h = harness({ OPENVERSE_CLIENT_ID: 'cid', OPENVERSE_CLIENT_SECRET: 'bad' })
    const ov = openverse(h, [raw(1)])
    ov.tokenStatus = 401
    expect((await search(h, 'q=a')).status).toBe(200)
    expect(calls(h, /\/v1\/audio\/\?/)[0]?.headers.authorization).toBeUndefined()
    expect(h.deps.logs.join('\n')).toContain('openverse.token_failed')
  })
})

interface Media {
  id: string
  kind: string
  status: string
  filename: string
  caption: string | null
  durationSec: number | null
  source: {
    name: string
    id: string
    url: string | null
    title: string | null
    creator: string | null
    creatorUrl: string | null
    license: string
    licenseVersion: string | null
    licenseLabel: string
    licenseUrl: string | null
    attribution: string | null
    creditRequired: boolean
  } | null
}

describe('Openverse import', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  it('re-reads the item by id, downloads its file, stores it as library audio with its provenance', async () => {
    const h = harness()
    openverse(h, [raw(1)])
    // A file URL in the request is ignored: only the id counts.
    const res = await importIt(h, { id: id(1), url: 'https://evil.example.com/x.mp3' })
    expect(res.status).toBe(201)
    const m = await h.json<Media>(res)
    expect(m).toMatchObject({ kind: 'audio', status: 'ready', filename: 'Track 1 - Artist 1.mp3' })
    expect(m.caption).toBe('Track 1 by Artist 1')
    expect(m.source).toEqual({
      name: 'openverse',
      id: id(1),
      url: 'https://www.jamendo.com/track/1',
      title: 'Track 1',
      creator: 'Artist 1',
      creatorUrl: 'https://www.jamendo.com/artist/1',
      license: 'by',
      licenseVersion: '4.0',
      licenseLabel: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: '"Track 1" by Artist 1 is licensed under CC BY 4.0.',
      creditRequired: true,
    })
    expect(calls(h, new RegExp(`/v1/audio/${id(1)}/$`))).toHaveLength(1)
    expect(calls(h, /evil/)).toHaveLength(0)
    expect(calls(h, /files\.example-audio/)).toHaveLength(1)
    // It is a normal library item: listed, in the picker's audio filter, readable on its own.
    const list = await h.json<{ items: Media[] }>(
      await h.call('GET', '/api/v1/media?kind=audio', { as: h.member }),
    )
    expect(list.items.map((x) => x.id)).toEqual([m.id])
    const row = await h.deps.store.getMedia(m.id)
    expect(row).toMatchObject({ source: 'openverse', sourceId: id(1), license: 'by', creator: 'Artist 1' })
    expect(await h.deps.blobs.get('media', row?.originalKey ?? '')).toEqual(MP3)
    // Uploads have no source.
    const up = await h.json<Media>(
      await h.app.fetch(
        new Request('https://video.example.com/api/v1/media?filename=logo.png', {
          method: 'POST',
          headers: { cookie: h.member, origin: 'https://video.example.com' },
          body: png(),
        }),
        { context: { deploy: { published: true }, waitUntil: () => undefined } },
      ),
    )
    expect(up.source).toBeNull()
  })

  it('returns the existing item when the same track is imported again', async () => {
    const h = harness()
    openverse(h, [raw(1)])
    const a = await h.json<Media>(await importIt(h, { id: id(1) }))
    const again = await importIt(h, { id: id(1).toUpperCase() })
    expect(again.status).toBe(200)
    expect((await h.json<Media>(again)).id).toBe(a.id)
    expect(calls(h, /files\.example-audio/)).toHaveLength(1)
    // Search shows it's already in the library.
    const { items } = await h.json<{ items: Track[] }>(await search(h, 'q=x'))
    expect(items[0]?.mediaId).toBe(a.id)
    // Deleted from the library: importing makes a new item.
    await h.call('DELETE', `/api/v1/media/${a.id}`, { as: h.member })
    const b = await importIt(h, { id: id(1) })
    expect(b.status).toBe(201)
    expect((await h.json<Media>(b)).id).not.toBe(a.id)
  })

  it('refuses licences outside CC0 and CC BY without downloading anything', async () => {
    const h = harness()
    openverse(h, [raw(1, { license: 'by-nc' }), raw(2, { license: 'by-sa' })])
    for (const n of [1, 2]) {
      const res = await importIt(h, { id: id(n) })
      expect(res.status).toBe(400)
      expect((await h.json(res)).error.message).toMatch(/Only CC0 and CC BY tracks can be imported/)
    }
    expect(calls(h, /files\.example-audio/)).toHaveLength(0)
    expect((await importIt(h, { id: id(9) })).status).toBe(404)
    expect((await importIt(h, { id: '../../etc' })).status).toBe(400)
  })

  it('refuses a file whose bytes are not audio', async () => {
    const h = harness()
    openverse(h, [raw(1)], { [`${FILE_HOST}/t1.mp3`]: () => new Response(png()) })
    const res = await importIt(h, { id: id(1) })
    expect(res.status).toBe(400)
    expect((await h.json(res)).error.message).toMatch(/isn't audio/)
    const html = harness()
    openverse(html, [raw(1)], { [`${FILE_HOST}/t1.mp3`]: () => new Response('<html>not found</html>') })
    expect((await importIt(html, { id: id(1) })).status).toBe(400)
    expect(await h.deps.store.mediaBySource('openverse', [id(1)])).toEqual([])
  })

  it('enforces the size cap from the header and while streaming', async () => {
    const h = harness()
    const big = 51 * 1024 * 1024
    openverse(h, [raw(1, { filesize: 0 }), raw(2, { filesize: 0 })], {
      [`${FILE_HOST}/t1.mp3`]: () => new Response(MP3, { headers: { 'content-length': String(big) } }),
      // No length up front: a stream that keeps going past 50 MB.
      [`${FILE_HOST}/t2.mp3`]: () => {
        let sent = 0
        return new Response(
          new ReadableStream({
            pull(c) {
              if (sent > big) return c.close()
              sent += 1024 * 1024
              c.enqueue(new Uint8Array(1024 * 1024))
            },
          }),
        )
      },
    })
    for (const n of [1, 2]) {
      const res = await importIt(h, { id: id(n) })
      expect(res.status).toBe(400)
      expect((await h.json(res)).error.message).toMatch(/over 50 MB/)
    }
    // A declared size over the cap isn't downloaded at all.
    openverse(h, [raw(3, { filesize: 60 * 1024 * 1024 })])
    expect((await importIt(h, { id: id(3) })).status).toBe(400)
    expect(calls(h, /t3\.mp3/)).toHaveLength(0)
  })

  it('follows at most three https redirects', async () => {
    const h = harness()
    const hop = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })
    openverse(h, [raw(1), raw(2), raw(3)], {
      [`${FILE_HOST}/t1.mp3`]: hop('/r1'),
      [`${FILE_HOST}/r1`]: hop('https://cdn.example-audio.org/final.mp3'),
      'https://cdn.example-audio.org/final.mp3': () => new Response(MP3),
      [`${FILE_HOST}/t2.mp3`]: hop('/a'),
      [`${FILE_HOST}/a`]: hop('/b'),
      [`${FILE_HOST}/b`]: hop('/c'),
      [`${FILE_HOST}/c`]: hop('/d'),
      [`${FILE_HOST}/t3.mp3`]: hop('http://insecure.example-audio.org/t3.mp3'),
    })
    expect((await importIt(h, { id: id(1) })).status).toBe(201)
    const loop = await importIt(h, { id: id(2) })
    expect(loop.status).toBe(502)
    expect((await h.json(loop)).error.message).toMatch(/redirects too many times/)
    expect(calls(h, /files\.example-audio\.org\/d$/)).toHaveLength(0)
    const insecure = await importIt(h, { id: id(3) })
    expect(insecure.status).toBe(502)
    expect((await h.json(insecure)).error.message).toMatch(/HTTPS/)
  })

  it('stores provenance and finds duplicates in Postgres', async () => {
    const h = harness({}, { store: await pgStore() })
    openverse(h, [raw(1), raw(2, { license: 'cc0' })])
    const a = await h.json<Media>(await importIt(h, { id: id(1) }))
    expect(a.source?.licenseLabel).toBe('CC BY 4.0')
    expect((await h.json<Media>(await importIt(h, { id: id(1) }))).id).toBe(a.id)
    const b = await h.json<Media>(await importIt(h, { id: id(2) }))
    expect(b.source).toMatchObject({ license: 'cc0', creditRequired: false })
    const v = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: PROMPT, mediaIds: [a.id, b.id] },
      }),
    )
    const rows = await h.deps.store.versionProvenance(v.id)
    expect(rows.map((r) => [r.versionN, r.mediaId, r.license])).toEqual([
      [1, a.id, 'by'],
      [1, b.id, 'cc0'],
    ])
    const got = await h.json<{ versions: { credits: { mediaId: string }[] }[] }>(
      await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }),
    )
    expect(got.versions[0]?.credits.map((c) => c.mediaId)).toEqual([a.id])
    // The library list (batched, store.videoPage) carries the same credits.
    const list = await h.json<{ items: unknown[] }>(await h.call('GET', '/api/v1/videos', { as: h.member }))
    expect(list.items).toContainEqual(got)
  })
})

interface Credit {
  mediaId: string
  role: string
  title: string
  creator: string | null
  licenseLabel: string
  sourceUrl: string | null
  text: string
}

describe('credits for CC BY media', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  const ready = async (h: Harness, body: Record<string, unknown>) => {
    const v = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, ...body } }),
    )
    await h.drive(4)
    return v.id
  }
  const versions = async (h: Harness, vid: string) =>
    (
      await h.json<{ versions: { n: number; credits: Credit[] }[] }>(
        await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
      )
    ).versions

  it('derives credits from provenance and shows them on the version, the embed and the share page', async () => {
    const h = harness()
    current = h.deps
    openverse(h, [raw(1), raw(2, { license: 'cc0' })])
    const by = await h.json<Media>(await importIt(h, { id: id(1) }))
    const cc0 = await h.json<Media>(await importIt(h, { id: id(2) }))
    const vid = await ready(h, { mediaIds: [by.id, cc0.id] })
    const [v1] = await versions(h, vid)
    expect(v1?.credits).toEqual([
      {
        mediaId: by.id,
        kind: 'audio',
        role: 'Music',
        title: 'Track 1',
        creator: 'Artist 1',
        creatorUrl: 'https://www.jamendo.com/artist/1',
        license: 'by',
        licenseLabel: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://www.jamendo.com/track/1',
        source: 'openverse',
        text: '"Track 1" by Artist 1, CC BY 4.0, https://www.jamendo.com/track/1',
      },
    ])
    // The run is told the track is credited for it.
    const run = h.deps.runner.starts.at(-1)?.prompt ?? ''
    expect(run).toContain('"credit":"\\"Track 1\\" by Artist 1, CC BY 4.0')
    expect(run).toContain('the app credits it under the video')

    const pub = await h.json<{ slug: string; embed: string }>(
      await h.call('POST', `/api/v1/videos/${vid}/versions/1/publish`, { as: h.member }),
    )
    expect(pub.embed).toMatch(/^<figure style="margin:0"><video /)
    expect(pub.embed).toContain(
      'Music: <a href="https://www.jamendo.com/track/1" rel="noopener" target="_blank">Track 1</a> by <a href="https://www.jamendo.com/artist/1" rel="noopener" target="_blank">Artist 1</a>, <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank">CC BY 4.0</a>',
    )
    const page = await (
      await (
        await loadEdge('public')
      )(new Request(`https://video.example.com/v/${pub.slug}`), {
        deploy: { published: true },
      })
    ).text()
    expect(page).toContain(
      '<small class="credits" data-credits>Music: <a href="https://www.jamendo.com/track/1"',
    )
    expect(page).toContain('CC BY 4.0</a>')
    expect(page).not.toContain('Track 2')
  })

  it('a CC0-only or silent version has no credits, and an embed stays a plain video', async () => {
    const h = harness()
    current = h.deps
    openverse(h, [raw(1), raw(2, { license: 'cc0' })])
    const by = await h.json<Media>(await importIt(h, { id: id(1) }))
    const cc0 = await h.json<Media>(await importIt(h, { id: id(2) }))
    const a = await ready(h, { mediaIds: [cc0.id] })
    expect((await versions(h, a))[0]?.credits).toEqual([])
    const pub = await h.json<{ embed: string; slug: string }>(
      await h.call('POST', `/api/v1/videos/${a}/versions/1/publish`, { as: h.member }),
    )
    expect(pub.embed).toMatch(/^<video /)
    const page = await (
      await (
        await loadEdge('public')
      )(new Request(`https://video.example.com/v/${pub.slug}`), {
        deploy: { published: true },
      })
    ).text()
    expect(page).not.toContain('data-credits')
    // Silent: the picked track never reaches the run, so it isn't credited.
    const quiet = await ready(h, { mediaIds: [by.id], sound: 'silent' })
    expect((await versions(h, quiet))[0]?.credits).toEqual([])
  })

  it('a revision inherits the track and its credit', async () => {
    const h = harness()
    openverse(h, [raw(1)])
    const by = await h.json<Media>(await importIt(h, { id: id(1) }))
    const vid = await ready(h, { mediaIds: [by.id] })
    await h.call('POST', `/api/v1/videos/${vid}/versions`, { as: h.member, body: { prompt: 'Warmer.' } })
    await h.drive(4)
    const vs = await versions(h, vid)
    expect(vs.map((v) => [v.n, v.credits.map((c) => c.mediaId)])).toEqual([
      [2, [by.id]],
      [1, [by.id]],
    ])
  })
})

describe('Openverse over MCP', () => {
  it('search_music and import_music find and attach a track; get_video carries the attribution', async () => {
    const h = harness()
    openverse(h, [raw(1), raw(3, { license: 'by-nc' })])
    const key = await apiKey(h, h.member)
    const found = (await mcpCall(h, key, 'tools/call', {
      name: 'search_music',
      arguments: { query: 'calm piano' },
    })) as { structuredContent: { tracks: { id: string; license: string; credit_required: boolean }[] } }
    expect(found.structuredContent.tracks).toEqual([
      expect.objectContaining({ id: id(1), license: 'CC BY 4.0', credit_required: true }),
    ])
    const imported = (await mcpCall(h, key, 'tools/call', {
      name: 'import_music',
      arguments: { id: id(1) },
    })) as { structuredContent: { media_id: string; already_in_library: boolean } }
    expect(imported.structuredContent.already_in_library).toBe(false)
    const again = (await mcpCall(h, key, 'tools/call', {
      name: 'import_music',
      arguments: { id: id(1) },
    })) as {
      structuredContent: { media_id: string; already_in_library: boolean }
    }
    expect(again.structuredContent).toMatchObject({
      media_id: imported.structuredContent.media_id,
      already_in_library: true,
    })
    const created = (await mcpCall(h, key, 'tools/call', {
      name: 'create_video',
      arguments: { prompt: PROMPT, media_ids: [imported.structuredContent.media_id] },
    })) as { structuredContent: { video_id: string } }
    await h.drive(4)
    const got = (await mcpCall(h, key, 'tools/call', {
      name: 'get_video',
      arguments: { video_id: created.structuredContent.video_id },
    })) as { structuredContent: { versions: { attribution?: string[] }[] } }
    expect(got.structuredContent.versions[0]?.attribution).toEqual([
      '"Track 1" by Artist 1, CC BY 4.0, https://www.jamendo.com/track/1',
    ])
  })

  it('hides the music tools from reviewers and viewers', async () => {
    const h = harness()
    const names = async (cookie: string) =>
      (
        (await mcpCall(h, await apiKey(h, cookie), 'tools/list', {})) as { tools: { name: string }[] }
      ).tools.map((t) => t.name)
    expect(await names(h.member)).toEqual(expect.arrayContaining(['search_music', 'import_music']))
    const reviewer = await names(await person(h, 'u_rev', 'reviewer'))
    expect(reviewer).not.toContain('search_music')
    expect(reviewer).not.toContain('import_music')
  })
})
