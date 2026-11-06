// Live test LT-2 of the screen-recording plan (live gate 3; bead va-rsk5.4.10): one editor render of a demo on
// production, about 34 credits. CREDIT_CEILING (default 60) refuses to start when the projection is over it.
//
//   npx tsx scripts/e2e/demo-edit.ts --dry   # the same kinds of ops on the recording fixture through the real patcher
//                                           # (src/lib/contract.ts applyEdits), then the env, steps and credits
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… DEMO_VIDEO=vid_… npx tsx scripts/e2e/demo-edit.ts
//
// On the demo's latest ready version: open a draft, then on its first recording scene set a new camera (two keys), a
// span short enough to play under 0.5x (so the last frame is held) and a new hidden area drawn in the editor; save,
// render unchanged and wait. Checks, as JSON lines: the version is ready and render_unchanged; its bundle has the new
// camera, the held slot and its still, and redact.js exactly as before (locked areas untouched); the Hidden list gains
// the editor's area; credits (usage.totalCreditsCost).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdits, type Summary } from '../../src/lib/contract.js'
import { RATE_RANGE } from '../../src/lib/recording.js'
import { api, base, fail, key, log, started } from './lib.js'
import { dryRun } from './narration-lib.js'

const env = process.env
const dry = process.argv.includes('--dry')
const ceiling = Number(env.CREDIT_CEILING ?? 60)
const perRender = Number(env.EDIT_CREDITS ?? 34)

interface RecordingBeat {
  in: number
  out: number
  camera: unknown[]
  redact: unknown[]
}
interface Beat {
  id: string
  duration: number
  recording?: RecordingBeat
}
interface Edit {
  id: string
  rev: number
  composition: { beats: Beat[] }
  error?: { message?: string }
}

/** The LT-2 ops for a recording scene: a new camera, a span under 0.5x, an editor box. */
function opsFor(b: Beat): unknown[] {
  const r = b.recording ?? fail(`scene ${b.id} has no recording`)
  // Under the slowest rate: the scene shows less source than RATE_RANGE[0] x its length, so the end is held.
  const span = Math.max(0.6, Math.min(r.out - r.in, b.duration * RATE_RANGE[0] * 0.8))
  const out = Math.round((r.in + span) * 1000) / 1000
  return [
    { op: 'span', beat: b.id, in: r.in, out },
    {
      op: 'camera',
      beat: b.id,
      keys: [
        [r.in, 0.5, 0.5, 1],
        [Math.round((r.in + span / 2) * 1000) / 1000, 0.4, 0.4, 1.5, 'power2.inOut'],
      ],
    },
    {
      op: 'redact',
      beat: b.id,
      entries: [
        ...r.redact,
        {
          id: 'e9',
          origin: 'editor',
          start: r.in,
          end: out,
          reason: 'LT-2',
          boxes: [[r.in, 0.05, 0.85, 0.2, 0.08]],
        },
      ],
    },
  ]
}

if (dry) {
  // The same ops through the real patcher, on the recording fixture: a refused op fails here, not on production.
  const fx = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'contract1-recording')
  const html = readFileSync(join(fx, 'index.html'), 'utf8')
  const summary = JSON.parse(readFileSync(join(fx, 'summary.json'), 'utf8')) as Summary
  const before = applyEdits(html, summary, []).composition.beats.find((b) => b.recording) as Beat | undefined
  const problems: string[] = []
  try {
    const out = applyEdits(html, summary, before ? (opsFor(before) as never) : [])
    const after = out.composition.beats.find((b) => b.id === before?.id) as Beat | undefined
    log('dry_patch', {
      beat: before?.id,
      in: after?.recording?.in,
      out: after?.recording?.out,
      hold: (after as { recording?: { hold?: unknown } } | undefined)?.recording?.hold ?? null,
    })
    if (!(after?.recording as { hold?: unknown } | undefined)?.hold)
      problems.push('the span did not force a hold on the fixture')
  } catch (e) {
    problems.push(`the patcher refused the LT-2 ops: ${e instanceof Error ? e.message : String(e)}`)
  }
  dryRun({
    script: 'scripts/e2e/demo-edit.ts',
    required: {
      VIDEO_AGENT_URL: base || undefined,
      VIDEO_AGENT_KEY: key || undefined,
      DEMO_VIDEO: env.DEMO_VIDEO,
    },
    optional: { CREDIT_CEILING: env.CREDIT_CEILING },
    steps: [
      "open a draft of the demo's latest ready version",
      'on its first recording scene: span under 0.5x (a held end), a two-key camera, an editor hidden area',
      'save, render unchanged, wait (40 min at most)',
      'check: ready and render_unchanged; bundle has the camera, the held slot and its still, redact.js unchanged; the Hidden list has the editor area; credits',
    ],
    credits: { projected: perRender, ceiling, under: perRender <= ceiling },
    problems: [
      ...problems,
      ...(perRender > ceiling
        ? [`projected ${String(perRender)} credits is over CREDIT_CEILING ${String(ceiling)}`]
        : []),
    ],
  })
}

