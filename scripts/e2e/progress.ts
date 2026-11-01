// Live check for progress (plan v2 §6). Spends one revision run (~250 credits).
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] npx tsx scripts/e2e/progress.ts
// Revises a ready video the key owns and polls /progress every 3 s like the page does. Passes when the version is
// ready and the run reported at least one milestone (scripts/checkpoint.ts) and render progress (render-job). When a
// milestone carries a composition snapshot, the live preview link is minted and its index.html fetched (200 with the
// preview CSP); the agent sends snapshots by choice, so their absence is logged, not failed.
// Logs every distinct step, milestone and render percent as JSON lines.
import { api as request, base, fail, key, log } from './lib.js'

if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')

interface Video {
  id: string
  latestVersion: number
  versions: { n: number; status: string; error: { message: string } | null }[]
  items?: { id: string }[]
  error?: { message?: string }
}
interface Progress {
  versionN: number | null
  stage: string | null
  step: string | null
  steps: number | null
  credits: number | null
  stale: boolean
  checkpoint: { seq: number; message: string | null; renderPercent: number | null; hasBundle: boolean } | null
}

const api = (method: string, path: string, body?: unknown) =>
  request(method, path, body, { 'idempotency-key': crypto.randomUUID() })

let id = process.env.VIDEO_ID ?? ''
if (!id) {
  const list = (await api('GET', '/api/v1/videos?owner=me&status=ready&limit=1')).json as Video
  id = list.items?.[0]?.id ?? fail('No ready video owned by this key to test with.')
}
const rev = await api('POST', `/api/v1/videos/${id}/versions`, {
  prompt: 'Keep everything the same, but make the background a little darker.',
})
const queued = rev.json as Video
if (rev.status !== 202) fail('revise', { status: rev.status, error: queued.error })
const n = queued.latestVersion
log('revise', { id, n })

const milestones = new Set<string>()
const percents = new Set<number>()
const snapshots: { seq: number; status: number; csp: boolean }[] = []
let last = ''
for (let i = 0; i < 300; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const p = (await api('GET', `/api/v1/videos/${id}/progress`)).json as Progress
  if (p.versionN !== n) continue
  if (p.checkpoint?.message) milestones.add(p.checkpoint.message)
  if (p.checkpoint?.renderPercent != null) percents.add(p.checkpoint.renderPercent)
  const cp = p.checkpoint
  if (cp?.hasBundle && p.stage === 'running' && !snapshots.some((s) => s.seq === cp.seq)) {
    const link = (await api('GET', `/api/v1/videos/${id}/versions/${n}/preview?live=1`)).json as {
      url?: string
    }
    const page = link.url ? await fetch(link.url) : null
    const snap = {
      seq: cp.seq,
      status: page?.status ?? 0,
      csp: (page?.headers.get('content-security-policy') ?? '').includes('sandbox allow-scripts'),
    }
    snapshots.push(snap)
    log('snapshot', snap)
  }
  const now = JSON.stringify([p.stage, p.step, p.checkpoint?.message, p.checkpoint?.renderPercent, p.stale])
  if (now !== last) {
    last = now
    log('progress', {
      stage: p.stage,
      step: p.step?.slice(0, 100),
      steps: p.steps,
      credits: p.credits,
      milestone: p.checkpoint?.message,
      renderPercent: p.checkpoint?.renderPercent,
      stale: p.stale,
    })
  }
  if (p.stage && ['ready', 'failed', 'timed_out', 'cancelled'].includes(p.stage)) {
    const v = ((await api('GET', `/api/v1/videos/${id}`)).json as Video).versions.find((x) => x.n === n)
    if (v?.status !== 'ready') fail('The run did not finish.', { status: v?.status, error: v?.error })
    break
  }
  if (i === 299) fail('Timed out.')
}
log('seen', { milestones: [...milestones], renderPercents: [...percents].sort((a, b) => a - b), snapshots })
if (snapshots.some((s) => s.status !== 200 || !s.csp)) fail('A live snapshot did not load.', { snapshots })
if (milestones.size === 0) fail('No milestone checkpoints arrived.')
if (percents.size === 0) fail('No render progress arrived.')
log('PASS', { id, n })
