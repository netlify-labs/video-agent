// files.url and files.download against the real file routes (cli-and-sdk plan §4.1 files row, §4.2 Redirects). The
// storage host is a stub that records what reached it: never the key.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isVideoAgentError, VideoAgent } from '../../packages/sdk/src/index.js'
import { apiKey, harness, readyVideo, type Harness } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

const SITE = 'https://video.example.com'

const sdk = async (h: Harness, storage: (req: Request) => Response = () => new Response('MP4BYTES')) => {
  const api: Request[] = []
  const stored: Request[] = []
  const va = new VideoAgent({
    url: SITE,
    apiKey: await apiKey(h, h.member),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      if (new URL(req.url).pathname.startsWith('/api/')) {
        api.push(req)
        return appFetch(h, req)
      }
      stored.push(req)
      return storage(req)
    },
  })
  return { va, api, stored }
}

describe('SDK files', () => {
  it('poster and GIF come from the DTO with no request', async () => {
    const h = harness()
    const { va, api } = await sdk(h)
    const video = await va.videos.get(await readyVideo(h, h.member))
    const before = api.length
    const poster = await va.files.url(video, { file: 'poster' })
    expect(poster).toMatch(/^https:\/\/video\.example\.com\//)
    expect(poster).toContain('exp=')
    await va.files.url(video, { file: 'gif' })
    expect(api.length).toBe(before)
  })

  it('the video follows the 302 once, and the storage host never sees the key', async () => {
    const h = harness()
    const { va, api, stored } = await sdk(h)
    const id = await readyVideo(h, h.member)
    const url = await va.files.url(id, { file: 'video' })
    const route = api.find((r) => r.url.endsWith(`/versions/1/video`))
    expect(route?.redirect).toBe('manual')
    expect(url.startsWith(SITE)).toBe(true)
    const res = await va.files.download(id, { file: 'video' })
    expect(await res.text()).toBe('MP4BYTES')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.headers.get('authorization')).toBeNull()
  })

  it('downloads to a path through a temp file and a rename', async () => {
    const h = harness()
    const { va } = await sdk(h)
    const dir = mkdtempSync(join(tmpdir(), 'va-sdk-'))
    const to = join(dir, 'out.mp4')
    const r = await va.files.download(await readyVideo(h, h.member), { file: 'video', to })
    expect(r).toEqual({ path: to, bytes: 8 })
    expect(readFileSync(to, 'utf8')).toBe('MP4BYTES')
    expect(readdirSync(dir)).toEqual(['out.mp4'])
  })

  it('a download that breaks halfway leaves no file', async () => {
    const h = harness()
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('half'))
            c.error(new Error('connection reset'))
          },
        }),
      )
    const { va } = await sdk(h, broken)
    const dir = mkdtempSync(join(tmpdir(), 'va-sdk-'))
    const to = join(dir, 'out.mp4')
    await expect(va.files.download(await readyVideo(h, h.member), { file: 'video', to })).rejects.toThrow(
      'connection reset',
    )
    expect(existsSync(to)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a missing file is the route error; a failed storage fetch is download_failed', async () => {
    const h = harness()
    const { va } = await sdk(h, () => new Response('gone', { status: 403 }))
    const id = await readyVideo(h, h.member)
    await expect(va.files.url(id, { file: 'narration-audio' })).rejects.toMatchObject({ status: 404 })
    const e = await va.files.download(id, { file: 'captions' }).catch((x: unknown) => x)
    expect(isVideoAgentError(e, 'download_failed')).toBe(true)
  })
})