const id = env.DEMO_VIDEO ?? ''
if (!base || !key || !id) fail('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and DEMO_VIDEO.')
if (perRender > ceiling) fail('projected credits over CREDIT_CEILING', { perRender, ceiling })
type Version = {
  n: number
  status: string
  mode: string
  editable: boolean
  usage: { totalCreditsCost?: number } | null
  recording: { hidden: { id: string; source: string }[] } | null
}
const video = (await api('GET', `/api/v1/videos/${id}`)).json as { versions: Version[] }
const from =
  video.versions.find((v) => v.status === 'ready' && v.editable && v.recording)?.n ??
  fail('no editable demo version')
const linkOf = async (n: number) =>
  ((await api('GET', `/api/v1/videos/${id}/versions/${String(n)}/preview`)).json as { url: string }).url
const fileAt = async (url: string, p: string) => {
  const r = await fetch(new URL(p, url))
  return r.ok ? r.text() : null
}
const beforeUrl = await linkOf(from)
const lockedBefore = await fileAt(beforeUrl, 'assets/recording/redact.js')
const opened = await api('POST', `/api/v1/videos/${id}/versions/${String(from)}/edits`)
const draft = opened.json as Edit
if (opened.status !== 200 && opened.status !== 201)
  fail('open draft', { status: opened.status, error: draft.error })
const scene = draft.composition.beats.find((b) => b.recording) ?? fail('no recording scene')
const ops = opsFor(scene)
const saved = await api('PUT', `/api/v1/edits/${draft.id}`, { rev: draft.rev, ops })
if (saved.status !== 200) fail('save', { status: saved.status, body: saved.json })
log('saved', { scene: scene.id, ops: ops.map((o) => (o as { op: string }).op) })
const rendered = await api('POST', `/api/v1/edits/${draft.id}/render`, undefined, {
  'idempotency-key': crypto.randomUUID(),
})
if (rendered.status !== 202) fail('render', { status: rendered.status, body: rendered.json })
const n = (rendered.json as { latestVersion: number }).latestVersion
log('render', { n })
let v: Version | undefined
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  v = ((await api('GET', `/api/v1/videos/${id}`)).json as { versions: Version[] }).versions.find(
    (x) => x.n === n,
  )
  if (v && ['ready', 'failed', 'timed_out', 'cancelled'].includes(v.status)) break
}
const done = v ?? fail('version vanished')
const checks: Record<string, boolean> = {
  ready: done.status === 'ready',
  render_unchanged: done.mode === 'render_unchanged',
}
if (done.status === 'ready') {
  const url = await linkOf(n)
  const html = (await fileAt(url, 'index.html')) ?? ''
  const still = /assets\/recording\/[a-z0-9-]+\.hold\.jpg/.exec(html)?.[0]
  checks.camera = html.includes('[[') && html.includes('0.4,0.4,1.5')
  checks.held =
    /data-va-rec-hold="end"/.test(html) && Boolean(still) && (await fetch(new URL(still ?? 'x', url))).ok
  checks.locked_unchanged =
    lockedBefore !== null && (await fileAt(url, 'assets/recording/redact.js')) === lockedBefore
  checks.hidden_list = Boolean(done.recording?.hidden.some((h) => h.id === 'e9' && h.source === 'editor'))
}
const credits = done.usage?.totalCreditsCost ?? null
log('checks', { n, ...checks, credits })
if (Object.values(checks).some((ok) => !ok)) fail('LT-2 checks failed', checks)
log('PASS', { credits, seconds: Math.round((Date.now() - started) / 1000) })
