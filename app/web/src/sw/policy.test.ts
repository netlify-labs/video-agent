import { describe, expect, it } from 'vitest'
import { LIMITS, cacheKey, cacheableResponse, parseRange, pickEvictions } from './policy'

const O = 'https://video.example'
const get = (path: string, init: { method?: string; cache?: string } = {}) => ({
  url: O + path,
  method: init.method ?? 'GET',
  cache: init.cache ?? 'default',
})
const signed = (file: string, q = 'exp=1700000000&sig=abc') => `/files/vid_01abc/v2/${file}?${q}`

describe('cacheKey', () => {
  it('keys a signed version file by its path, so every signature window shares one entry', () => {
    const a = cacheKey(get(signed('poster-480.avif', 'exp=1&sig=a')), O)
    const b = cacheKey(get(signed('poster-480.avif', 'exp=2&e=3&sig=b')), O)
    expect(a).toBe(`${O}/files/vid_01abc/v2/poster-480.avif`)
    expect(b).toBe(a)
  })

  it('takes posters, their small variants, the GIF and the hover clip', () => {
    for (const f of [
      'poster.jpg',
      'preview.gif',
      'poster-480.webp',
      'poster-960.webp',
      'poster-480.avif',
      'poster-960.avif',
      'clip.webm',
      'clip.mp4',
    ])
      expect(cacheKey(get(signed(f)), O), f).not.toBeNull()
  })

  it('leaves the full video, captions and unknown files to the network', () => {
    for (const f of ['video.mp4', 'captions.vtt', 'poster-720.webp', 'clip.mov', 'poster.jpg/x'])
      expect(cacheKey(get(signed(f)), O), f).toBeNull()
  })

  it('needs a signature and never takes downloads', () => {
    expect(cacheKey(get('/files/vid_01abc/v2/poster.jpg'), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg', 'exp=1')), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg', 'sig=a')), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg', 'exp=1&sig=a&download=1')), O)).toBeNull()
  })

  it('only answers same-origin GETs that may use a cache', () => {
    expect(
      cacheKey({ ...get(signed('poster.jpg')), url: 'https://other.example' + signed('poster.jpg') }, O),
    ).toBeNull()
    expect(cacheKey(get(signed('poster.jpg'), { method: 'HEAD' }), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg'), { cache: 'no-store' }), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg'), { cache: 'reload' }), O)).toBeNull()
    expect(cacheKey(get(signed('poster.jpg'), { cache: 'no-cache' }), O)).not.toBeNull()
  })

  it('ignores the API, share pages, previews and the media library', () => {
    for (const p of [
      '/api/v1/videos/vid_01abc/versions/2/poster?exp=1&sig=a',
      '/v/abc234.jpg?exp=1&sig=a',
      '/preview/vid_01abc/v2/1.x.sig/index.html?exp=1&sig=a',
      '/media/med_01234567/file?exp=1&sig=a',
      '/files/../api/v1/me?exp=1&sig=a',
    ])
      expect(cacheKey(get(p), O), p).toBeNull()
  })
})

describe('cacheableResponse', () => {
  const res = (
    status: number,
    headers: Record<string, string>,
    more: { type?: string; redirected?: boolean } = {},
  ) => ({
    status,
    type: more.type ?? 'basic',
    redirected: more.redirected ?? false,
    headers: new Headers(headers),
  })
  const ok = { 'content-length': '5000', 'cache-control': 'private, max-age=1800, immutable' }

  it('keeps a full 200 the edge served after its signature check', () => {
    expect(cacheableResponse(res(200, ok))).toBe(true)
  })

  it('never keeps partial, refused, missing, revalidation or redirected responses', () => {
    expect(cacheableResponse(res(206, ok))).toBe(false)
    expect(cacheableResponse(res(403, ok))).toBe(false)
    expect(cacheableResponse(res(404, ok))).toBe(false)
    expect(cacheableResponse(res(304, ok))).toBe(false)
    expect(cacheableResponse(res(200, ok, { redirected: true }))).toBe(false)
    expect(cacheableResponse(res(200, ok, { type: 'opaque' }))).toBe(false)
  })

  it('respects no-store and needs a known size within the per-entry limit', () => {
    expect(cacheableResponse(res(200, { ...ok, 'cache-control': 'private, no-store' }))).toBe(false)
    expect(cacheableResponse(res(200, { 'cache-control': 'private' }))).toBe(false)
    expect(cacheableResponse(res(200, { 'content-length': '0' }))).toBe(false)
    expect(cacheableResponse(res(200, { 'content-length': String(LIMITS.maxEntryBytes) }))).toBe(true)
    expect(cacheableResponse(res(200, { 'content-length': String(LIMITS.maxEntryBytes + 1) }))).toBe(false)
  })
})

describe('parseRange', () => {
  it('reads one bytes range, clamped to the body', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(parseRange('bytes=10-500', 100)).toEqual({ start: 10, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('says when a range is past the end', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  it("returns null for headers it doesn't handle, which get the whole body", () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('bytes=5-3', 100)).toBeNull()
  })
})

describe('pickEvictions', () => {
  const e = (key: string, bytes = 1) => ({ key, bytes })

  it('evicts nothing within the limits', () => {
    expect(pickEvictions([e('a'), e('b')], { maxEntries: 2, maxBytes: 10 })).toEqual([])
  })

  it('evicts the oldest entries beyond the count', () => {
    expect(pickEvictions([e('a'), e('b'), e('c'), e('d')], { maxEntries: 2, maxBytes: 100 })).toEqual([
      'a',
      'b',
    ])
  })

  it('evicts the oldest entries beyond the size, however few there are', () => {
    expect(pickEvictions([e('a', 6), e('b', 3), e('c', 4)], { maxEntries: 10, maxBytes: 8 })).toEqual(['a'])
    expect(pickEvictions([e('a', 1), e('b', 1), e('c', 9)], { maxEntries: 10, maxBytes: 8 })).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})
