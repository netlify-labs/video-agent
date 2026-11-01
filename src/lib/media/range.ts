// HTTP Range handling for streamed blobs. Web APIs only: shared by both edge functions (Deno).

export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' }

/** Parses a single `bytes=` range against a known size. Multiple ranges fall back to the full body. */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'full' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return { kind: 'full' }
  const [, a = '', b = ''] = m
  if (a === '' && b === '') return { kind: 'full' }
  let start: number
  let end: number
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start >= size || start > end) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end }
}

/** Returns a stream of bytes [start, end] from a source stream, skipping what comes before. */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let pos = 0
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || pos > end) {
          controller.close()
          await reader.cancel().catch(() => undefined)
          return
        }
        const chunkStart = pos
        pos += value.byteLength
        if (pos <= start) continue
        const from = Math.max(0, start - chunkStart)
        const to = Math.min(value.byteLength, end - chunkStart + 1)
        controller.enqueue(value.subarray(from, to))
        if (pos > end) {
          controller.close()
          await reader.cancel().catch(() => undefined)
        }
        return
      }
    },
    cancel() {
      return reader.cancel()
    },
  })
}

export const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  vtt: 'text/vtt; charset=utf-8',
  webp: 'image/webp',
  avif: 'image/avif',
  webm: 'video/webm',
}

export interface MediaSource {
  size: number
  etag: string | null
  open(): Promise<ReadableStream<Uint8Array> | null>
}

/** Weak comparison (RFC 9110 §8.8.3.2) of an If-None-Match header against an entity tag. */
export function etagMatches(header: string | null, etag: string | null): boolean {
  if (!header || !etag) return false
  const opaque = (t: string) => t.trim().replace(/^W\//, '')
  return header.split(',').some((t) => t.trim() === '*' || opaque(t) === opaque(etag))
}

/** Builds the response for GET/HEAD with Range and If-None-Match support. Callers check access first. */
export async function mediaResponse(
  req: Request,
  src: MediaSource,
  contentType: string,
  headers: Record<string, string>,
): Promise<Response> {
  if (src.etag && etagMatches(req.headers.get('if-none-match'), src.etag))
    return new Response(null, { status: 304, headers: { ...headers, etag: src.etag } })
  const base: Record<string, string> = { 'content-type': contentType, 'accept-ranges': 'bytes', ...headers }
  if (src.etag) base.etag = src.etag
  const range = parseRange(req.headers.get('range'), src.size)
  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${src.size}` } })
  }
  const status = range.kind === 'partial' ? 206 : 200
  const length = range.kind === 'partial' ? range.end - range.start + 1 : src.size
  const h: Record<string, string> = { ...base, 'content-length': String(length) }
  if (range.kind === 'partial') h['content-range'] = `bytes ${range.start}-${range.end}/${src.size}`
  if (req.method === 'HEAD') return new Response(null, { status, headers: h })
  const stream = await src.open()
  if (!stream) return new Response('Not found', { status: 404 })
  const body = range.kind === 'partial' ? sliceStream(stream, range.start, range.end) : stream
  return new Response(body, { status, headers: h })
}

/** HMAC-SHA256 hex with WebCrypto (same output as lib/crypto.ts signPath). */
export async function hmacHexWeb(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifySignedPath(
  secret: string,
  path: string,
  exp: number,
  sig: string,
  nowSec: number,
  epoch?: number,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp < nowSec || !/^[0-9a-f]{64}$/.test(sig)) return false
  const expected = await hmacHexWeb(secret, `${path}\n${exp}${epoch === undefined ? '' : `\ne${epoch}`}`)
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

/** What the files edge function knows about a job's access (the `access/{jobId}.json` mirror in the internal store). */
export interface AccessMirror {
  private: boolean
  epoch: number
}

/**
 * Decides whether a signed file URL may be served (plan v2 §14 rule 4). URLs for private videos carry the job's
 * access epoch (`e`); a URL issued before the video went private, or before its last privacy or owner change, is
 * revoked. Public videos keep working with plain signed URLs.
 */
export async function verifyFileUrl(
  secret: string,
  path: string,
  params: URLSearchParams,
  nowSec: number,
  access: AccessMirror | null,
): Promise<'ok' | 'invalid' | 'revoked'> {
  const exp = Number(params.get('exp'))
  const sig = params.get('sig') ?? ''
  const eParam = params.get('e')
  const epoch = eParam === null ? undefined : Number(eParam)
  if (epoch !== undefined && !Number.isInteger(epoch)) return 'invalid'
  if (!(await verifySignedPath(secret, path, exp, sig, nowSec, epoch))) return 'invalid'
  if (access?.private && epoch !== access.epoch) return 'revoked'
  return 'ok'
}
