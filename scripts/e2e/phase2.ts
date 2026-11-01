// End-to-end check against a live deployment (makes real videos; costs credits).
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… npx tsx scripts/e2e/phase2.ts [--webhook https://…]
// Steps: create → wait → download + Range → revise from v1 → wait → publish v2 → share page, MP4,
// unfurl tags → unpublish → link gone. Logs JSON lines; exits non-zero on the first failure.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from '../lib/run-tools.js'
import { base, fail, key, log, started } from './lib.js'

if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')
const args = parseArgs(process.argv.slice(2))

interface Version {
  n: number
  status: string
  stage: string | null
  latestStep: string | null
  error: { message: string } | null
  usage: { totalCreditsCost?: number } | null
  output: { durationSec: number; width: number; height: number; bytes: number } | null
}
interface Video {
  id: string
  status: string
  versions: Version[]
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return {
    status: res.status,
    data: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T,
    headers: res.headers,
  }
}

async function waitFor(id: string, n: number, maxMin = 25): Promise<Video> {
  let last = ''
  for (;;) {
    const { data } = await api<Video>('GET', `/api/v1/videos/${id}`)
    const v = data.versions.find((x) => x.n === n)
    const now = `${v?.status}|${v?.stage}|${(v?.latestStep ?? '').slice(0, 80)}`
    if (now !== last)
      log('progress', { n, status: v?.status, stage: v?.stage, step: v?.latestStep?.slice(0, 120) })
    last = now
    if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) return data
    if (Date.now() - started > maxMin * 60_000 * 2) fail('timed out waiting', { n })
    await new Promise((r) => setTimeout(r, 15_000))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'va-e2e-'))
const webhookUrl = args.webhook

const created = await api<Video>('POST', '/api/v1/videos', {
  prompt:
    'A short product teaser: the words "Ship faster" appear, then "with preview deploys", then an end card that says "Try it today". Calm, modern, dark background.',
  aspect: '16:9',
  durationSec: 8,
  title: 'E2E teaser',
  ...(webhookUrl ? { webhookUrl } : {}),
})
if (created.status !== 202) fail('create failed', { status: created.status, body: created.data })
const id = created.data.id
log('created', { id })

let video = await waitFor(id, 1)
const v1 = video.versions.find((x) => x.n === 1)
if (v1?.status !== 'ready') fail('v1 not ready', { v1 })
log('v1.ready', { output: v1?.output, credits: v1?.usage?.totalCreditsCost })

const redirect = await api<string>('GET', `/api/v1/videos/${id}/versions/1/video`)
const signed = redirect.headers.get('location')
if (redirect.status !== 302 || !signed) fail('file redirect missing', { status: redirect.status })
const full = await fetch(new URL(signed ?? '', base))
const mp4 = new Uint8Array(await full.arrayBuffer())
writeFileSync(join(dir, 'v1.mp4'), mp4)
const probe = execFileSync(
  'ffprobe',
  [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height,codec_name',
    '-of',
    'json',
    join(dir, 'v1.mp4'),
  ],
  { encoding: 'utf8' },
)
log('v1.downloaded', { bytes: mp4.byteLength, probe: JSON.parse(probe) as unknown })
const ranged = await fetch(new URL(signed ?? '', base), { headers: { range: 'bytes=100-199' } })
if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== 100)
  fail('range request failed', { status: ranged.status })
log('v1.range_ok', { contentRange: ranged.headers.get('content-range') })
const unsigned = await fetch(`${base}/files/${id}/v1/video.mp4`)
if (unsigned.status !== 403) fail('unsigned file not refused', { status: unsigned.status })

const revised = await api<Video>('POST', `/api/v1/videos/${id}/versions`, {
  prompt: 'Keep everything, but make the end card text "Start free today".',
})
if (revised.status !== 202) fail('revise failed', { status: revised.status, body: revised.data })
video = await waitFor(id, 2)
const v2 = video.versions.find((x) => x.n === 2)
if (v2?.status !== 'ready') fail('v2 not ready', { v2 })
log('v2.ready', { output: v2?.output, credits: v2?.usage?.totalCreditsCost })

const pub = await api<{ slug: string; urls: { page: string; mp4: string; gif: string } }>(
  'POST',
  `/api/v1/videos/${id}/versions/2/publish`,
)
if (pub.status !== 200) fail('publish failed', { status: pub.status })
const page = await fetch(pub.data.urls.page)
const html = await page.text()
if (page.status !== 200 || !html.includes('og:video')) fail('share page broken', { status: page.status })
const pubMp4 = await fetch(pub.data.urls.mp4, { method: 'HEAD' })
if (pubMp4.status !== 200) fail('public mp4 broken', { status: pubMp4.status })
log('published', { page: pub.data.urls.page, mp4: pubMp4.headers.get('content-length') })

const un = await api('DELETE', `/api/v1/videos/${id}/versions/2/publish`)
const gone = await fetch(pub.data.urls.mp4, { method: 'HEAD' })
if (un.status !== 204 || gone.status !== 404)
  fail('unpublish did not take effect', { un: un.status, gone: gone.status })
log('unpublished', { status: gone.status })

if (!args.keep) {
  const del = await api('DELETE', `/api/v1/videos/${id}`)
  log('deleted', { status: del.status })
}
log('PASS', { id, minutes: ((Date.now() - started) / 60_000).toFixed(1), dir })
