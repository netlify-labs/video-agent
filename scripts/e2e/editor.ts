// Live check for the editor (plan v2 §8, §13 C gate) and spike S4's numbers. Spends one render-unchanged run.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_ID=vid_… [FROM=n] [STRETCH_TO=60] npx tsx scripts/e2e/editor.ts
// Opens a draft of an editable version, edits it (retime, text, reorder, [COLOR=1] colour within the palette; or stretches the
// beats to STRETCH_TO seconds), checks the draft preview, renders it unchanged and waits. Passes when the new version
// is ready, render_unchanged from the base, its MP4 length matches the edited composition, it is editable again and
// its own preview carries the edit. Logs stage times and credits (S4). JSON lines; exits non-zero on failure.
import { api, base, fail, key, log } from './lib.js'

const id = process.env.VIDEO_ID ?? ''
if (!base || !key || !id) throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and VIDEO_ID.')
const stretchTo = process.env.STRETCH_TO ? Number(process.env.STRETCH_TO) : null

interface Beat {
  id: string
  duration: number
  texts: { id: string; text: string }[]
}
interface Edit {
  id: string
  rev: number
  palette: string[]
  composition: { duration: number; colors: Record<string, string>; beats: Beat[] }
  error?: { message?: string }
}
interface Version {
  n: number
  status: string
  mode: string
  editedFromN: number | null
  editable: boolean
  error: { message: string } | null
  output: { durationSec: number } | null
  usage: { totalCreditsCost?: number } | null
  timings: {
    queuedAt: string
    startedAt: string | null
    finishingAt: string | null
    endedAt: string | null
  } | null
}
interface Video {
  latestVersion: number
  versions: Version[]
  error?: { message?: string }
}

const video = (await api('GET', `/api/v1/videos/${id}`)).json as Video
const from = Number(process.env.FROM ?? video.versions.find((v) => v.editable)?.n ?? 0)
if (!from) fail('No editable version on this video.')
const opened = await api('POST', `/api/v1/videos/${id}/versions/${from}/edits`)
const draft = opened.json as Edit
if (opened.status !== 200 && opened.status !== 201)
  fail('open draft', { status: opened.status, error: draft.error })
const beats = draft.composition.beats
log('draft', {
  id: draft.id,
  from,
  duration: draft.composition.duration,
  beats: beats.map((b) => [b.id, b.duration]),
})

const ops: unknown[] = []
let newText: string | null = null
if (stretchTo) {
  const k = stretchTo / draft.composition.duration
  for (const b of beats)
    ops.push({ op: 'retime', beat: b.id, duration: Math.min(120, Math.round(b.duration * k * 30) / 30) })
} else {
  const first = beats[0] ?? fail('No beats.')
  ops.push({ op: 'retime', beat: first.id, duration: Math.round((first.duration + 1) * 30) / 30 })
  const t = beats.flatMap((b) => b.texts)[0]
  if (t) {
    newText = `${t.text.slice(0, 40)} (edited)`
    ops.push({ op: 'text', id: t.id, text: newText })
  }
  if (beats.length >= 3) {
    const order = beats.map((b) => b.id)
    const [x, y] = [order.at(-2) ?? '', order.at(-1) ?? '']
    order.splice(-2, 2, y, x)
    ops.push({ op: 'reorder', order })
  }
  const accent =
    Object.keys(draft.composition.colors).find((r) => r === 'accent') ??
    Object.keys(draft.composition.colors)[0]
  const other = accent
    ? draft.palette.find((c) => c !== draft.composition.colors[accent]?.toLowerCase())
    : undefined
  // A palette colour can fail hyperframes' contrast check (the run then stops by design): opt in with COLOR=1.
  if (process.env.COLOR === '1' && accent && other) ops.push({ op: 'color', role: accent, value: other })
}
const saved = await api('PUT', `/api/v1/edits/${draft.id}`, { rev: draft.rev, ops })
const edit = saved.json as Edit
if (saved.status !== 200) fail('save', { status: saved.status, error: edit.error, ops })
log('saved', { rev: edit.rev, duration: edit.composition.duration, ops: ops.length })

const link = (await api('GET', `/api/v1/edits/${draft.id}/preview`)).json as { url: string }
const page = await fetch(link.url)
const html = await page.text()
if (page.status !== 200 || (newText && !html.includes(newText.replaceAll('&', '&amp;'))))
  fail('draft preview', { status: page.status })
log('draft_preview', { status: page.status })

const rendered = await api('POST', `/api/v1/edits/${draft.id}/render`, undefined, {
  'idempotency-key': crypto.randomUUID(),
})
const queued = rendered.json as Video
if (rendered.status !== 202) fail('render', { status: rendered.status, error: queued.error })
const n = queued.latestVersion
log('render', { n })

let v: Version | undefined
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  v = ((await api('GET', `/api/v1/videos/${id}`)).json as Video).versions.find((x) => x.n === n)
  if (v && ['ready', 'failed', 'timed_out', 'cancelled'].includes(v.status)) break
}
const done: Version =
  v?.status === 'ready'
    ? v
    : fail('The render-unchanged run did not finish.', { status: v?.status, error: v?.error })
const t = done.timings
const sec = (a?: string | null, b?: string | null) =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null
log('ready', {
  n,
  mode: done.mode,
  editedFromN: done.editedFromN,
  editable: done.editable,
  composition: edit.composition.duration,
  mp4: done.output?.durationSec,
  credits: done.usage?.totalCreditsCost ?? null,
  queuedToStart: sec(t?.queuedAt, t?.startedAt),
  run: sec(t?.startedAt, t?.finishingAt),
  finalize: sec(t?.finishingAt, t?.endedAt),
  total: sec(t?.queuedAt, t?.endedAt),
})
if (done.mode !== 'render_unchanged' || done.editedFromN !== from) fail('Wrong mode or base.')
if (Math.abs((done.output?.durationSec ?? 0) - edit.composition.duration) > 0.25)
  fail('The MP4 length does not match the edited composition.')
if (!done.editable) fail('The edited version should keep the contract.')
if (newText) {
  const own = (await api('GET', `/api/v1/videos/${id}/versions/${n}/preview`)).json as { url: string }
  if (!(await (await fetch(own.url)).text()).includes(newText.replaceAll('&', '&amp;')))
    fail("The new version's composition lacks the edit.")
}
log('PASS', { id, n })
