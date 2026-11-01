// Live gate for media (plan v2 §9, §13 E gate). Spends two runs.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… CLIP_ID=med_… [FONT=path.woff2] npx tsx scripts/e2e/media-gate.ts
// Uses a library clip of about 100 MB (CLIP_ID, uploaded by scripts/e2e/media.ts) and uploads a font, makes a video
// with both, then deletes the clip from the library and revises. Passes when v1 is ready and its composition uses the
// clip and the font from assets/media/, and v2 (made after the delete) is ready and still has the clip. JSON lines;
// exits non-zero on failure.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const base = (process.env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
const key = process.env.VIDEO_AGENT_KEY ?? ''
const clipId = process.env.CLIP_ID ?? ''
const fontPath =
  process.env.FONT ?? 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'
if (!base || !key || !clipId) throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and CLIP_ID.')
const started = Date.now()
const log = (step: string, f: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      s: Math.round((Date.now() - started) / 1000),
      step,
      ...f,
    }),
  )
}
const fail = (msg: string, f: Record<string, unknown> = {}): never => {
  log('FAIL', { msg, ...f })
  process.exit(1)
}

interface Media {
  id: string
  kind: string
  status: string
  bytes: number
  durationSec: number | null
}
interface Version {
  n: number
  status: string
  error: { message: string } | null
  output: { durationSec: number } | null
  usage: { totalCreditsCost?: number } | null
}
interface Video {
  id: string
  latestVersion: number
  versions: Version[]
}

async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as unknown }
}

async function waitReady(videoId: string, n: number) {
  for (;;) {
    const v = (await api('GET', `/api/v1/videos/${videoId}`)).json as Video
    const version = v.versions.find((x) => x.n === n)
    if (version?.status === 'ready') return version
    if (version?.status === 'failed' || version?.status === 'canceled')
      return fail(`v${n} ${version.status}`, { error: version.error })
    if (Date.now() - started > 45 * 60_000) return fail(`v${n} not ready after 45 minutes`)
    await new Promise((r) => setTimeout(r, 15_000))
  }
}

/** The version's composition (index.html plus linked stylesheets) and a HEAD of one of its files. */
async function composition(videoId: string, n: number) {
  const link = (await api('GET', `/api/v1/videos/${videoId}/versions/${n}/preview`)).json as { url?: string }
  if (!link.url) return fail(`no preview link for v${n}`, { link })
  const url = link.url
  let text = await (await fetch(url)).text()
  for (const [, href] of text.matchAll(/<link[^>]+href="([^"]+\.css)"/g))
    if (href && !href.startsWith('http')) text += await (await fetch(new URL(href, url))).text()
  const head = async (path: string) => {
    const res = await fetch(new URL(path, url), { method: 'HEAD' })
    return { status: res.status, size: Number(res.headers.get('content-length') ?? 0) }
  }
  return { text, head }
}

// 1. The clip, and a font.
const clip = (await api('GET', `/api/v1/media/${clipId}`)).json as Media
if (clip.status !== 'ready' || clip.kind !== 'video') fail('CLIP_ID is not a ready clip', { clip })
log('clip', { id: clip.id, mb: Math.round(clip.bytes / 1048576), seconds: clip.durationSec })
if (clip.bytes < 90 * 1048576) log('warn', { msg: 'the clip is under 90 MB; the gate asks for about 100 MB' })
const fontBytes = readFileSync(fontPath)
const fontUp = await fetch(
  `${base}/api/v1/media?filename=${encodeURIComponent(basename(fontPath))}&caption=${encodeURIComponent('Brand headline font')}`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' },
    body: fontBytes,
  },
)
const font = (await fontUp.json()) as Media
if (fontUp.status !== 201 || font.kind !== 'font') fail('font upload failed', { status: fontUp.status, font })
log('font', { id: font.id, bytes: font.bytes })

// 2. A video that uses both.
const created = await api(
  'POST',
  '/api/v1/videos',
  {
    prompt:
      'A 15-second teaser for org-wide webhooks. Open on the attached product clip, playing full screen behind a short headline. Set every headline in the attached brand font. End on a card that says "Webhooks for every project".',
    aspect: '16:9',
    durationSec: 15,
    mediaIds: [clip.id, font.id],
  },
  { 'idempotency-key': `media-gate-${started}` },
)
const video = created.json as Video
if (created.status !== 202) fail('create failed', { status: created.status, body: created.json })
log('created', { videoId: video.id })
const v1 = await waitReady(video.id, 1)
log('v1 ready', { seconds: v1.output?.durationSec, credits: v1.usage?.totalCreditsCost })
const c1 = await composition(video.id, 1)
const clipFile = `assets/media/${clip.id}.mp4`
const fontFile = new RegExp(`assets/media/${font.id}\\.woff2`)
if (!c1.text.includes(clipFile)) fail('v1 does not use the clip', { clipFile })
if (!fontFile.test(c1.text)) fail('v1 does not use the font', { font: font.id })
const h1 = await c1.head(clipFile)
if (h1.status !== 200 || h1.size !== clip.bytes) fail('v1 preview does not serve the clip', h1)
log('v1 uses both', { clip: clipFile, clipServed: h1 })

// 3. Delete the clip from the library, then revise.
const del = await api('DELETE', `/api/v1/media/${clip.id}`)
if (del.status !== 204) fail('delete failed', { status: del.status, body: del.json })
if ((await api('GET', `/api/v1/media/${clip.id}`)).status !== 404) fail('deleted clip still in the library')
log('clip deleted from the library')
const revised = await api(
  'POST',
  `/api/v1/videos/${video.id}/versions`,
  { prompt: 'Make the closing card headline larger and hold it one second longer.', fromVersion: 1 },
  { 'idempotency-key': `media-gate-rev-${started}` },
)
if (revised.status !== 202) fail('revise failed', { status: revised.status, body: revised.json })
const v2 = await waitReady(video.id, 2)
log('v2 ready', { seconds: v2.output?.durationSec, credits: v2.usage?.totalCreditsCost })
const c2 = await composition(video.id, 2)
if (!c2.text.includes(clipFile)) fail('v2 lost the clip', { clipFile })
const h2 = await c2.head(clipFile)
if (h2.status !== 200 || h2.size !== clip.bytes) fail('v2 preview does not serve the clip', h2)
log('PASS', {
  videoId: video.id,
  url: `${base}/videos/${video.id}`,
  credits: (v1.usage?.totalCreditsCost ?? 0) + (v2.usage?.totalCreditsCost ?? 0),
})
