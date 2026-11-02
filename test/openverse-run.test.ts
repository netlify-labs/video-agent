// The run's Openverse helper (scripts/openverse.ts) with a fake fetch: licence filtering, the token flow, retries,
// Jamendo's type aliases, and fetch writing the file and credits.json while refusing non-audio, oversize, non-https
// and redirect loops.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchItem, Openverse, readCredits, RUN_MAX_BYTES, search, type Io } from '../scripts/openverse.js'

const MP3 = new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
// A font: real bytes that classify, but not as audio.
const FONT = new Uint8Array([...new TextEncoder().encode('wOF2'), ...new Array<number>(40).fill(0)])
const FILES = 'https://files.example-audio.org'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function raw(n: number, o: Record<string, unknown> = {}) {
  const license = (o.license as string | undefined) ?? 'by'
  return {
    id: id(n),
    title: `Track ${n}`,
    foreign_landing_url: `https://www.jamendo.com/track/${n}`,
    url: `${FILES}/t${n}.mp3`,
    creator: `Artist ${n}`,
    creator_url: `https://www.jamendo.com/artist/${n}`,
    license,
    license_version: license === 'cc0' ? '1.0' : '4.0',
    license_url: `https://creativecommons.org/licenses/${license}/4.0/`,
    source: 'jamendo',
    category: 'music',
    genres: ['ambient'],
    tags: [{ name: 'calm' }, null, { name: 'piano' }],
    filesize: MP3.byteLength,
    filetype: 'mp3',
    alt_files: null,
    attribution: `"Track ${n}" by Artist ${n}`,
    mature: false,
    duration: 95_000,
    ...o,
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A fake Openverse plus file host. `handle` may answer any request first. */
function fake(
  items: ReturnType<typeof raw>[],
  o: {
    env?: Record<string, string>
    handle?: (u: URL, init: RequestInit) => Response | Promise<Response> | null
    files?: Record<string, () => Response>
  } = {},
) {
  const calls: { url: URL; method: string; auth: string | null; body: string | null }[] = []
  const sleeps: number[] = []
  const io: Io = {
    env: o.env ?? {},
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const headers = new Headers(init.headers)
      calls.push({
        url,
        method: init.method ?? 'GET',
        auth: headers.get('authorization'),
        body: typeof init.body === 'string' ? init.body : null,
      })
      expect(init.redirect).toBe('manual')
      const pre = await o.handle?.(url, init)
      if (pre) return pre
      if (url.origin === 'https://api.openverse.org') {
        if (url.pathname === '/v1/auth_tokens/token/')
          return json({ access_token: 'tok_1', expires_in: 3600 })
        if (url.pathname === '/v1/audio/') return json({ results: items, result_count: items.length })
        const m = /^\/v1\/audio\/([0-9a-f-]+)\/$/.exec(url.pathname)
        const item = items.find((i) => i.id === m?.[1])
        return item ? json(item) : json({ detail: 'Not found' }, 404)
      }
      const file = o.files?.[url.toString()]
      if (file) return file()
      if (url.origin === FILES) return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } })
      return new Response('nope', { status: 404 })
    },
  }
  return { io, calls, sleeps, ov: new Openverse(io) }
}

