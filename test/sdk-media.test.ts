// media.upload against the real media routes and the fakes' assembly (cli-and-sdk plan §4.1 media row, gotcha 16),
// and music.importAndWait against a stub server.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importMusicAndWait } from '../packages/sdk/src/helpers/media.js'
import { isVideoAgentError, VideoAgent, type UploadProgress } from '../packages/sdk/src/index.js'
import { PART_SIZE } from '../src/domain/media-uploads.js'
import { apiKey, harness, type Harness } from './helpers.js'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
/** The fixture clip padded with a trailing `free` box: still a valid MP4, big enough for three parts. */
function bigClip(total = 9 * 1024 * 1024) {
  const clip = fixture('a169.mp4')
  const out = new Uint8Array(total)
  out.set(clip)
  new DataView(out.buffer).setUint32(clip.byteLength, total - clip.byteLength)
  out.set(new TextEncoder().encode('free'), clip.byteLength + 4)
  return out
}

type Seen = { method: string; path: string; status: number; sha?: string | null; bytes: number }
const sdk = async (
  h: Harness,
  intercept?: (req: Request, n: number) => 'drop-before' | 'drop-after' | null,
) => {
  const seen: Seen[] = []
  const logs: Record<string, unknown>[] = []
  let n = 0
  const va = new VideoAgent({
    url: 'https://video.example.com',
    apiKey: await apiKey(h, h.member),
    logger: (_e, f) => logs.push(f),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      const path = new URL(req.url).pathname
      const body =
        req.method === 'PUT' || req.method === 'POST' ? await req.clone().arrayBuffer() : new ArrayBuffer(0)
      const what = intercept?.(req, n++) ?? null
      if (what === 'drop-before') throw new TypeError('socket hang up')
      const res = await h.app.fetch(req, { context: { deploy: { published: true } } })
      seen.push({
        method: req.method,
        path,
        status: res.status,
        sha: req.headers.get('x-part-sha256'),
        bytes: body.byteLength,
      })
      if (what === 'drop-after') throw new TypeError('socket hang up')
      return res
    },
  })
  return { va, seen, logs }
}
const parts = (seen: Seen[]) => seen.filter((s) => s.method === 'PUT' && s.path.includes('/parts/'))

describe('media.upload', () => {
  it('a small file is one POST and waits for ready', async () => {
    const h = harness()
    const { va, seen } = await sdk(h)
    const item = await va.media.upload(fixture('a169.mp4'), {
      filename: 'clip.mp4',
      caption: 'A clip',
      pollIntervalMs: 0,
    })
    expect(item).toMatchObject({ status: 'ready', filename: 'clip.mp4' })
    expect(seen.filter((s) => s.method === 'POST' && s.path === '/api/v1/media')).toHaveLength(1)
    expect(parts(seen)).toHaveLength(0)
  })

  it('a file already in the library is returned without uploading', async () => {
    const h = harness()
    const { va, seen } = await sdk(h)
    const first = await va.media.upload(fixture('a169.mp4'), { filename: 'clip.mp4', pollIntervalMs: 0 })
    const before = seen.length
    const again = await va.media.upload(fixture('a169.mp4'), {
      filename: 'other-name.mp4',
      pollIntervalMs: 0,
    })
    expect(again.id).toBe(first.id)
    expect(seen.slice(before).map((s) => s.path)).toEqual(['/api/v1/media/check'])
  })

  it('a 9 MB file goes in three hashed parts, reports monotonic progress, and reaches ready', async () => {
    const h = harness()
    const { va, seen, logs } = await sdk(h)
    const file = bigClip()
    const progress: UploadProgress[] = []
    const item = await va.media.upload(file, {
      filename: 'big.mp4',
      pollIntervalMs: 0,
      onProgress: (p) => progress.push(p),
    })
    expect(item.status).toBe('ready')
    const sent = parts(seen)
    expect(sent.map((s) => s.bytes)).toEqual([PART_SIZE, PART_SIZE, file.byteLength - 2 * PART_SIZE])
    sent.forEach((s, i) => {
      const slice = file.subarray(i * PART_SIZE, (i + 1) * PART_SIZE)
      expect(s.sha).toBe(createHash('sha256').update(slice).digest('hex'))
    })
    const bytes = progress.map((p) => p.sent)
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b))
    expect(progress.at(-1)).toMatchObject({ sent: file.byteLength, phase: 'done' })
    expect(logs.filter((l) => l.uploadId && l.index !== undefined)).toHaveLength(3)
  })

  it('resumes: a part lost before the server sends again; a part the server got is not sent twice', async () => {
    const h = harness()
    let putN = 0
    const { va, seen } = await sdk(h, (req) => {
      if (req.method !== 'PUT') return null
      putN++
      if (putN === 2) return 'drop-before'
      if (putN === 4) return 'drop-after'
      return null
    })
    const item = await va.media.upload(bigClip(), { filename: 'big.mp4', pollIntervalMs: 0 })
    expect(item.status).toBe('ready')
    // Part 1 lost before arriving → sent again; part 2 arrived but its answer was lost → the session lists it.
    expect(parts(seen).map((s) => Number(s.path.split('/').pop()))).toEqual([0, 1, 2])
    expect(seen.some((s) => s.method === 'GET' && /\/media\/uploads\/[^/]+$/.test(s.path))).toBe(true)
  })

  it('a rejected item throws media_rejected with the reason', async () => {
    const h = harness()
    const { va } = await sdk(h)
    const e = await va.media
      .upload(fixture('truncated.mp4'), { filename: 'bad.mp4', pollIntervalMs: 0 })
      .catch((x: unknown) => x)
    expect(isVideoAgentError(e, 'media_rejected') || isVideoAgentError(e, 'invalid_request')).toBe(true)
  })

  it('an abort cancels the session', async () => {
    const h = harness()
    const ac = new AbortController()
    const { va, seen } = await sdk(h, (req) => {
      if (req.method === 'PUT') ac.abort(new Error('stopped'))
      return null
    })
    await expect(va.media.upload(bigClip(), { filename: 'big.mp4', signal: ac.signal })).rejects.toThrow(
      'stopped',
    )
    expect(seen.some((s) => s.method === 'DELETE' && s.path.startsWith('/api/v1/media/uploads/'))).toBe(true)
  })
})

