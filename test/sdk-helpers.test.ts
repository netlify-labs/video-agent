// The SDK's hand-written helpers against the real routes (cli-and-sdk plan §4.2 Waiting, §4.1 videos row): wait,
// listAll, resolve. Each poll of the video moves the fake run one sweep tick, so a wait walks the real lifecycle.
import { describe, expect, it } from 'vitest'
import { isVideoAgentError, VideoAgent, type WaitProgress } from '../packages/sdk/src/index.js'
import { waitForVideo } from '../packages/sdk/src/helpers/videos.js'
import { failedSnap, running, succeeded } from './fakes.js'
import { apiKey, harness, PROMPT, type Harness } from './helpers.js'

/** The default run (it uploads the files), stepping through these snapshots. */
const withTimeline = (h: Harness, timeline: ReturnType<typeof running>[]) => {
  h.deps.runner.defaultScript = ((orig) => (req: Parameters<typeof orig>[0]) => ({ ...orig(req), timeline }))(
    h.deps.runner.defaultScript,
  )
}

const sdk = async (h: Harness, o: { drive?: boolean } = {}) => {
  const seen: { method: string; path: string; status: number; inm: boolean }[] = []
  const va = new VideoAgent({
    url: 'https://video.example.com',
    apiKey: await apiKey(h, h.member),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      const path = new URL(req.url).pathname
      if (o.drive && req.method === 'GET' && /^\/api\/v1\/videos\/[^/]+$/.test(path)) await h.drive(1)
      const res = await h.app.fetch(req, { context: { deploy: { published: true } } })
      seen.push({ method: req.method, path, status: res.status, inm: req.headers.has('if-none-match') })
      return res
    },
  })
  return { va, seen }
}

describe('SDK helpers in process', () => {
  it('wait follows queued → running → ready, reports each change once, and uses 304s', async () => {
    const h = harness()
    withTimeline(h, [
      running(),
      running('running', 'Writing the composition'),
      running('running', 'Rendering'),
      succeeded(),
    ])
    const { va, seen } = await sdk(h, { drive: true })
    const v = await va.videos.create({ prompt: PROMPT })
    const changes: WaitProgress[] = []
    const ready = await va.videos.wait(v.id, { intervalMs: 0, onProgress: (p) => changes.push(p) })
    expect(ready.versions.find((x) => x.n === 1)?.status).toBe('ready')
    expect(changes[0]).toMatchObject({ version: 1 })
    expect(changes.at(-1)).toMatchObject({ version: 1, status: 'ready' })
    // One callback per distinct state, never two in a row the same.
    for (let i = 1; i < changes.length; i++) expect(changes[i]).not.toEqual(changes[i - 1])
    expect(changes.some((c) => c.step === 'Rendering')).toBe(true)
    const polls = seen.filter((s) => s.path === `/api/v1/videos/${v.id}`)
    expect(polls.slice(1).every((p) => p.inm)).toBe(true)
    expect(polls.some((p) => p.status === 304)).toBe(true)
  })

  it('wait reads /progress only while the version runs', async () => {
    // The real create kicks the queue at once, so the queued phase is a stub here.
    const statuses = ['queued', 'queued', 'running', 'ready']
    let progressCalls = 0
    const calls: string[] = []
    const video = (status: string) => ({
      latestVersion: 1,
      versions: [{ n: 1, status, stage: null, latestStep: null, error: null }],
    })
    await waitForVideo(
      {
        send: async () => {
          const status = statuses.shift() ?? 'ready'
          calls.push(status)
          return Response.json(video(status), { headers: { etag: `"${status}"` } })
        },
        progress: async () => {
          progressCalls++
          calls.push('progress')
          return { versionN: 1, stage: 'authoring', step: 'Writing' } as never
        },
      },
      'vid_0001',
      { intervalMs: 0 },
    )
    expect(calls).toEqual(['queued', 'queued', 'running', 'progress', 'ready'])
    expect(progressCalls).toBe(1)
  })

  it('wait throws video_failed when the version fails', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const { va } = await sdk(h, { drive: true })
    const v = await va.videos.create({ prompt: PROMPT })
    const e = await va.videos.wait(v.id, { intervalMs: 0 }).catch((x: unknown) => x)
    expect(isVideoAgentError(e, 'video_failed')).toBe(true)
    expect((e as { details: { status: string } }).details.status).toMatch(/failed|timed_out/)
  })

  it('wait gives up with wait_timeout, and stops on abort', async () => {
    const h = harness()
    const { va } = await sdk(h)
    const v = await va.videos.create({ prompt: PROMPT })
    const t = await va.videos.wait(v.id, { intervalMs: 5, timeoutMs: 20 }).catch((x: unknown) => x)
    expect(isVideoAgentError(t, 'wait_timeout')).toBe(true)
    const ac = new AbortController()
    const p = va.videos.wait(v.id, { intervalMs: 50, signal: ac.signal }).catch((x: unknown) => x)
    ac.abort(new Error('stopped by the caller'))
    expect(((await p) as Error).message).toBe('stopped by the caller')
  })

  it('listAll walks every page', async () => {
    const h = harness()
    const { va } = await sdk(h)
    for (let i = 0; i < 5; i++) await va.videos.create({ prompt: `${PROMPT} ${i}` })
    const ids: string[] = []
    for await (const v of va.videos.listAll({ limit: 2 })) ids.push(v.id)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    const viaTop: string[] = []
    for await (const v of va.listAll(va.videos.list, { limit: 3 })) viaTop.push(v.id)
    expect(viaTop.sort()).toEqual([...ids].sort())
    // A list without a cursor isn't pageable.
    // @ts-expect-error media.recordings answers { items } with no nextCursor
    void va.listAll(va.media.recordings, {})
  })
})

