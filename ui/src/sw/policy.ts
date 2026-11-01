// What the media service worker (sw.ts) may cache, under which key, and what it evicts. Pure, so it's unit tested.
//
// A version's files never change once written, so the bytes behind /files/{job}/v{n}/{file} are the same for every
// signed URL. The cache is keyed by that path without the signature, which changes every window. Only small, signed,
// successful same-origin GETs are cached: the full video (large, played with Range requests) and downloads go to the
// network as before.

/** Bump the version to drop every entry written by an older worker. */
export const CACHE_PREFIX = 'va-media-'
export const CACHE_NAME = `${CACHE_PREFIX}v1`

export const LIMITS = {
  /** Posters are tens of kB, clips and GIFs a few MB. */
  maxEntryBytes: 10 * 1024 * 1024,
  maxEntries: 400,
  maxBytes: 150 * 1024 * 1024,
}

const CACHEABLE =
  /^\/files\/vid_[a-z0-9]+\/v\d+\/(?:poster\.jpg|preview\.gif|poster-(?:480|960)\.(?:webp|avif)|clip\.(?:webm|mp4))$/

/** The stable cache key for a request the worker may answer, or null to leave it to the network. */
export function cacheKey(
  req: { url: string; method: string; cache?: string },
  origin: string,
): string | null {
  if (req.method !== 'GET') return null
  // A page that asks to bypass caches gets the network.
  if (req.cache === 'no-store' || req.cache === 'reload') return null
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return null
  }
  if (url.origin !== origin || !CACHEABLE.test(url.pathname)) return null
  const q = url.searchParams
  // Only the signed URLs the API hands out (not the redirect route), and never a download (it has its own headers).
  if (!q.get('exp') || !q.get('sig') || q.has('download')) return null
  return url.origin + url.pathname
}

/** True for a response the edge served in full after its signature check: 200, same-origin, a known small size. */
export function cacheableResponse(res: {
  status: number
  type: string
  redirected: boolean
  headers: { get(name: string): string | null }
}): boolean {
  if (res.status !== 200 || res.type !== 'basic' || res.redirected) return false
  if (/no-store/i.test(res.headers.get('cache-control') ?? '')) return false
  const length = Number(res.headers.get('content-length') ?? NaN)
  return Number.isInteger(length) && length > 0 && length <= LIMITS.maxEntryBytes
}

export type ByteRange = { start: number; end: number }

/**
 * One `bytes=` range against a body of `size` bytes: the inclusive span, 'unsatisfiable' (answer 416), or null for a
 * header this doesn't handle (several ranges, other units), which the caller answers with the whole body.
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a = '', b = ''] = m
  if (!a && !b) return null
  if (!a) {
    // The last N bytes.
    const n = Number(b)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b ? Math.min(Number(b), size - 1) : size - 1
  // A last byte before the first makes the header invalid, which is ignored like an unknown one.
  if (b && Number(b) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

/** Which entries to delete, oldest first (the cache lists keys in insertion order), to fit the limits. */
export function pickEvictions(
  entries: { key: string; bytes: number }[],
  limits: { maxEntries: number; maxBytes: number } = LIMITS,
): string[] {
  let count = entries.length
  let bytes = entries.reduce((n, e) => n + e.bytes, 0)
  const out: string[] = []
  for (const e of entries) {
    if (count <= limits.maxEntries && bytes <= limits.maxBytes) break
    out.push(e.key)
    count--
    bytes -= e.bytes
  }
  return out
}