describe('search', () => {
  it('offers only CC0 and CC BY, never mature, NC, ND or SA, whatever Openverse sends', async () => {
    const { ov, calls } = fake([
      raw(1),
      raw(2, { license: 'cc0' }),
      raw(3, { license: 'by-nc' }),
      raw(4, { license: 'by-sa' }),
      raw(5, { license: 'by-nd' }),
      raw(6, { license: 'pdm' }),
      raw(7, { mature: true }),
      raw(8, { id: 'not-an-id' }),
    ])
    const found = await search(ov, '  calm   piano ')
    expect(found.map((c) => c.id)).toEqual([id(1), id(2)])
    expect(found[0]).toEqual({
      id: id(1),
      title: 'Track 1',
      creator: 'Artist 1',
      seconds: 95,
      license: 'CC BY 4.0',
      creditNeeded: true,
      genres: ['ambient'],
      tags: ['calm', 'piano'],
      source: 'jamendo',
    })
    expect(found[1]).toMatchObject({ license: 'CC0 1.0', creditNeeded: false })
    const q = calls[0]?.url.searchParams
    expect(q?.get('q')).toBe('calm piano')
    expect(q?.get('license')).toBe('cc0,by')
    expect(q?.get('category')).toBe('music')
    expect(q?.get('mature')).toBe('false')
    // Anonymous without credentials.
    expect(calls.every((c) => c.auth === null)).toBe(true)
  })

  it('filters by length and category, and leaves out items with no usable file', async () => {
    const { ov, calls } = fake([
      raw(1, { duration: 20_000 }),
      raw(2, { duration: 200_000 }),
      raw(3, { duration: 60_000 }),
      raw(4, { url: 'http://insecure.example.org/t.mp3' }),
      raw(5, { filetype: 'flac' }),
      raw(6, { filesize: RUN_MAX_BYTES + 1 }),
      // Jamendo labels MP3s mp32; an alternative within the cap is used when the main file is too big.
      raw(7, { filetype: 'mp32' }),
      raw(8, {
        filesize: 40 * 1024 * 1024,
        alt_files: [{ url: `${FILES}/t8-small.mp3`, filetype: 'mp31', filesize: 3_000_000 }],
      }),
    ])
    const found = await search(ov, 'drums', { category: 'sound_effect', minSeconds: 30, maxSeconds: 120 })
    expect(found.map((c) => c.id)).toEqual([id(3), id(7), id(8)])
    expect(calls[0]?.url.searchParams.get('category')).toBe('sound_effect')
    await expect(search(ov, '   ')).rejects.toThrow('Give a search query')
  })

  it('uses a registered app token when the run has credentials, and never sends the secret elsewhere', async () => {
    const { ov, calls } = fake([raw(1)], {
      env: { OPENVERSE_CLIENT_ID: 'cid', OPENVERSE_CLIENT_SECRET: 'shh' },
    })
    await search(ov, 'a')
    await search(ov, 'b')
    const token = calls.filter((c) => c.url.pathname === '/v1/auth_tokens/token/')
    expect(token).toHaveLength(1)
    expect(token[0]?.method).toBe('POST')
    expect(new URLSearchParams(token[0]?.body ?? '').get('client_secret')).toBe('shh')
    const searches = calls.filter((c) => c.url.pathname === '/v1/audio/')
    expect(searches.map((c) => c.auth)).toEqual(['Bearer tok_1', 'Bearer tok_1'])
    expect(searches.every((c) => !c.url.toString().includes('shh'))).toBe(true)
  })

  it('falls back to anonymous when the token is refused or stops working', async () => {
    const refused = fake([raw(1)], {
      env: { OPENVERSE_CLIENT_ID: 'cid', OPENVERSE_CLIENT_SECRET: 'bad' },
      handle: (u) =>
        u.pathname === '/v1/auth_tokens/token/' ? json({ error: 'invalid_client' }, 401) : null,
    })
    expect(await search(refused.ov, 'a')).toHaveLength(1)
    expect(refused.calls.at(-1)?.auth).toBeNull()

    let first = true
    const revoked = fake([raw(1)], {
      env: { OPENVERSE_CLIENT_ID: 'cid', OPENVERSE_CLIENT_SECRET: 'shh' },
      handle: (u, init) => {
        const auth = new Headers(init.headers).get('authorization')
        if (u.pathname === '/v1/audio/' && auth && first) {
          first = false
          return json({ detail: 'expired' }, 401)
        }
        return null
      },
    })
    expect(await search(revoked.ov, 'a')).toHaveLength(1)
    expect(revoked.calls.filter((c) => c.url.pathname === '/v1/audio/').map((c) => c.auth)).toEqual([
      'Bearer tok_1',
      null,
    ])
  })

  it('retries timeouts, 5xx and 429 with backoff (honouring Retry-After), then gives up', async () => {
    const answers = [
      () => {
        throw new Error('The operation was aborted due to timeout')
      },
      () => json({}, 503),
      () => json({}, 429, { 'retry-after': '5' }),
    ]
    const flaky = fake([raw(1)], {
      handle: (u) => (u.pathname === '/v1/audio/' ? (answers.shift()?.() ?? null) : null),
    })
    expect(await search(flaky.ov, 'a')).toHaveLength(1)
    expect(flaky.sleeps).toEqual([2000, 4000, 5000])

    const down = fake([raw(1)], { handle: (u) => (u.pathname === '/v1/audio/' ? json({}, 502) : null) })
    await expect(search(down.ov, 'a')).rejects.toThrow("Openverse didn't answer")
    expect(down.calls).toHaveLength(4)
    // A client error isn't retried.
    const bad = fake([raw(1)], { handle: (u) => (u.pathname === '/v1/audio/' ? json({}, 400) : null) })
    await expect(search(bad.ov, 'a')).rejects.toThrow('HTTP 400')
    expect(bad.calls).toHaveLength(1)
  })
})