describe('videos.resolve', () => {
  const share = (answer: Response) => {
    const calls: Request[] = []
    const va = new VideoAgent({
      url: 'https://video.example.com',
      apiKey: 'nva_secret',
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(new Request(input, init))
        return answer.clone()
      },
    })
    return { va, calls }
  }

  it('takes ids and web URLs without a request', async () => {
    const { va, calls } = share(new Response('{}'))
    expect(await va.videos.resolve('vid_0001')).toEqual({ id: 'vid_0001' })
    expect(await va.videos.resolve('https://video.example.com/videos/vid_0001')).toEqual({ id: 'vid_0001' })
    expect(await va.videos.resolve('https://video.example.com/videos/vid_0001/edit/3')).toEqual({
      id: 'vid_0001',
      versionN: 3,
    })
    expect(calls).toHaveLength(0)
  })

  it('reads a share URL through its public JSON, without the key', async () => {
    const { va, calls } = share(Response.json({ video_agent: { videoId: 'vid_0042', versionN: 2 } }))
    expect(await va.videos.resolve('https://elsewhere.example.org/v/abcdefgh')).toEqual({
      id: 'vid_0042',
      versionN: 2,
    })
    expect(calls[0]?.url).toBe('https://elsewhere.example.org/v/abcdefgh.json')
    expect(calls[0]?.headers.get('authorization')).toBeNull()
  })

  it('an unpublished share URL is not_found; anything else is invalid_ref', async () => {
    const gone = share(Response.json({ error: 'not_found' }, { status: 404 }))
    expect(
      isVideoAgentError(
        await gone.va.videos.resolve('https://x.example/v/abcdefgh').catch((e: unknown) => e),
        'not_found',
      ),
    ).toBe(true)
    for (const bad of ['hello', 'https://x.example/settings', 'ftp://x/v/abcdefgh'])
      expect(
        isVideoAgentError(await gone.va.videos.resolve(bad).catch((e: unknown) => e), 'invalid_ref'),
        bad,
      ).toBe(true)
  })
})
