// Redo a scene in the SDK (regenerate-beat plan §4.13): revise's scope, the redoScenes helper (fromVersion from the
// latest ready version, one Idempotency-Key) and versions.beats, refused before sending against a server without
// scoped_revision.
import { describe, expect, it } from 'vitest'
import { redoScenes } from '../src/helpers/videos.js'
import { isVideoAgentError, VideoAgent } from '../src/index.js'

const URL_ = 'https://va.example.com'
type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const video = {
  id: 'vid_1',
  versions: [
    { n: 3, status: 'running' },
    { n: 2, status: 'ready' },
    { n: 1, status: 'ready' },
  ],
}

/** A server answering config with these features, the video above, and 202 to a revise. */
function server(features: string[]) {
  const seen: Seen[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    seen.push({ url, method, headers, body: typeof init?.body === 'string' ? init.body : null })
    if (url.endsWith('/api/v1/config'))
      return json(200, { version: { commit: 'abc123', promptTemplate: 17, release: null }, features })
    if (url.endsWith('/beats')) return json(200, { beats: [] })
    return method === 'POST' ? json(202, video) : json(200, video)
  }
  const va = new VideoAgent({ url: URL_, apiKey: 'nva_test', fetch })
  const deps = { get: (id: string) => va.videos.get(id), revise: va.videos.revise }
  return { va, deps, seen, posts: () => seen.filter((s) => s.method === 'POST') }
}

describe('redo a scene in the SDK', () => {
  it('revise sends scope with fromVersion', async () => {
    const { va, posts } = server(['scoped_revision'])
    await va.videos.revise('vid_1', { prompt: 'Brighter.', fromVersion: 2, scope: { beats: ['demo'] } })
    expect(JSON.parse(posts()[0]?.body ?? '')).toEqual({
      prompt: 'Brighter.',
      fromVersion: 2,
      scope: { beats: ['demo'] },
    })
  })

  it('redoScenes fills fromVersion from the latest ready version and sends an Idempotency-Key', async () => {
    const { deps, seen, posts } = server(['scoped_revision'])
    await redoScenes(deps, 'vid_1', { beats: ['intro', 'demo'], prompt: 'Faster.', commentIds: ['c_1'] })
    expect(seen.some((s) => s.method === 'GET' && s.url.endsWith('/api/v1/videos/vid_1'))).toBe(true)
    const [post] = posts()
    expect(JSON.parse(post?.body ?? '')).toEqual({
      prompt: 'Faster.',
      commentIds: ['c_1'],
      fromVersion: 2,
      scope: { beats: ['intro', 'demo'] },
    })
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    // The same through va.videos.redoScenes.
    const viaClient = server(['scoped_revision'])
    await viaClient.va.videos.redoScenes('vid_1', { beats: ['demo'], prompt: 'Faster.' })
    expect(JSON.parse(viaClient.posts()[0]?.body ?? '')).toMatchObject({
      fromVersion: 2,
      scope: { beats: ['demo'] },
    })
    // A given fromVersion is used as is, without reading the video.
    const again = server(['scoped_revision'])
    await redoScenes(
      again.deps,
      'vid_1',
      { beats: ['demo'], prompt: 'Again.', fromVersion: 1 },
      { idempotencyKey: 'k' },
    )
    expect(again.seen.filter((s) => s.method === 'GET' && s.url.endsWith('/vid_1'))).toHaveLength(0)
    expect(again.posts()[0]?.headers['idempotency-key']).toBe('k')
    expect(JSON.parse(again.posts()[0]?.body ?? '')).toMatchObject({ fromVersion: 1 })
  })

  it('refuses scope, redoScenes and versions.beats without scoped_revision, sending nothing', async () => {
    const { va, deps, seen, posts } = server(['planning'])
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => null,
        (x: unknown) => x,
      )
      expect(isVideoAgentError(e, 'unsupported_by_server')).toBe(true)
      expect((e as Error).message).toContain('scoped_revision')
    }
    await refused(va.videos.revise('vid_1', { prompt: 'x', fromVersion: 2, scope: { beats: ['demo'] } }))
    await refused(redoScenes(deps, 'vid_1', { beats: ['demo'], prompt: 'x', fromVersion: 2 }))
    await refused(va.versions.beats('vid_1', 2))
    expect(posts()).toEqual([])
    expect(seen.filter((s) => s.url.endsWith('/beats'))).toEqual([])
  })

  it('says so when there is no ready version', async () => {
    const { posts } = server(['scoped_revision'])
    const e = await redoScenes(
      {
        get: async () => ({ ...video, versions: [{ n: 1, status: 'failed' }] }) as never,
        revise: async () => video as never,
      },
      'vid_1',
      { beats: ['demo'], prompt: 'x' },
    ).catch((x: unknown) => x)
    expect(isVideoAgentError(e, 'not_ready')).toBe(true)
    expect(posts()).toEqual([])
  })
})
