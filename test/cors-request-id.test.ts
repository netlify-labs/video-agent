// API-key clients on allowed origins can read the headers the SDK needs, and errors log Netlify's request id
// (cli-and-sdk plan §4.2 Errors, §5.1 item 4).
import { describe, expect, it } from 'vitest'
import { apiKey, harness } from './helpers.js'

const APP = 'https://app.acme.com'
const env = { ALLOWED_ORIGINS: APP }

describe('CORS headers and request ids', () => {
  it('preflight allows If-None-Match for videos.wait', async () => {
    const h = harness(env)
    const res = await h.call('OPTIONS', '/api/v1/videos/v_1', { origin: APP })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('if-none-match')
  })

  it('a keyed request from an allowed origin exposes request id, etag, retry-after and location', async () => {
    const h = harness(env)
    const key = await apiKey(h, h.member)
    for (const path of ['/api/v1/videos', '/api/v1/videos/v_missing']) {
      const res = await h.call('GET', path, { key, origin: APP })
      expect(res.headers.get('access-control-allow-origin')).toBe(APP)
      expect(res.headers.get('access-control-expose-headers')).toBe(
        'x-nf-request-id,etag,retry-after,location',
      )
    }
  })

  it('cookie requests get no CORS headers', async () => {
    const h = harness(env)
    const res = await h.call('GET', '/api/v1/videos', { as: h.member, origin: APP })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-expose-headers')).toBeNull()
  })

  it("logs an API error with Netlify's request id", async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const res = await h.call('GET', '/api/v1/videos/v_missing', {
      key,
      origin: null,
      headers: { 'x-nf-request-id': '01REQ' },
    })
    expect(res.status).toBe(404)
    const line = h.deps.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'api.error')
    expect(line).toMatchObject({ code: 'not_found', status: 404, requestId: '01REQ', method: 'GET' })
  })
})
