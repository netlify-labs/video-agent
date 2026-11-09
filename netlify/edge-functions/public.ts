// Published versions: /v/{slug} share page, and /v/{slug}.mp4 | .jpg | .gif | .vtt | .webp (the 960w poster, when the
// version has one) | .mp3 (recorded narration) | .txt (its transcript, only when the publisher chose to show it) |
// .hover.mp4 (the silent hover clip, when the version has one) | .json (the oEmbed the page advertises, plus what the
// <video-agent-player> needs; cli-and-sdk plan §5.3). Every request checks the publication, so unpublishing takes
// effect immediately (the JSON is cached for a minute at most).
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { CONTENT_TYPES, mediaResponse } from '../../app/server/lib/media/range.ts'
import { creditHtml, embedHtml, type CreditLine } from '../../app/server/lib/credit-html.ts'
import { contextMeta } from '../../app/server/generated/context.ts'
import { denyMicrophone } from '../../app/server/lib/permissions-policy.ts'

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
    /** The 960w WebP poster; null: none. Missing on older mirrors: the render's poster-960.webp, when it exists. */
    posterWebp?: string | null
    /** The silent hover clip; null or missing: none (or a mirror written before it). */
    hover?: string | null
  }
  /** The poster's blurred placeholder (a data URL); null or missing: none (or a mirror written before it). */
  lqip?: string | null
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
  const m = /^\/v\/([a-z2-9]{6,32})(?:\.(hover\.mp4|mp4|jpg|gif|vtt|webp|mp3|txt|json))?$/.exec(url.pathname)
  if (!m?.[1]) return notFound()
  const slug = m[1]
  const ext = m[2]
  const pub = (await getStore({ name: 'internal', consistency: 'strong' }).get(`pub/${slug}.json`, {
    type: 'json',
  })) as Mirror | null
  if (ext === 'json') return oembed(req, url, slug, pub)
  if (!pub) return notFound()
  const videos = getStore({ name: 'videos', consistency: 'strong' })
  // Preview variants sit next to the version's other files; older versions have none (404, and no WebP poster). A
  // picked poster names its own, or null when the browser that made it couldn't encode WebP.
  const webpKey = webpKeyOf(pub)
  // The transcript is published only with the publisher's consent, separate from the audio's (plan 2026-11-02 §6.7).
  const transcriptKey = pub.showTranscript ? pub.keys.transcript : undefined

  if (ext) {
    const key = {
      mp4: pub.keys.video,
      jpg: pub.keys.poster,
      gif: pub.keys.gif,
      vtt: pub.keys.captions,
      webp: webpKey ?? undefined,
      mp3: pub.keys.narration,
      txt: transcriptKey,
      'hover.mp4': pub.keys.hover ?? undefined,
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
      CONTENT_TYPES[ext === 'hover.mp4' ? 'mp4' : ext] ?? 'application/octet-stream',
      { ...NO_STORE, 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
    )
  }

  const base = `${url.origin}/v/${slug}`
  const title = esc(pub.title || 'Video')
  const poster = webpKey && (await videos.getMetadata(webpKey)) ? `${base}.webp` : `${base}.jpg`
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

const JSON_HEADERS = {
  'content-type': 'application/json+oembed; charset=utf-8',
  'access-control-allow-origin': '*',
}

/** The 960w WebP poster's key: a picked poster's own (or null), else the render's for mirrors written before it. */
const webpKeyOf = (pub: Mirror) =>
  pub.keys.posterWebp === undefined ? `${pub.jobId}/v${pub.versionN}/poster-960.webp` : pub.keys.posterWebp

/** /v/{slug}.json: oEmbed 1.0 for a published version, plus a video_agent block for the player. */
async function oembed(req: Request, url: URL, slug: string, pub: Mirror | null): Promise<Response> {
  const started = Date.now()
  const done = (res: Response) => {
    console.log(
      JSON.stringify({ event: 'public.oembed', slug, status: res.status, ms: Date.now() - started }),
    )
    return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
  }
  if (!pub)
    return done(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { ...JSON_HEADERS, ...NO_STORE, 'content-type': 'application/json; charset=utf-8' },
      }),
    )
  const videos = getStore({ name: 'videos', consistency: 'strong' })
  const base = `${url.origin}/v/${slug}`
  const webpKey = webpKeyOf(pub)
  const posterWebp = webpKey && (await videos.getMetadata(webpKey)) ? `${base}.webp` : null
  const credits = Array.isArray(pub.credits) ? pub.credits : []
  const size = { width: pub.width, height: pub.height }
  const body = {
    type: 'video',
    version: '1.0',
    title: pub.title || 'Video',
    provider_name: contextMeta.appName || 'Video Agent',
    provider_url: url.origin,
    width: pub.width,
    height: pub.height,
    thumbnail_url: `${base}.jpg`,
    thumbnail_width: pub.width,
    thumbnail_height: pub.height,
    html: embedHtml(base, posterWebp, size, credits),
    video_agent: {
      videoId: pub.jobId,
      versionN: pub.versionN,
      page: base,
      mp4: `${base}.mp4`,
      poster: `${base}.jpg`,
      posterWebp,
      captions: `${base}.vtt`,
      durationSec: pub.durationSec,
      credits,
      lqip: pub.lqip ?? null,
      hover: pub.keys.hover ? `${base}.hover.mp4` : null,
    },
  }
  return done(
    new Response(JSON.stringify(body), {
      headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=60' },
    }),
  )
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
