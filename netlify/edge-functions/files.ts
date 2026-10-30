// Signed, private file delivery: /files/{jobId}/v{n}/{file}?exp=&sig= (minted by the API, 10 minutes).
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { CONTENT_TYPES, mediaResponse, verifySignedPath } from '../../src/lib/media/range.ts'

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })

export default async (req: Request, context: Context) => {
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true') return notFound()
  const url = new URL(req.url)
  const m = /^\/files\/(vid_[a-z0-9]+)\/v(\d+)\/(video\.mp4|poster\.jpg|preview\.gif|captions\.vtt)$/.exec(url.pathname)
  if (!m) return notFound()
  const internal = getStore({ name: 'internal', consistency: 'strong' })
  const cfg = (await internal.get('edge-config.json', { type: 'json' })) as { fileSigningSecret?: string } | null
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig') ?? ''
  if (!cfg?.fileSigningSecret || !(await verifySignedPath(cfg.fileSigningSecret, url.pathname, exp, sig, Date.now() / 1000))) {
    return new Response('This link has expired. Open the video again to get a fresh one.', { status: 403, headers: { 'cache-control': 'no-store' } })
  }
  const key = `${m[1]}/v${m[2]}/${m[3]}`
  const videos = getStore({ name: 'videos', consistency: 'strong' })
  const meta = await videos.getMetadata(key)
  if (!meta) return notFound()
  const size = Number((meta.metadata as Record<string, string>).size)
  const ext = m[3]?.split('.').pop() ?? ''
  const headers: Record<string, string> = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }
  if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="${m[1]}-v${m[2]}-${m[3]}"`
  return mediaResponse(
    req,
    { size, etag: meta.etag ?? null, open: async () => (await videos.get(key, { type: 'stream' })) as ReadableStream<Uint8Array> | null },
    CONTENT_TYPES[ext] ?? 'application/octet-stream',
    headers,
  )
}

export const config: Config = { path: '/files/*', method: ['GET', 'HEAD'] }
