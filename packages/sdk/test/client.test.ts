// The client core against a stub fetch (cli-and-sdk plan §4.2): retries, idempotency, errors, redirects, logging,
// feature checks.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isVideoAgentError, VideoAgent, VideoAgentError } from '../src/index.js'
import { VERSION } from '../src/version.js'

const URL_ = 'https://va.example.com'
const KEY = 'nva_test_key'
type Seen = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  redirect: string
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A fetch that answers from a queue (a function, a Response, or an Error to throw) and records each request. */
function stub(...answers: (Response | Error | ((s: Seen) => Response))[]) {
  const seen: Seen[] = []
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const s: Seen = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect ?? 'follow',
    }
    seen.push(s)
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a instanceof Error) throw a
    if (typeof a === 'function') return a(s)
    // A fresh copy each time: cancelling a clone's body would wait on the original's.
    const r = a ?? json(500, {})
    return new Response(await r.clone().text(), { status: r.status, headers: r.headers })
  }
  return { f: f, seen }
}
const config = (features: string[] = ['remix', 'planning'], commit = 'abc123') =>
  json(200, { version: { commit, promptTemplate: 16, release: null }, features })

describe('client core', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const run = async <T>(p: Promise<T>) => {
    const out = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    )
    await vi.runAllTimersAsync()
    return out
  }

  it('sends the key, the User-Agent and never follows redirects', async () => {
    const { f, seen } = stub(json(200, { id: 'v_1' }))
    const va = new VideoAgent({ url: `${URL_}/`, apiKey: KEY, fetch: f, userAgent: 'release-bot/1.2' })
    await va.videos.get('v_1')
    expect(seen[0]).toMatchObject({
      url: `${URL_}/api/v1/videos/v_1`,
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${KEY}`,
        'user-agent': `netlify-video-agent-sdk/${VERSION} (+release-bot/1.2)`,
      },
    })
  })

  it('reads url and key from the environment, and refuses a missing url', () => {
    vi.stubEnv('VIDEO_AGENT_URL', URL_)
    vi.stubEnv('VIDEO_AGENT_KEY', KEY)
    expect(new VideoAgent({ fetch: stub().f }).url).toBe(URL_)
    vi.stubEnv('VIDEO_AGENT_URL', '')
    expect(() => new VideoAgent({ fetch: stub().f })).toThrow(VideoAgentError)
    vi.unstubAllEnvs()
  })

  it('retries GETs on network errors, 5xx and 429 (Retry-After, capped at 60 s)', async () => {
    const { f, seen } = stub(
      new TypeError('fetch failed'),
      json(503, {}),
      json(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'retry-after': '600' }),
      json(200, { id: 'v_1' }),
    )
    const va = new VideoAgent({ url: URL_, apiKey: KEY, fetch: f })
    const p = va.videos.get('v_1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(seen).toHaveLength(3)
    // The 429 came within 1.5 s (two jittered backoffs); its 600 s Retry-After is capped at 60 s.
    await vi.advanceTimersByTimeAsync(57_000)
    expect(seen).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await p).toEqual({ id: 'v_1' })
    expect(seen).toHaveLength(4)
  })

  it('gives up after `retries` and reports the last error', async () => {
    const { f, seen } = stub(json(502, { error: { code: 'bad_gateway', message: 'Down' } }))
    const r = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: f, retries: 2 }).videos.get('v_1'))
    expect(seen).toHaveLength(3)
    expect(r.ok || isVideoAgentError(r.e, 'bad_gateway')).toBe(true)
  })

  it('create sends one Idempotency-Key and the same bytes on every retry; a 409 is reported, not retried', async () => {
    const { f, seen } = stub(
      json(503, {}),
      json(409, { error: { code: 'conflict', message: 'Key reused with another body' } }),
    )
    const va = new VideoAgent({ url: URL_, apiKey: KEY, fetch: f })
    const r = await run(va.videos.create({ prompt: 'A launch video', aspect: '16:9' }))
    expect(seen).toHaveLength(2)
    const [a, b] = seen
    expect(a?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(b?.headers['idempotency-key']).toBe(a?.headers['idempotency-key'])
    expect(b?.body).toBe(a?.body)
    expect(a?.body).toBe(JSON.stringify({ prompt: 'A launch video', aspect: '16:9' }))
    expect(!r.ok && isVideoAgentError(r.e, 'conflict')).toBe(true)
  })

  it('uses the caller’s Idempotency-Key, and never retries a POST without one', async () => {
    const first = stub(json(200, { id: 'v_1' }))
    await new VideoAgent({ url: URL_, apiKey: KEY, fetch: first.f }).videos.create(
      { prompt: 'A launch video' },
      { idempotencyKey: 'mine' },
    )
    expect(first.seen[0]?.headers['idempotency-key']).toBe('mine')
    const { f, seen } = stub(json(503, {}))
    const r = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: f }).versions.publish('v_1', 1))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.headers['idempotency-key']).toBeUndefined()
    expect(!r.ok && isVideoAgentError(r.e)).toBe(true)
  })

  it('maps errors: code, message, status, request id, Retry-After; non-JSON bodies too', async () => {
    const { f } = stub(
      json(404, { error: { code: 'not_found', message: 'No such video.' } }, { 'x-nf-request-id': '01REQ' }),
    )
    const r = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: f }).videos.get('v_x'))
    expect(r.ok ? null : r.e).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'No such video.',
      requestId: '01REQ',
    })
    const html = stub(new Response('<html>Bad gateway</html>', { status: 400 }))
    const r2 = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: html.f }).videos.get('v_x'))
    expect(r2.ok ? null : r2.e).toMatchObject({ status: 400, code: 'http_400' })
  })

  it('a network failure that outlasts the retries is code network', async () => {
    const { f } = stub(new TypeError('getaddrinfo ENOTFOUND'))
    const r = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: f, retries: 1 }).videos.get('v_1'))
    expect(r.ok ? null : r.e).toMatchObject({ status: 0, code: 'network' })
  })

  it('logs one event per attempt with no headers, bodies or keys', async () => {
    const events: [string, Record<string, unknown>][] = []
    const { f } = stub(json(500, {}), json(200, { id: 'v_1' }, { 'x-nf-request-id': 'r2' }))
    const va = new VideoAgent({ url: URL_, apiKey: KEY, fetch: f, logger: (e, x) => events.push([e, x]) })
    await run(va.videos.create({ prompt: 'secret prompt text' }))
    expect(events.map(([, x]) => Object.keys(x).sort())).toEqual([
      ['attempt', 'method', 'ms', 'path', 'requestId', 'status'],
      ['attempt', 'method', 'ms', 'path', 'requestId', 'status'],
    ])
    expect(events[1]?.[1]).toMatchObject({
      method: 'POST',
      path: '/api/v1/videos',
      status: 200,
      attempt: 2,
      requestId: 'r2',
    })
    const all = JSON.stringify(events)
    expect(all).not.toContain('nva_')
    expect(all).not.toContain('secret prompt')
  })

  it('fetches config once for many gated calls, and refuses a feature the server lacks', async () => {
    const { f, seen } = stub((s) =>
      s.url.endsWith('/api/v1/config') ? config(['planning']) : json(200, { id: 'p' }),
    )
    const va = new VideoAgent({ url: URL_, apiKey: KEY, fetch: f })
    await Promise.all([
      va.plans.create({ prompt: 'A video about webhooks' }),
      va.plans.get('p_1'),
      va.plans.get('p_2'),
    ])
    expect(seen.filter((s) => s.url.endsWith('/config'))).toHaveLength(1)
    const r = await run(va.videos.remix('v_1', { prompt: 'Make it orange' }))
    expect(r.ok ? null : r.e).toMatchObject({
      code: 'unsupported_by_server',
      status: 0,
      message: "This server (abc123) doesn't support remix. Update the deployment.",
    })
    // A field a feature added: refused before anything is sent.
    const before = seen.length
    const r2 = await run(va.videos.create({ prompt: 'A launch video', planId: 'p_1' }))
    expect(r2.ok).toBe(true)
    expect(seen.length).toBe(before + 1)
  })

  it('a server older than features supports nothing gated', async () => {
    const { f } = stub((s) => (s.url.endsWith('/config') ? json(200, { siteUrl: URL_ }) : json(200, {})))
    const r = await run(
      new VideoAgent({ url: URL_, apiKey: KEY, fetch: f }).videos.remix('v_1', { prompt: 'Again' }),
    )
    expect(r.ok ? null : r.e).toMatchObject({
      code: 'unsupported_by_server',
      message: expect.stringContaining('(unknown)'),
    })
  })

  it('a client without a key sends no Authorization', async () => {
    vi.stubEnv('VIDEO_AGENT_KEY', '')
    const { f, seen } = stub(config())
    expect((await new VideoAgent({ url: URL_, fetch: f }).serverConfig()).features).toEqual([
      'remix',
      'planning',
    ])
    expect(seen[0]?.headers.authorization).toBeUndefined()
    vi.unstubAllEnvs()
  })

  it('raw reaches every route with the same auth, retries and errors', async () => {
    const { f, seen } = stub(json(500, {}), json(200, { videos: 1 }))
    const va = new VideoAgent({ url: URL_, apiKey: KEY, fetch: f })
    const r = await run(va.raw.GET('/api/v1/stats'))
    expect(r.ok && r.v.data).toEqual({ videos: 1 })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ redirect: 'manual', headers: { authorization: `Bearer ${KEY}` } })
    const err = stub(json(403, { error: { code: 'forbidden', message: 'Admins only.' } }))
    const r2 = await run(new VideoAgent({ url: URL_, apiKey: KEY, fetch: err.f }).raw.GET('/api/v1/stats'))
    expect(!r2.ok && isVideoAgentError(r2.e, 'forbidden')).toBe(true)
  })

  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
  })
})
