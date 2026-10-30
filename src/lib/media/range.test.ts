import { describe, expect, it } from 'vitest'
import { signPath } from '../crypto.js'
import { mediaResponse, parseRange, sliceStream, verifySignedPath } from './range.js'

const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256))
const chunked = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 64) c.enqueue(bytes.slice(i, i + 64))
      c.close()
    },
  })
const collect = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer())

describe('parseRange', () => {
  it('handles full, open-ended, closed, suffix and invalid ranges', () => {
    expect(parseRange(null, 1000)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=0-', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ kind: 'partial', start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=0-1,5-6', 1000)).toEqual({ kind: 'full' })
  })
})

describe('sliceStream', () => {
  it.each([
    [0, 999],
    [100, 199],
    [63, 64],
    [999, 999],
  ])('returns exactly bytes %i-%i across chunk boundaries', async (start, end) => {
    expect(await collect(sliceStream(chunked(), start, end))).toEqual(bytes.slice(start, end + 1))
  })
})

describe('mediaResponse', () => {
  const src = { size: 1000, etag: '"e1"', open: async () => chunked() }
  it('serves 206 with Content-Range, 416 when out of range, and HEAD without a body', async () => {
    const r206 = await mediaResponse(
      new Request('https://x/', { headers: { range: 'bytes=10-19' } }),
      src,
      'video/mp4',
      {},
    )
    expect(r206.status).toBe(206)
    expect(r206.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect(r206.headers.get('content-length')).toBe('10')
    expect(new Uint8Array(await r206.arrayBuffer())).toEqual(bytes.slice(10, 20))
    const r416 = await mediaResponse(
      new Request('https://x/', { headers: { range: 'bytes=2000-' } }),
      src,
      'video/mp4',
      {},
    )
    expect(r416.status).toBe(416)
    expect(r416.headers.get('content-range')).toBe('bytes */1000')
    const head = await mediaResponse(new Request('https://x/', { method: 'HEAD' }), src, 'video/mp4', {})
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('1000')
    expect(head.body).toBeNull()
  })
})

describe('verifySignedPath (edge) matches signPath (API)', () => {
  it('accepts a valid signature and rejects expired or tampered ones', async () => {
    const path = '/files/vid_1/v1/video.mp4'
    const sig = signPath('secret', path, 2000)
    expect(await verifySignedPath('secret', path, 2000, sig, 1000)).toBe(true)
    expect(await verifySignedPath('secret', path, 2000, sig, 2001)).toBe(false)
    expect(await verifySignedPath('secret', '/files/vid_2/v1/video.mp4', 2000, sig, 1000)).toBe(false)
    expect(await verifySignedPath('other', path, 2000, sig, 1000)).toBe(false)
  })
})