describe('music.importAndWait', () => {
  const media = { id: 'med_1', status: 'ready' }
  const stub = (answers: Response[]) => {
    const urls: string[] = []
    return {
      urls,
      d: {
        retries: 0,
        send: async (x: { url: string }) => {
          urls.push(x.url)
          const r = answers.shift()
          if (!r) throw new Error('no more answers')
          return r
        },
      },
    }
  }

  it('returns an import that finished at once', async () => {
    const { d } = stub([Response.json(media, { status: 201 })])
    expect(await importMusicAndWait(d, { id: 'ov_1' })).toEqual(media)
  })

  it('follows a 202 job to done, and to failed', async () => {
    const ok = stub([
      Response.json({ id: 'job_1', status: 'queued', media: null }, { status: 202 }),
      Response.json({ id: 'job_1', status: 'running', media: null }),
      Response.json({ id: 'job_1', status: 'done', media }),
    ])
    expect(await importMusicAndWait(ok.d, { id: 'ov_1' }, { pollIntervalMs: 0 })).toEqual(media)
    expect(ok.urls.slice(1)).toEqual([
      '/api/v1/media/openverse/jobs/job_1',
      '/api/v1/media/openverse/jobs/job_1',
    ])
    const bad = stub([
      Response.json({ id: 'job_2', status: 'queued', media: null }, { status: 202 }),
      Response.json({
        id: 'job_2',
        status: 'failed',
        media: null,
        error: { code: 'licence', message: 'Not CC0 or CC BY' },
      }),
    ])
    const e = await importMusicAndWait(bad.d, { id: 'ov_2' }, { pollIntervalMs: 0 }).catch((x: unknown) => x)
    expect(isVideoAgentError(e, 'music_import_failed')).toBe(true)
    expect((e as Error).message).toContain('Not CC0 or CC BY')
  })
})

describe('config helpers', () => {
  it('get and supports read the cached config', async () => {
    const h = harness()
    const { va, seen } = await sdk(h)
    expect(await va.config.supports('remix')).toBe(true)
    expect(await va.config.supports('looks')).toBe(false)
    expect((await va.config.get()).features).toContain('remix')
    expect(seen.filter((s) => s.path === '/api/v1/config')).toHaveLength(1)
  })
})
