// The uploader's recording options in a Node test (plan 2026-11-02 §5.1): with the recorder's sha256 the file is never
// read whole, a recording always uses a session with its role and video, peaks and speech follow the parts, and
// waitReady polls with backoff until the item is ready or rejected. The API client is a fake.
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  method: string
  path: string
  init: { params?: { path?: Record<string, unknown> }; body?: unknown }
}
const api = vi.hoisted(() => ({
  calls: [] as Call[],
  media: [] as { status: string; rejectReason?: string | null }[],
}))

vi.mock('../api/client', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'upl_1',
    filename: 'take.wav',
    size: 0,
    partSize: 4 * 1024 * 1024,
    partCount: 1,
    uploaded: [],
    status: 'open',
    mediaId: null,
    error: null,
    expiresAt: '',
    role: 'narration-take',
    scopeJobId: 'job_1',
    ...over,
  })
  const handle =
    (method: string) =>
    async (path: string, init: Call['init'] = {}) => {
      api.calls.push({ method, path, init })
      const ok = (data: unknown) => ({
        data,
        error: undefined,
        response: new Response(null, { status: 200 }),
      })
      if (path === '/api/v1/media/uploads') {
        const b = init.body as { size: number }
        return ok(session({ size: b.size, partCount: Math.ceil(b.size / (4 * 1024 * 1024)) }))
      }
      if (path === '/api/v1/media/uploads/{id}/parts/{index}')
        return ok({ idx: 0, sha256: 'x', duplicate: false })
      if (path === '/api/v1/media/uploads/{id}/complete')
        return ok(session({ status: 'done', mediaId: 'med_1' }))
      if (path === '/api/v1/media/{id}' && method === 'GET') {
        const m = api.media.shift() ?? { status: 'verifying' }
        return ok({ id: 'med_1', rejectReason: null, ...m })
      }
      return ok({})
    }
  return { fetchClient: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT') } }
})

const { uploadFile, waitReady } = await import('./upload')

beforeEach(() => {
  api.calls = []
  api.media = []
})

describe('uploadFile for recordings', () => {
  it('skips whole-file hashing when the sha256 is given, and sends role, video, peaks and speech', async () => {
    const f = new File([new Uint8Array(6 * 1024 * 1024).fill(3)], 'take.wav', { type: 'audio/wav' })
    const whole = vi.spyOn(f, 'arrayBuffer')
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const peaks = new Uint8Array([1, 2, 3])
    const id = await uploadFile(f, {
      sha256: 'c'.repeat(64),
      role: 'narration-take',
      scopeJobId: 'job_1',
      userId: 'u_1',
      extra: { peaks, speech: { version: 1, spans: [[0, 10]] } },
    })
    expect(id).toBe('med_1')
    // Never read whole: only the two parts were hashed (each read on its own via slice).
    expect(whole).not.toHaveBeenCalled()
    expect(digest).toHaveBeenCalledTimes(2)
    for (const c of digest.mock.calls)
      expect((c[1] as ArrayBuffer).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
    const start = api.calls.find((c) => c.path === '/api/v1/media/uploads')
    expect(start?.init.body).toMatchObject({
      sha256: 'c'.repeat(64),
      role: 'narration-take',
      scopeJobId: 'job_1',
    })
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/media/uploads',
      'PUT /api/v1/media/uploads/{id}/parts/{index}',
      'PUT /api/v1/media/uploads/{id}/parts/{index}',
      'POST /api/v1/media/uploads/{id}/complete',
      'PUT /api/v1/media/{id}/peaks',
      'PUT /api/v1/media/{id}/speech',
    ])
    expect(api.calls[4]?.init.body).toBe(peaks)
    digest.mockRestore()
  })

  it('a small recording still uses a session (the single-request upload refuses roles)', async () => {
    const f = new File([new Uint8Array(1000)], 'take.wav', { type: 'audio/wav' })
    await uploadFile(f, { sha256: 'd'.repeat(64), role: 'narration-upload', scopeJobId: 'job_1' })
    expect(api.calls.some((c) => c.path === '/api/v1/media')).toBe(false)
    expect(api.calls[0]?.path).toBe('/api/v1/media/uploads')
  })

  it('without a sha256, hashes the file as before', async () => {
    const f = new File([new Uint8Array(5 * 1024 * 1024)], 'clip.mp4', { type: 'application/octet-stream' })
    const whole = vi.spyOn(f, 'arrayBuffer')
    await uploadFile(f)
    expect(whole).toHaveBeenCalledTimes(1)
  })
})

describe('waitReady', () => {
  it('polls with backoff until the item is ready', async () => {
    api.media = [
      { status: 'verifying' },
      { status: 'verifying' },
      { status: 'verifying' },
      { status: 'ready' },
    ]
    const waits: number[] = []
    const m = await waitReady('med_1', { wait: async (ms) => void waits.push(ms) })
    expect(m.status).toBe('ready')
    expect(waits).toEqual([250, 500, 1000])
  })

  it('throws the reason when the item is rejected', async () => {
    api.media = [
      { status: 'verifying' },
      { status: 'rejected', rejectReason: 'Audio files must be 10 minutes or shorter.' },
    ]
    await expect(waitReady('med_1', { wait: async () => undefined })).rejects.toThrow(/10 minutes or shorter/)
  })

  it('gives up after the timeout, and stops when aborted', async () => {
    await expect(waitReady('med_1', { timeoutMs: 1000, wait: async () => undefined })).rejects.toThrow(
      /taking too long/,
    )
    const ac = new AbortController()
    ac.abort()
    await expect(waitReady('med_1', { signal: ac.signal })).rejects.toThrow(/Stopped waiting/)
  })
})
