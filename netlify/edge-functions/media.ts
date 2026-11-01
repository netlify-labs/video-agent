// Signed media delivery: /media/{id}/{file|original|poster}?exp=&sig= (minted by the API, 10 minutes; plan v2 §9).
// Fixed MIME from what the upload was verified as, nosniff, Range for clips. "file" is the copy runs use (the
// sanitized one for SVGs); "original" is always a download.
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { mediaResponse, verifySignedPath } from '../../src/lib/media/range.ts'

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } })

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true')
    return plain(404, 'Not found')
  const url = new URL(req.url)
  const m = /^\/media\/(med_[a-z0-9]{8,40})\/(file|original|poster)$/.exec(url.pathname)
  if (!m?.[1] || !m[2]) return plain(404, 'Not found')
  const internal = getStore({ name: 'internal', consistency: 'strong' })
  const cfg = (await internal.get('edge-config.json', { type: 'json' })) as {
    fileSigningSecret?: string
  } | null
  const ok =
    !!cfg?.fileSigningSecret &&
    (await verifySignedPath(
      cfg.fileSigningSecret,
      url.pathname,
      Number(url.searchParams.get('exp')),
      url.searchParams.get('sig') ?? '',
      Date.now() / 1000,
    ))
  if (!ok) return plain(403, 'This link has expired. Open the media library again to get a fresh one.')

  const store = getStore({ name: 'media', consistency: 'strong' })
  const meta = (await store.get(`${m[1]}/meta.json`, { type: 'json' })) as Record<
    string,
    string | null
  > | null
  const key = meta?.[m[2]]
  if (!key) return plain(404, 'Not found')
  const blob = await store.getMetadata(key)
  if (!blob) return plain(404, 'Not found')
  const md = blob.metadata as Record<string, string>
  const type = md.contentType ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'cache-control': 'private, max-age=600',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Even a sanitized SVG never runs anything or loads anything when opened directly.
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  }
  if (m[2] === 'original' || md.disposition === 'attachment')
    headers['content-disposition'] =
      `attachment; filename="${(md.filename ?? 'download').replace(/["\\\r\n]/g, '')}"`
  return mediaResponse(
    req,
    {
      size: Number(md.size),
      etag: blob.etag ?? null,
      open: async () => (await store.get(key, { type: 'stream' })) as ReadableStream<Uint8Array> | null,
    },
    type,
    headers,
  )
}

export const config: Config = { path: '/media/*' }
