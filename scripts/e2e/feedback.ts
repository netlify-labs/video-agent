// Live check for feedback (plan v2 §13 D gate). Spends one revision run (~250 credits).
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] npx tsx scripts/e2e/feedback.ts
// With the key of a video's owner (or an admin): pins two comments on its latest ready version, incorporates one
// with a note, waits for the new version, and checks that only the incorporated comment is marked addressed in it.
// A ready result means prepare-run verified the parent MP4 and made the still (any failure there stops the run);
// steps that mention video/feedback/ are logged as evidence the agent looked at it.
// Logs JSON lines; exits non-zero on the first failure.
const base = (process.env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
const key = process.env.VIDEO_AGENT_KEY ?? ''
if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')
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

interface Version {
  n: number
  status: string
  incorporates: number
  latestStep: string | null
  output: { durationSec: number; summary: string } | null
  error: { message: string } | null
}
interface Video {
  id: string
  latestVersion: number
  versions: Version[]
}
interface Comment {
  id: string
  versionN: number
  addressedInN: number | null
}
interface Json {
  items?: (Video & Comment)[]
  error?: { message?: string }
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T & Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'idempotency-key': crypto.randomUUID(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T & Json }
}

let id = process.env.VIDEO_ID ?? ''
if (!id) {
  const list = await api<Json>('GET', '/api/v1/videos?owner=me&status=ready&limit=1')
  id = list.json.items?.[0]?.id ?? fail('No ready video owned by this key to test with.')
}
const video = (await api<Video>('GET', `/api/v1/videos/${id}`)).json
if (video.versions.some((v) => ['queued', 'running', 'finishing'].includes(v.status)))
  fail('A version of this video is still in progress.', { id })
const from = video.versions.find((v) => v.status === 'ready') ?? fail('The video has no ready version.')
const length = from.output?.durationSec ?? 4
log('video', { id, from: from.n, durationSec: length })

const pin = async (body: string, timeSec: number, x: number, y: number) => {
  const r = await api<Comment>('POST', `/api/v1/videos/${id}/comments`, {
    versionN: from.n,
    body,
    timeSec,
    x,
    y,
  })
  if (r.status !== 201) fail('comment', { status: r.status, error: r.json.error })
  log('comment', { id: r.json.id, timeSec, x, y })
  return r.json.id
}
const picked = await pin(
  'Make the logo in the last scene about twice as big.',
  Math.max(0, length - 1),
  0.5,
  0.5,
)
const skipped = await pin(
  'Try a darker background here (e2e: not incorporated).',
  Math.min(1, length / 2),
  0.2,
  0.3,
)

const rev = await api<Video>('POST', `/api/v1/videos/${id}/versions`, {
  prompt: 'Only change what the feedback asks for.',
  fromVersion: from.n,
  commentIds: [picked],
})
if (rev.status !== 202) fail('incorporate', { status: rev.status, error: rev.json.error })
const n = rev.json.latestVersion
log('incorporate', { n, incorporates: rev.json.versions.find((v) => v.n === n)?.incorporates })

let last = ''
const sawFeedback = new Set<string>()
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 15_000))
  const v = (await api<Video>('GET', `/api/v1/videos/${id}`)).json.versions.find((x) => x.n === n)
  if (!v) continue
  if (v.latestStep?.includes('feedback/')) sawFeedback.add(v.latestStep.slice(0, 160))
  if (`${v.status}:${v.latestStep}` !== last) {
    last = `${v.status}:${v.latestStep}`
    log('status', { status: v.status, step: v.latestStep?.slice(0, 140) })
  }
  if (['ready', 'failed', 'timed_out', 'cancelled'].includes(v.status)) {
    if (v.status !== 'ready')
      fail('The incorporate run did not finish.', { status: v.status, error: v.error })
    log('ready', { summary: v.output?.summary.slice(0, 400), sawFeedback: [...sawFeedback] })
    break
  }
  if (i === 99) fail('Timed out waiting for the version.')
}

const comments = (await api<Json>('GET', `/api/v1/videos/${id}/comments?version=${from.n}`)).json.items ?? []
const a = comments.find((c) => c.id === picked)
const b = comments.find((c) => c.id === skipped)
log('addressed', { picked: a?.addressedInN, skipped: b?.addressedInN })
if (a?.addressedInN !== n) fail('The incorporated comment should be addressed in the new version.')
if (b?.addressedInN !== null) fail('The comment left out should stay open.')
log('PASS', { id, n })
