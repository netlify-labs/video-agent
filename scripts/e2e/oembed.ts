// Live check for /v/{slug}.json (cli-and-sdk plan §5.3; phase 1 gate va-p1th.2.7). Spends no credits.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] npx tsx scripts/e2e/oembed.ts [--dry]
// Picks VIDEO_ID (or your newest ready video), publishes its newest ready version unless it's already published,
// checks the oEmbed JSON (fields, types, CORS, cache, HEAD, the embed snippet, the hover clip when named), then
// unpublishes it in a finally (only what this run published) and checks the JSON 404s. Logs JSON lines; exits
// non-zero if any check fails. --dry prints the steps and touches nothing.
import { api, base, fail, key, log } from './lib.js'

if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')
const dry = process.argv.includes('--dry')

interface Video {
  id: string
  title: string
  versions: { n: number; status: string }[]
  publications: { slug: string; versionN: number; unpublishedAt: string | null }[]
}

const failures: string[] = []
const check = (name: string, ok: boolean, f: Record<string, unknown> = {}) => {
  log(ok ? 'ok' : 'FAIL', { check: name, ...f })
  if (!ok) failures.push(name)
}

const video = process.env.VIDEO_ID
  ? (await api<Video>('GET', `/api/v1/videos/${process.env.VIDEO_ID}`)).json
  : await (async () => {
      const list = (await api<{ items: Video[] }>('GET', '/api/v1/videos?owner=me&status=ready&limit=1')).json
      const first = list.items[0]
      if (!first) return fail('no ready video of yours; set VIDEO_ID')
      return (await api<Video>('GET', `/api/v1/videos/${first.id}`)).json
    })()
const n = Math.max(...video.versions.filter((v) => v.status === 'ready').map((v) => v.n))
if (!Number.isFinite(n)) fail('the video has no ready version', { videoId: video.id })
const live = video.publications.find((p) => p.versionN === n && !p.unpublishedAt)
log('plan', {
  dry,
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
if (dry) process.exit(0)

let slug = live?.slug ?? null
let published = false
try {
  if (!slug) {
    const res = await api<{ slug: string }>('POST', `/api/v1/videos/${video.id}/versions/${n}/publish`, {})
    if (res.status !== 200 && res.status !== 201)
      fail('publish failed', { status: res.status, body: res.json })
    slug = res.json.slug
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
  const va = body.video_agent
  check('videoId', va.videoId === video.id)
  check('versionN', va.versionN === n)
  check('durationSec', typeof va.durationSec === 'number' && va.durationSec > 0)
  check('credits is a list', Array.isArray(va.credits))
  for (const f of ['posterWebp', 'lqip', 'hover'])
    check(`${f} is a string or null`, va[f] === null || typeof va[f] === 'string', {
      value: typeof va[f] === 'string' ? va[f].slice(0, 60) : va[f],
    })
  for (const f of ['mp4', 'poster', 'captions', ...(va.hover ? ['hover'] : [])]) {
    const r = await fetch(String(va[f]), { method: 'HEAD' })
    check(`${f} is served`, r.ok, { status: r.status })
  }
  const head = await fetch(url, { method: 'HEAD' })
  check('HEAD', head.status === 200 && (await head.text()) === '')
} finally {
  if (published && slug) {
    const res = await api('DELETE', `/api/v1/videos/${video.id}/versions/${n}/publish`)
    log('unpublished', { slug, status: res.status })
    const gone = await fetch(`${base}/v/${slug}.json`)
    check('404 after unpublish', gone.status === 404, { status: gone.status })
  }
}
log(failures.length ? 'FAILED' : 'PASSED', { failures })
process.exit(failures.length ? 1 : 0)