describe('fetch', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ov-run-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('re-reads the item, downloads the file, saves it in assets/music and records its credit', async () => {
    const { ov, calls } = fake([raw(1), raw(2, { license: 'cc0' })])
    const r = await fetchItem(ov, id(1).toUpperCase(), { videoDir: dir, name: 'Calm Bed!' })
    expect(r.reused).toBe(false)
    expect(r.credit.file).toBe('assets/music/calm-bed.mp3')
    expect(readFileSync(join(dir, 'assets/music/calm-bed.mp3'))).toEqual(Buffer.from(MP3))
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/audio/${id(1)}/`, '/t1.mp3'])
    await fetchItem(ov, id(2), { videoDir: dir })
    const credits = JSON.parse(readFileSync(join(dir, 'assets/music/credits.json'), 'utf8')) as unknown[]
    expect(credits).toEqual([
      {
        file: 'assets/music/calm-bed.mp3',
        openverseId: id(1),
        title: 'Track 1',
        creator: 'Artist 1',
        creatorUrl: 'https://www.jamendo.com/artist/1',
        license: 'by',
        licenseVersion: '4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://www.jamendo.com/track/1',
        attribution: '"Track 1" by Artist 1',
      },
      expect.objectContaining({ file: 'assets/music/track-2.mp3', openverseId: id(2), license: 'cc0' }),
    ])
    // Fetching it again reuses the file without asking Openverse.
    const n = calls.length
    expect((await fetchItem(ov, id(1), { videoDir: dir })).reused).toBe(true)
    expect(calls).toHaveLength(n)
    expect(readCredits(dir)).toHaveLength(2)
  })

  it('puts sound effects in assets/sfx, follows a redirect, and never overwrites another item', async () => {
    const { ov } = fake([raw(1, { category: 'sound_effect', title: 'Click' }), raw(2, { title: 'Click' })], {
      files: {
        [`${FILES}/t1.mp3`]: () => new Response(null, { status: 302, headers: { location: '/real/t1.mp3' } }),
      },
    })
    expect((await fetchItem(ov, id(1), { videoDir: dir })).credit.file).toBe('assets/sfx/click.mp3')
    mkdirSync(join(dir, 'assets/music'), { recursive: true })
    writeFileSync(join(dir, 'assets/music/click.mp3'), 'mine')
    expect((await fetchItem(ov, id(2), { videoDir: dir })).credit.file).toBe(
      `assets/music/click-${id(2).slice(0, 8)}.mp3`,
    )
    expect(readFileSync(join(dir, 'assets/music/click.mp3'), 'utf8')).toBe('mine')
  })

  it('takes a Jamendo mp32 file and the bytes decide what it is', async () => {
    const { ov } = fake([raw(1, { filetype: 'mp32' })])
    expect((await fetchItem(ov, id(1), { videoDir: dir })).credit.file).toBe('assets/music/track-1.mp3')
  })

  it('refuses a licence that changed, non-audio, oversize files, non-https and redirect loops', async () => {
    const loop = () => new Response(null, { status: 302, headers: { location: `${FILES}/loop` } })
    const { ov } = fake(
      [
        raw(1, { license: 'by-nc' }),
        raw(2, { url: `${FILES}/font` }),
        raw(3, { url: `${FILES}/big`, filesize: null }),
        raw(4, { url: `${FILES}/stream`, filesize: null }),
        raw(5, { url: `${FILES}/to-http` }),
        raw(6, { url: `${FILES}/loop` }),
        raw(7, { mature: true }),
        raw(8, { filetype: 'flac' }),
      ],
      {
        files: {
          [`${FILES}/font`]: () => new Response(FONT),
          [`${FILES}/big`]: () =>
            new Response(MP3, { headers: { 'content-length': String(RUN_MAX_BYTES + 1) } }),
          [`${FILES}/stream`]: () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array(RUN_MAX_BYTES))
                  c.enqueue(new Uint8Array(10))
                  c.close()
                },
              }),
            ),
          [`${FILES}/to-http`]: () =>
            new Response(null, { status: 301, headers: { location: 'http://files.example-audio.org/t' } }),
          [`${FILES}/loop`]: loop,
        },
      },
    )
    const go = (n: number) => fetchItem(ov, id(n), { videoDir: dir })
    await expect(go(1)).rejects.toThrow('Only CC0 and CC BY items can be used (this one is CC BY-NC 4.0)')
    await expect(go(2)).rejects.toThrow("isn't audio")
    await expect(go(3)).rejects.toThrow('over 10 MB')
    await expect(go(4)).rejects.toThrow('over 10 MB')
    await expect(go(5)).rejects.toThrow("isn't served over HTTPS")
    await expect(go(6)).rejects.toThrow('redirects too many times')
    await expect(go(7)).rejects.toThrow("can't be used")
    await expect(go(8)).rejects.toThrow('no file that can be used')
    await expect(go(99)).rejects.toThrow("isn't on Openverse")
    await expect(fetchItem(ov, '../etc', { videoDir: dir })).rejects.toThrow('Pass an Openverse id')
    // Nothing was written.
    expect(existsSync(join(dir, 'assets'))).toBe(false)
  })
})
