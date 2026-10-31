// Published versions: /v/{slug} share page, and /v/{slug}.mp4 | .jpg | .gif | .vtt.
// Every request checks the publication, so unpublishing takes effect immediately (no caching in v1).
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { CONTENT_TYPES, mediaResponse } from '../../src/lib/media/range.ts'

interface Mirror {
  slug: string
  title: string
  width: number
  height: number
  durationSec: number
  keys: { video: string; poster: string; gif: string; captions: string }
}

const NO_STORE = { 'cache-control': 'no-store' }
const notFound = () =>
  new Response('<!doctype html><title>Not found</title><p>This video is not published.</p>', {
    status: 404,
    headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' },
  })
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true')
    return notFound()
  const url = new URL(req.url)
  const m = /^\/v\/([a-z2-9]{6,32})(?:\.(mp4|jpg|gif|vtt))?$/.exec(url.pathname)
  if (!m?.[1]) return notFound()
  const slug = m[1]
  const ext = m[2]
  const pub = (await getStore({ name: 'internal', consistency: 'strong' }).get(`pub/${slug}.json`, {
    type: 'json',
  })) as Mirror | null
  if (!pub) return notFound()

  if (ext) {
    const key = { mp4: pub.keys.video, jpg: pub.keys.poster, gif: pub.keys.gif, vtt: pub.keys.captions }[
      ext as 'mp4'
    ]
    const videos = getStore({ name: 'videos', consistency: 'strong' })
    const meta = await videos.getMetadata(key)
    if (!meta) return notFound()
    return mediaResponse(
      req,
      {
        size: Number((meta.metadata as Record<string, string>).size),
        etag: meta.etag ?? null,
        open: async () => (await videos.get(key, { type: 'stream' })) as ReadableStream<Uint8Array> | null,
      },
      CONTENT_TYPES[ext] ?? 'application/octet-stream',
      { ...NO_STORE, 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
    )
  }

  const base = `${url.origin}/v/${slug}`
  const title = esc(pub.title || 'Video')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${title}">
<meta property="og:url" content="${base}"><meta property="og:image" content="${base}.jpg">
<meta property="og:video" content="${base}.mp4"><meta property="og:video:secure_url" content="${base}.mp4">
<meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="${pub.width}"><meta property="og:video:height" content="${pub.height}">
<meta name="twitter:card" content="player"><meta name="twitter:title" content="${title}"><meta name="twitter:image" content="${base}.jpg">
<meta name="twitter:player" content="${base}"><meta name="twitter:player:width" content="${pub.width}"><meta name="twitter:player:height" content="${pub.height}">
<link rel="alternate" type="application/json+oembed" href="${base}.json">
<style>:root{color-scheme:dark light}html,body{margin:0;height:100%;background:#0b0d10;color:#e6e8eb;font:16px/1.5 system-ui,sans-serif}
main{min-height:100%;display:grid;place-items:center;padding:16px;box-sizing:border-box}figure{margin:0;max-width:min(100%,calc(85vh*${pub.width}/${pub.height}))}
video{width:100%;height:auto;border-radius:12px;background:#000;display:block}figcaption{margin-top:12px;opacity:.8}</style></head>
<body><main><figure><video controls playsinline preload="metadata" poster="${base}.jpg" src="${base}.mp4" width="${pub.width}" height="${pub.height}">
<track kind="captions" src="${base}.vtt" srclang="en" label="Captions"></video><figcaption>${title}</figcaption></figure></main></body></html>`
  return new Response(html, { headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' } })
}

// GET and HEAD only (the manifest can't list HEAD, so the method check is in the handler).
export const config: Config = { path: '/v/*' }
