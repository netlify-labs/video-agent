// Signed, private file delivery: /files/{jobId}/v{n}/{file}?exp=[&e=]&sig= (minted by the API, at most an hour).
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { CONTENT_TYPES, mediaResponse, verifyFileUrl, type AccessMirror } from '../../src/lib/media/range.ts'

/** The longest URL lifetime the API mints (public videos, one hour). */
const MAX_AGE_SEC = 3600

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true')
    return notFound()
  const url = new URL(req.url)
  const m = /^\/files\/(vid_[a-z0-9]+)\/v(\d+)\/(video\.mp4|poster\.jpg|preview\.gif|captions\.vtt)$/.exec(
    url.pathname,
  )
  if (!m) return notFound()
  const internal = getStore({ name: 'internal', consistency: 'strong' })
  const cfg = (await internal.get('edge-config.json', { type: 'json' })) as {
    fileSigningSecret?: string
  } | null
  // Private videos: URLs carry the job's access epoch; older links stop working after a privacy or owner change.
  const access = (await internal.get(`access/${m[1]}.json`, { type: 'json' })) as AccessMirror | null
  const verdict = cfg?.fileSigningSecret
    ? await verifyFileUrl(cfg.fileSigningSecret, url.pathname, url.searchParams, Date.now() / 1000, access)
    : 'invalid'
  if (verdict !== 'ok') {
    return new Response('This link has expired. Open the video again to get a fresh one.', {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    })
  }
  const key = `${m[1]}/v${m[2]}/${m[3]}`
  const videos = getStore({ name: 'videos', consistency: 'strong' })
  const meta = await videos.getMetadata(key)
  if (!meta) return notFound()
  const size = Number((meta.metadata as Record<string, string>).size)
  const ext = m[3]?.split('.').pop() ?? ''
  // A version's files never change once written, so the browser may keep them while the signature is valid. Only
  // the browser ("private"): a shared cache would skip the access check above.
  const maxAge = Math.min(MAX_AGE_SEC, Math.floor(Number(url.searchParams.get('exp')) - Date.now() / 1000))
  const headers: Record<string, string> = {
    'cache-control': maxAge > 0 ? `private, max-age=${maxAge}, immutable` : 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
  if (url.searchParams.get('download') === '1')
    headers['content-disposition'] = `attachment; filename="${m[1]}-v${m[2]}-${m[3]}"`
  return mediaResponse(
    req,
    {
      size,
      etag: meta.etag ?? null,
      open: async () => (await videos.get(key, { type: 'stream' })) as ReadableStream<Uint8Array> | null,
    },
    CONTENT_TYPES[ext] ?? 'application/octet-stream',
    headers,
  )
}

// GET and HEAD only (the manifest can't list HEAD, so the method check is in the handler).
export const config: Config = { path: '/files/*' }
