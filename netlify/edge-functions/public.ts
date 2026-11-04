// Published versions: /v/{slug} share page, and /v/{slug}.mp4 | .jpg | .gif | .vtt | .webp (the 960w poster, when the
// version has one) | .mp3 (recorded narration) | .txt (its transcript, only when the publisher chose to show it).
// Every request checks the publication, so unpublishing takes effect immediately (no caching in v1).
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { CONTENT_TYPES, mediaResponse } from '../../src/lib/media/range.ts'
import { creditHtml, type CreditLine } from '../../src/lib/credit-html.ts'
import { denyMicrophone } from '../../src/lib/permissions-policy.ts'

interface Mirror {
  slug: string
  jobId: string
  versionN: number
  title: string
  width: number
  height: number
  durationSec: number
  keys: {
    video: string
    poster: string
    gif: string
    captions: string
    narration?: string
    transcript?: string
  }
  /** CC BY media the version was made with (absent on mirrors written before credits). */
  credits?: CreditLine[]
  /** The publisher chose to offer the transcript (absent: no). */
  showTranscript?: boolean
}

const NO_STORE = { 'cache-control': 'no-store' }
const notFound = () =>
  new Response('<!doctype html><title>Not found</title><p>This video is not published.</p>', {
    status: 404,
    headers: denyMicrophone({ ...NO_STORE, 'content-type': 'text/html; charset=utf-8' }),
  })
/**
 * The share page's only script (docs/plans/2026-11-03-remix.md §3.7): a signed-in teammate who can remix sees "Remix in
 * Video Agent". The page is the same for everyone (no database here), so the browser asks the app who's viewing, and
 * only when the app's non-secret va_creator hint cookie is there, so the public's views never call the API. Never in
 * an embed (the page is also the twitter:player iframe).
 */
const REMIX_SCRIPT = `<script>(function(){try{if(window.top!==window||!/(?:^|; )va_creator=1(?:;|$)/.test(document.cookie))return;var o={credentials:'same-origin'};Promise.all([fetch('/api/v1/me',o),fetch('/api/v1/config',o)]).then(function(r){return r[0].ok&&r[1].ok?Promise.all([r[0].json(),r[1].json()]):null}).then(function(x){if(!x||!x[1].remixEnabled||(x[0].role!=='admin'&&x[0].role!=='creator'))return;var a=document.querySelector('[data-remix]');if(a)a.hidden=false}).catch(function(){})}catch(e){}})()</script>`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true')
    return notFound()
  const url = new URL(req.url)
  const m = /^\/v\/([a-z2-9]{6,32})(?:\.(mp4|jpg|gif|vtt|webp|mp3|txt))?$/.exec(url.pathname)
  if (!m?.[1]) return notFound()
  const slug = m[1]
  const ext = m[2]
  const pub = (await getStore({ name: 'internal', consistency: 'strong' }).get(`pub/${slug}.json`, {
    type: 'json',
  })) as Mirror | null
  if (!pub) return notFound()
  const videos = getStore({ name: 'videos', consistency: 'strong' })
  // Preview variants sit next to the version's other files; older versions have none (404, and no WebP poster).
  const webpKey = `${pub.jobId}/v${pub.versionN}/poster-960.webp`
  // The transcript is published only with the publisher's consent, separate from the audio's (plan 2026-11-02 §6.7).
  const transcriptKey = pub.showTranscript ? pub.keys.transcript : undefined

  if (ext) {
    const key = {
      mp4: pub.keys.video,
      jpg: pub.keys.poster,
      gif: pub.keys.gif,
      vtt: pub.keys.captions,
      webp: webpKey,
      mp3: pub.keys.narration,
      txt: transcriptKey,
    }[ext as 'mp4']
    if (!key) return notFound()
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
  const poster = (await videos.getMetadata(webpKey)) ? `${base}.webp` : `${base}.jpg`
  const credits = Array.isArray(pub.credits) && pub.credits.length ? creditHtml(pub.credits) : ''
  const transcript = transcriptKey ? await transcriptHtml(videos, transcriptKey, `${base}.txt`) : ''
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
video{width:100%;height:auto;border-radius:12px;background:#000;display:block}figcaption{margin-top:12px;opacity:.8}
.credits{display:block;margin-top:4px;font-size:13px;opacity:.75}.credits a{color:inherit}.remix{display:inline-block;margin-top:12px;font-size:14px;color:inherit;opacity:.85}.remix[hidden]{display:none}
details{margin-top:12px}summary{cursor:pointer}details p{margin:8px 0;max-width:70ch}details a{color:inherit;font-size:13px}</style></head>
<body><main><figure><video controls playsinline preload="metadata" poster="${poster}" src="${base}.mp4" width="${pub.width}" height="${pub.height}">
<track kind="captions" src="${base}.vtt" srclang="en" label="Captions"></video><figcaption>${title}${credits ? `<small class="credits" data-credits>${credits}</small>` : ''}</figcaption>${transcript}<a class="remix" data-remix hidden href="/videos/${esc(pub.jobId)}?remix=${pub.versionN}">Remix in Video Agent</a></figure></main>${REMIX_SCRIPT}</body></html>`
  // The share page is also the embed player (twitter:player): it never gets the microphone.
  return new Response(html, {
    headers: denyMicrophone({ ...NO_STORE, 'content-type': 'text/html; charset=utf-8' }),
  })
}

/** The transcript as a closed disclosure: a paragraph per caption cue, escaped, with a link to the text file. */
async function transcriptHtml(
  videos: ReturnType<typeof getStore>,
  key: string,
  href: string,
): Promise<string> {
  const text = (await videos.get(key, { type: 'text' })) as string | null
  const paragraphs = (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paragraphs.length) return ''
  return `<details data-transcript><summary>Transcript</summary>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}<a href="${href}" download>Download the transcript</a></details>`
}

// GET and HEAD only (the manifest can't list HEAD, so the method check is in the handler).
export const config: Config = { path: '/v/*' }
