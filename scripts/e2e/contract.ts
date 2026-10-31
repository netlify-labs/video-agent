// Live check that new videos keep editing contract v1 (plan v2 §8). Spends one run (~250 credits).
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… npx tsx scripts/e2e/contract.ts
// Creates a short video and waits for it: passes when version 1 is ready and editable (finalize validated the
// composition against the contract). Logs JSON lines; exits non-zero on the first failure.
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
interface Video {
  id: string
  versions: {
    n: number
    status: string
    editable: boolean
    latestStep: string | null
    error: { message: string } | null
  }[]
  error?: { message?: string }
}
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
const created = await fetch(`${base}/api/v1/videos`, {
  method: 'POST',
  headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
  body: JSON.stringify({
    prompt:
      'A 15-second launch clip for "Deploy previews for every pull request": three beats (the problem, the feature, an end card that says "Try it on your next PR").',
    durationSec: 15,
  }),
})
const v = (await created.json()) as Video
if (created.status !== 202) fail('create', { status: created.status, error: v.error })
log('created', { id: v.id })
let last = ''
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 15_000))
  const cur = ((await (await fetch(`${base}/api/v1/videos/${v.id}`, { headers })).json()) as Video)
    .versions[0]
  if (!cur) continue
  const now = `${cur.status}:${cur.latestStep ?? ''}`
  if (now !== last) {
    last = now
    log('status', { status: cur.status, step: cur.latestStep?.slice(0, 120) })
  }
  if (['ready', 'failed', 'timed_out', 'cancelled'].includes(cur.status)) {
    if (cur.status !== 'ready') fail('The run did not finish.', { status: cur.status, error: cur.error })
    if (!cur.editable)
      fail('The video is ready but not editable: the composition breaks contract v1.', { id: v.id })
    log('PASS', { id: v.id, editable: cur.editable })
    process.exit(0)
  }
}
fail('Timed out.')
