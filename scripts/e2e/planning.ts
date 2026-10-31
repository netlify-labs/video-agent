// Live check for Plan it first (plan v2 §13 B gate). Makes one real video (costs credits).
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… npx tsx scripts/e2e/planning.ts
// Steps: plan → questions → answer one, skip one, add an Other → brief → edit the brief (If-Match) → create with
// planId → wait for ready → the version carries the plan → planning credits show in my usage.
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

interface Question {
  id: string
  question: string
  options: { id: string; label: string }[]
  allowOther: boolean
}
interface Plan {
  id: string
  route: { needsQuestions: boolean; template: string } | null
  questions: Question[] | null
  brief: Record<string, unknown> | null
  briefRev: number
}
interface Json {
  error?: { code?: string; message?: string }
  id?: string
  status?: string
  versions?: {
    n: number
    status: string
    plan: { planId: string; brief: { callToAction: string } } | null
    usage: { totalCreditsCost?: number } | null
  }[]
  planning?: { credits: number; calls: number }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T & Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T & Json }
}

const prompt =
  'A 20-second announcement video for a new feature: teams can now get one webhook for events from every project in their organization. Show the problem, the fix, and an end card.'
let t = Date.now()
const created = await api<Plan>('POST', '/api/v1/plans', { prompt, aspect: '16:9' })
if (created.status !== 201) fail('plan create', { status: created.status, error: created.json.error })
log('route', { ms: Date.now() - t, route: created.json.route })
const planId = created.json.id
t = Date.now()
const asked = await api<Plan>('POST', `/api/v1/plans/${planId}/questions`)
if (asked.status !== 200) fail('questions', { status: asked.status, error: asked.json.error })
const qs = asked.json.questions ?? []
log('questions', { ms: Date.now() - t, count: qs.length, questions: qs.map((q) => q.question) })
const answers = qs.map((q, i) =>
  i === 0
    ? {
        questionId: q.id,
        optionIds: [q.options[0]?.id ?? ''],
        ...(q.allowOther ? { other: 'Keep it calm and confident' } : {}),
      }
    : i === 1
      ? { questionId: q.id, skipped: true }
      : { questionId: q.id, optionIds: [q.options[0]?.id ?? ''] },
)
t = Date.now()
const briefed = await api<Plan>('POST', `/api/v1/plans/${planId}/brief`, { answers })
if (briefed.status !== 200 || !briefed.json.brief)
  fail('brief', { status: briefed.status, error: briefed.json.error })
log('brief', { ms: Date.now() - t, brief: briefed.json.brief })
const edited = { ...briefed.json.brief, callToAction: 'Read the docs' }
const saved = await api<Plan>('PATCH', `/api/v1/plans/${planId}`, {
  brief: edited,
  briefRev: briefed.json.briefRev,
})
if (saved.status !== 200) fail('brief edit', { status: saved.status, error: saved.json.error })
log('brief_saved', { briefRev: saved.json.briefRev })

const video = await api<Json>('POST', '/api/v1/videos', { prompt, aspect: '16:9', planId })
if (video.status !== 202 || !video.json.id) fail('create', { status: video.status, error: video.json.error })
const id = video.json.id as string
log('created', { id })
let last = ''
for (let i = 0; i < 25 * 6; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const v = await api<Json>('GET', `/api/v1/videos/${id}`)
  const v1 = v.json.versions?.find((x) => x.n === 1)
  if (v1?.status !== last) log('status', { status: v1?.status })
  last = v1?.status ?? ''
  if (v1?.status === 'ready') {
    if (v1.plan?.planId !== planId) fail('version should carry the plan', { plan: v1.plan })
    if (v1.plan?.brief.callToAction !== 'Read the docs') fail('the edited brief should be the one used')
    log('ready', { credits: v1.usage?.totalCreditsCost ?? null })
    break
  }
  if (v1 && ['failed', 'cancelled', 'timed_out'].includes(v1.status))
    fail('run did not finish', { status: v1.status })
}
if (last !== 'ready') fail('timed out waiting for ready')
const again = await api<Json>('POST', '/api/v1/videos', { prompt, planId })
if (again.status !== 409) fail('a plan must be single use', { status: again.status })
const usage = await api<Json>('GET', '/api/v1/me/usage')
log('usage', { planning: usage.json.planning })
if (!usage.json.planning || usage.json.planning.calls < 2) fail('planning calls should be recorded')
log('PASS', { videoId: id })
