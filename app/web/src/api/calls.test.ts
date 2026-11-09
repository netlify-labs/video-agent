// The API calls recorder behind the API calls drawer: what it records, the curl it builds, and matching a call to its
// operation in the spec.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCalls, curlFor, getCalls, loadOperations, recordCall } from './calls'

/** Calls are recorded once their copied body has been read, a moment after the response. */
const settled = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  clearCalls()
  vi.unstubAllGlobals()
})

describe('API calls', () => {
  it('records each call newest first, with the JSON body it sent', async () => {
    const send = (req: Request) =>
      Promise.resolve(new Response('{}', { status: req.method === 'POST' ? 201 : 200 }))
    await recordCall(new Request('https://va.test/api/v1/videos?limit=24'), send)
    await recordCall(
      new Request('https://va.test/api/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: "It's launch day" }),
      }),
      send,
    )
    await settled()
    const [post, get] = getCalls()
    expect(get).toMatchObject({ method: 'GET', path: '/api/v1/videos?limit=24', status: 200, body: null })
    expect(post).toMatchObject({ method: 'POST', path: '/api/v1/videos', status: 201 })
    expect(post?.body).toBe('{"prompt":"It\'s launch day"}')
    expect(curlFor(post!, 'https://va.test')).toBe(
      [
        "curl -X POST 'https://va.test/api/v1/videos'",
        '-H "Authorization: Bearer $VIDEO_AGENT_API_KEY"',
        "-H 'Content-Type: application/json'",
        `-d '{"prompt":"It'\\''s launch day"}'`,
      ].join(' \\\n  '),
    )
  })

  it('records a call that got no response, and still throws', async () => {
    const send = () => Promise.reject(new TypeError('offline'))
    await expect(recordCall(new Request('https://va.test/api/v1/me'), send)).rejects.toThrow('offline')
    await settled()
    expect(getCalls()[0]).toMatchObject({ path: '/api/v1/me', status: null })
  })

  it('leaves out bodies that are not JSON (uploads)', async () => {
    const send = () => Promise.resolve(new Response(null, { status: 204 }))
    await recordCall(
      new Request('https://va.test/api/v1/media', { method: 'PUT', body: new Uint8Array([1, 2, 3]) }),
      send,
    )
    await settled()
    expect(getCalls()[0]?.body).toBeNull()
  })

  it('matches a call to its operation, path parameters included', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({
          paths: {
            '/api/v1/videos': { get: { summary: 'List videos' } },
            '/api/v1/videos/{id}/versions/{n}/publish': { post: { summary: 'Publish a version' } },
          },
        }),
      ),
    )
    const ops = await loadOperations()
    const find = (method: string, path: string) =>
      ops.find((o) => o.method === method && o.pattern.test(path))?.summary
    expect(find('POST', '/api/v1/videos/vid_1/versions/2/publish')).toBe('Publish a version')
    expect(find('GET', '/api/v1/videos')).toBe('List videos')
    expect(find('GET', '/api/v1/videos/vid_1')).toBeUndefined()
  })
})
