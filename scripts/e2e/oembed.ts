// Live check for /v/{slug}.json (cli-and-sdk plan §5.3; phase 1 gate va-p1th.2.7). Spends no credits.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] npx tsx scripts/e2e/oembed.ts [--dry]
// Picks VIDEO_ID (or your newest ready video), publishes its newest ready version unless it's already published,
// checks the oEmbed JSON (fields, types, CORS, cache, HEAD, the embed snippet, the hover clip when named), then
// unpublishes it in a finally (only what this run published) and checks the JSON 404s. Logs JSON lines; exits
// non-zero if any check fails. --dry prints the steps and makes no request.
import { base, fail, key, log, sdk } from './lib.js'
import { dry, dryRun } from './narration-lib.js'

if (dry)
  dryRun({
    script: 'scripts/e2e/oembed.ts',
    required: { VIDEO_AGENT_URL: process.env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: process.env.VIDEO_AGENT_KEY },
    optional: { VIDEO_ID: process.env.VIDEO_ID },
    steps: [
      'pick VIDEO_ID (or your newest ready video) and its newest ready version (read-only)',
      'if that version is not published: publish it; its share page and /v/{slug}.json are public until the unpublish',
      'GET and HEAD /v/{slug}.json: oEmbed fields and types, video_agent block, CORS *, cache, embed html',
      'HEAD the mp4, poster, captions and hover clip it names',
      'if this run published it: unpublish in finally, then GET /v/{slug}.json must be 404',
    ],
    credits: { projected: 0 },
  })
if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (or pass --dry).')

const failures: string[] = []
const check = (name: string, ok: boolean, f: Record<string, unknown> = {}) => {
  log(ok ? 'ok' : 'FAIL', { check: name, ...f })
  if (!ok) failures.push(name)
}

const va = sdk()
const video = await va.videos.get(
  process.env.VIDEO_ID ??
    (await va.videos.list({ owner: 'me', status: 'ready', limit: 1 })).items[0]?.id ??
    fail('no ready video of yours; set VIDEO_ID'),
)
const n = Math.max(...video.versions.filter((v) => v.status === 'ready').map((v) => v.n))
if (!Number.isFinite(n)) fail('the video has no ready version', { videoId: video.id })
// Publications are per version.
const live = video.versions.find((v) => v.n === n)?.publications.find((p) => !p.unpublishedAt)
log('plan', {
  site: base,
  videoId: video.id,
  versionN: n,
  steps: [
    live
      ? `already published as ${live.slug}: check only, leave it published`
      : 'publish (public for the check)',
    'GET and HEAD /v/{slug}.json, GET the hover clip when named',
    ...(live ? [] : ['unpublish in finally', 'GET /v/{slug}.json → 404']),
  ],
  credits: 0,
})

let slug = live?.slug ?? null
let published = false
try {
  if (!slug) {
    const pub = await va.versions.publish(video.id, n)
    slug = pub.slug
    published = true
    log('published', { slug })
  }
  const url = `${base}/v/${slug}.json`
  const t = Date.now()
  const res = await fetch(url)
  const body = (await res.json()) as Record<string, unknown> & { video_agent: Record<string, unknown> }
  log('fetched', { url, status: res.status, ms: Date.now() - t })
  check('status 200', res.status === 200, { status: res.status })
  check('content-type', res.headers.get('content-type') === 'application/json+oembed; charset=utf-8')
  check('cors *', res.headers.get('access-control-allow-origin') === '*')
  check('cache', res.headers.get('cache-control') === 'public, max-age=60')
  check('oembed type/version', body.type === 'video' && body.version === '1.0')
  for (const f of ['width', 'height', 'thumbnail_width', 'thumbnail_height'])
    check(`${f} is a positive number`, typeof body[f] === 'number' && body[f] > 0)
  for (const f of ['title', 'provider_name', 'provider_url', 'thumbnail_url', 'html'])
    check(`${f} is a string`, typeof body[f] === 'string' && body[f].length > 0)
  check('html is the embed', String(body.html).includes(`${base}/v/${slug}.mp4`))
  const meta = body.video_agent
  check('videoId', meta.videoId === video.id)
  check('versionN', meta.versionN === n)
  check('durationSec', typeof meta.durationSec === 'number' && meta.durationSec > 0)
  check('credits is a list', Array.isArray(meta.credits))
  for (const f of ['posterWebp', 'lqip', 'hover'])
    check(`${f} is a string or null`, meta[f] === null || typeof meta[f] === 'string', {
      value: typeof meta[f] === 'string' ? meta[f].slice(0, 60) : meta[f],
    })
  for (const f of ['mp4', 'poster', 'captions', ...(meta.hover ? ['hover'] : [])]) {
    const r = await fetch(String(meta[f]), { method: 'HEAD' })
    check(`${f} is served`, r.ok, { status: r.status })
  }
  const head = await fetch(url, { method: 'HEAD' })
  check('HEAD', head.status === 200 && (await head.text()) === '')
} finally {
  if (published && slug) {
    const res = await va.versions.unpublish(video.id, n).then(
      () => 204,
      (e: unknown) => String(e),
    )
    log('unpublished', { slug, status: res })
    const gone = await fetch(`${base}/v/${slug}.json`)
    check('404 after unpublish', gone.status === 404, { status: gone.status })
  }
}
log(failures.length ? 'FAILED' : 'PASSED', { failures })
process.exit(failures.length ? 1 : 0)
