// Finalize for a demo (screen-recording plan §5.2 check, §9; va-rsk5.3.14): the saved composition of the golden
// scene-change demo is checked against the version's locked inputs (the frozen trace from the media store and the
// setup boxes). Good -> the Hidden list (trace, setup, agent; editor boxes with their author, checks carried over) and
// the summary; a removed locked entry -> redaction_removed; a bad cursor file -> recording_file_invalid; a trace whose
// stored hash doesn't match -> recording_file_invalid. The hook into finalize.ts lands when that file is free.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { finalizeRecording } from '../src/domain/finalize-recording.js'
import { applyEdits, type Summary } from '../src/lib/contract.js'
import { RATE_RANGE } from '../src/lib/recording.js'
import type { VersionRecording } from '../src/domain/types.js'
import { parseTrace } from '../src/lib/recording-trace.js'
import type { Analysis } from '../scripts/lib/recording-analyze.js'
import { composeDemo } from '../scripts/lib/recording-compose.js'
import { planRecording, type PlanInput } from '../scripts/lib/recording-plan.js'
import { harness, png, PROMPT, upload } from './helpers.js'
import { tarGz } from './tarball.js'

const tmp = mkdtempSync(join(tmpdir(), 'va-fin-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')
const ID = 'med_golden0001'
const JOB = 'vid_demo'
const traceText = readFileSync(join(CASE, 'trace.json'), 'utf8')
const input = JSON.parse(readFileSync(join(CASE, 'input.json'), 'utf8')) as PlanInput
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

/** The composed demo's files, as finalize reads them from the archive. Step 1 gets an agent box. */
function demoFiles() {
  const dir = mkdtempSync(join(tmp, 'v'))
  const analysis = JSON.parse(readFileSync(join(CASE, 'analysis.json'), 'utf8')) as Analysis
  const trace = parseTrace(traceText)
  const { plan } = planRecording({ mediaId: ID, analysis, trace, input })
  const step1 = plan.steps[0]
  if (step1)
    step1.redact = [{ id: 'a1', start: 1, end: 3, reason: 'email', boxes: [[1, 0.5, 0.5, 0.1, 0.05]] }]
  composeDemo({ videoDir: dir, plan, analysis, trace })
  const files = new Map<string, Uint8Array>()
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else files.set(relative(dir, p), new Uint8Array(readFileSync(p)))
    }
  }
  walk(dir)
  // The agent's summary block.
  const s = JSON.parse(new TextDecoder().decode(files.get('summary.json'))) as Record<string, unknown>
  s.recording = { steps: 2, cut: 0, spedUp: 0, redactionsAdded: 1 }
  files.set('summary.json', new TextEncoder().encode(JSON.stringify(s)))
  return files
}

const rec: VersionRecording = {
  mediaId: ID,
  trace: { key: `${ID}/trace.json`, sha256: sha(traceText) },
  trim: null,
  boxes: input.boxes ?? [],
  compose: false,
  summary: null,
  hidden: [],
}

async function setup() {
  const h = harness()
  await h.deps.blobs.set('media', `${ID}/trace.json`, traceText)
  await h.deps.store.insertVersionMedia([
    {
      jobId: JOB,
      versionN: 1,
      mediaId: ID,
      position: 0,
      kind: 'video',
      key: `${ID}/original.mp4`,
      sha256: 'a'.repeat(64),
      filename: `${ID}.mp4`,
      caption: null,
    },
  ])
  return h
}
const version = {
  recording: rec,
  authorId: 'u_editor',
  parentN: null,
  editedFromN: null,
  mode: 'author' as const,
}

describe('finalize: recording', () => {
  it('a good demo gets its Hidden list (trace, setup, agent) and summary', async () => {
    const h = await setup()
    const r = await finalizeRecording(h.deps, JOB, 1, version, demoFiles())
    console.log(JSON.stringify({ test: 'finalize-recording', case: 'good', ok: r?.ok }))
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.recording.summary).toEqual({
      sourceSec: 0,
      steps: 2,
      cutSec: 0,
      spedUpSec: 0,
      redactionsAdded: 1,
    })
    const ids = r.recording.hidden.map((x) => `${x.id}:${x.source}@${x.beat}`)
    expect(ids).toEqual([
      't1:trace@step-1',
      's1:setup@step-1',
      'a1:agent@step-1',
      't1:trace@step-2',
      's1:setup@step-2',
    ])
    expect(r.recording.hidden[2]).toMatchObject({ start: 1, end: 3, reason: 'email', checkedBy: null })
  })

  it("an editor render with LT-2's ops (a span under 0.5x holds the end) passes; the same in an author run doesn't", async () => {
    const h = await setup()
    const files = demoFiles()
    const dec = (p: string) => new TextDecoder().decode(files.get(p))
    const summary = JSON.parse(dec('summary.json')) as Summary
    const beat = applyEdits(dec('index.html'), summary, []).composition.beats.find((b) => b.recording)
    const r0 = beat?.recording
    if (!beat || !r0) throw new Error('no recording scene')
    const out = Math.round((r0.in + Math.max(0.6, beat.duration * RATE_RANGE[0] * 0.8)) * 1000) / 1000
    const edited = applyEdits(dec('index.html'), summary, [
      { op: 'span', beat: beat.id, in: r0.in, out },
      {
        op: 'camera',
        beat: beat.id,
        keys: [
          [r0.in, 0.5, 0.5, 1],
          [out, 0.4, 0.4, 1.5, 'power2.inOut'],
        ],
      },
    ] as never)
    expect(edited.html).toMatch(/data-va-rec-hold="end"/)
    files.set('index.html', new TextEncoder().encode(edited.html))
    files.set(`assets/recording/${r0.step}.hold.jpg`, png())
    const asEdit = await finalizeRecording(
      h.deps,
      JOB,
      2,
      { ...version, mode: 'render_unchanged', editedFromN: 1 },
      files,
    )
    console.log(JSON.stringify({ test: 'finalize-recording', case: 'editor hold', ok: asEdit?.ok }))
    expect(asEdit?.ok === false ? asEdit.message : 'ok').toBe('ok')
    const asAuthor = await finalizeRecording(h.deps, JOB, 1, version, files)
    expect(asAuthor?.ok === false && asAuthor.message).toMatch(
      /held frame is only for a scene with a voice line/,
    )
  })

  it('a removed locked entry is redaction_removed', async () => {
    const h = await setup()
    const files = demoFiles()
    const js = new TextDecoder().decode(files.get('assets/recording/redact.js'))
    const entries = JSON.parse(js.slice('window.__vaRedact='.length, -1)) as { id: string }[]
    files.set(
      'assets/recording/redact.js',
      new TextEncoder().encode(`window.__vaRedact=${JSON.stringify(entries.filter((e) => e.id !== 's1'))};`),
    )
    const r = await finalizeRecording(h.deps, JOB, 1, version, files)
    expect(r).toMatchObject({ ok: false, code: 'redaction_removed' })
    expect(r?.ok === false && r.message).toMatch(/^redaction_removed: Hidden area s1/)
  })

  it('a cursor file with an extra statement is recording_file_invalid, naming the scene', async () => {
    const h = await setup()
    const files = demoFiles()
    const js = new TextDecoder().decode(files.get('assets/recording/step-2.cursor.js'))
    files.set('assets/recording/step-2.cursor.js', new TextEncoder().encode(`${js}fetch("x");`))
    const r = await finalizeRecording(h.deps, JOB, 1, version, files)
    expect(r).toMatchObject({ ok: false, code: 'recording_file_invalid', scene: 'step-2' })
    expect(r?.ok === false && r.message).toMatch(/^recording_file_invalid: scene "step-2": /)
  })

  it('locked hidden areas: an unreadable composition, or the recording outside a recording scene, is redaction_removed', async () => {
    const h = await setup()
    const enc = (t: string) => new TextEncoder().encode(t)
    const unreadable = new Map([['index.html', enc('<p>no composition here</p>')]])
    expect(await finalizeRecording(h.deps, JOB, 1, version, unreadable)).toMatchObject({
      ok: false,
      code: 'redaction_removed',
    })
    const raw = new Map([
      [
        'index.html',
        enc(
          `<div id="root" data-composition-id="main" data-va-contract="1" data-duration="5"><section data-va-beat="a" data-composition-id="a" data-start="0" data-duration="5"><video src="assets/media/${ID}.mp4"></video></section></div>`,
        ),
      ],
    ])
    const r = await finalizeRecording(h.deps, JOB, 1, version, raw)
    expect(r).toMatchObject({ ok: false, code: 'redaction_removed' })
    expect(r?.ok === false && r.message).toMatch(/outside a recording scene/)
    // Nothing locked: nothing to protect, so an unreadable one passes with no Hidden list.
    const open = { ...version, recording: { ...rec, trace: null, boxes: [] } }
    expect(await finalizeRecording(h.deps, JOB, 1, open, unreadable)).toMatchObject({
      ok: true,
      recording: { hidden: [] },
    })
  })

  it("a trace whose stored hash doesn't match fails", async () => {
    const h = await setup()
    await h.deps.blobs.set('media', `${ID}/trace.json`, traceText.replace('"v":1', '"v":1 '))
    const r = await finalizeRecording(h.deps, JOB, 1, version, demoFiles())
    expect(r).toMatchObject({ ok: false, code: 'recording_file_invalid' })
  })

  it('an editor box is recorded with its author; checks carry over from the version it was edited from', async () => {
    const h = await setup()
    const checked = { checkedBy: 'u_owner', checkedAt: '2026-11-05T09:00:00.000Z' }
    await h.deps.store.insertVersion({
      jobId: JOB,
      n: 1,
      prompt: 'p',
      authorId: 'u_owner',
      apiKeyId: null,
      targetDurationSec: null,
      parentN: null,
      webhookUrl: null,
      status: 'ready',
      createdAt: '2026-11-05T08:00:00.000Z',
      plan: null,
      recording: {
        ...rec,
        hidden: [
          { id: 't1', source: 'trace', beat: 'step-1', start: 0, end: 10, reason: 'api key', ...checked },
        ],
      },
    } as never)
    const files = demoFiles()
    const html = new TextDecoder().decode(files.get('index.html'))
    files.set(
      'index.html',
      new TextEncoder().encode(
        html.replace(
          `data-va-redact='[]'`,
          `data-va-redact='[{"id":"e1","origin":"editor","start":12,"end":14,"reason":"name","boxes":[[12,0.1,0.1,0.2,0.05]]}]'`,
        ),
      ),
    )
    const r = await finalizeRecording(
      h.deps,
      JOB,
      2,
      { ...version, mode: 'render_unchanged', editedFromN: 1, parentN: 1 },
      files,
    )
    // Version 2 has no media rows here, so only the file name check is skipped.
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.recording.hidden.find((x) => x.id === 'e1')).toMatchObject({
      source: 'editor',
      beat: 'step-2',
      checkedBy: 'u_editor',
    })
    expect(r.recording.hidden.find((x) => x.id === 't1' && x.beat === 'step-1')).toMatchObject(checked)
  })
})

// Through the harness: a demo created over the API, its run saves the composed demo, finalize checks it.
describe('finalize: recording, end to end', () => {
  async function demoVideo(h: ReturnType<typeof harness>) {
    const m = await h.json<{ id: string }>(await upload(h, h.member, png(300, 100), 'filename=screen.png'))
    await h.deps.store.updateMedia(m.id, {
      role: 'screen-recording',
      kind: 'video',
      ext: 'mp4',
      width: 1280,
      height: 720,
      durationSec: 20,
      traceKey: `${m.id}/trace.json`,
      traceSha256: sha(traceText),
    })
    await h.deps.blobs.set('media', `${m.id}/trace.json`, traceText)
    const v = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: {
          prompt: PROMPT,
          recording: { mediaId: m.id, redact: [{ start: 0, end: 20, box: [0.8, 0.02, 0.15, 0.04] }] },
        },
      }),
    )
    return { videoId: v.id, mediaId: m.id }
  }
  /** The composed demo as the run would save it, for this media id. */
  function saved(mediaId: string, mutate?: (files: Map<string, Uint8Array>) => void) {
    const files = new Map<string, Uint8Array>()
    for (const [p, b] of demoFiles())
      files.set(
        p,
        p === 'index.html'
          ? new TextEncoder().encode(new TextDecoder().decode(b).replaceAll(ID, mediaId))
          : b,
      )
    mutate?.(files)
    return tarGz([...files].map(([p, body]) => ({ name: `video/${p}`, body })))
  }

  it('a good demo becomes ready with its Hidden list and summary', async () => {
    const h = harness()
    const { videoId, mediaId } = await demoVideo(h)
    h.deps.nextSource = saved(mediaId)
    await h.drive(4)
    const v = await h.deps.store.getVersion(videoId, 1)
    console.log(
      JSON.stringify({
        test: 'finalize-recording',
        case: 'e2e-good',
        status: v?.status,
        hidden: v?.recording?.hidden.length,
      }),
    )
    expect(v?.status).toBe('ready')
    expect(v?.recording?.summary).toMatchObject({ steps: 2, redactionsAdded: 1 })
    expect(new Set(v?.recording?.hidden.map((x) => x.source))).toEqual(new Set(['trace', 'setup', 'agent']))
  })

  it("privacy mode's output check: what it still read becomes warnings on the version and its DTO, never a failure", async () => {
    const h = harness()
    const { videoId, mediaId } = await demoVideo(h)
    h.deps.nextSource = saved(mediaId)
    h.deps.nextExtra = {
      files: {},
      manifest: {
        privacyCheck: {
          frames: 12,
          stopped: false,
          noted: [
            { t: 1.2, kind: 'email' },
            { t: 1.6, kind: 'email' },
            { t: 0.5, kind: 'string' },
            { t: 600, kind: 'email' },
          ],
        },
      },
    }
    await h.drive(4)
    const v = await h.deps.store.getVersion(videoId, 1)
    expect(v?.status).toBe('ready')
    // One per kind a second; a hide string isn't a warning (it fails the run instead); past the video's end is dropped.
    expect(v?.recording?.privacyNotes).toEqual([{ t: 1.2, kind: 'email' }])
    const dto = await h.json<{ versions: { recording: { privacyWarnings: unknown[] } }[] }>(
      await h.call('GET', `/api/v1/videos/${videoId}`, { as: h.member }),
    )
    console.log(
      JSON.stringify({ test: 'finalize-recording', case: 'privacy-notes', dto: dto.versions[0]?.recording }),
    )
    expect(dto.versions[0]?.recording.privacyWarnings).toEqual([
      { t: 1.2, kind: 'email', warning: 'An email may still be readable at 0:01' },
    ])
  })

  it('a demo that lost a hidden area never becomes ready', async () => {
    const h = harness()
    const { videoId, mediaId } = await demoVideo(h)
    h.deps.nextSource = saved(mediaId, (files) => {
      const js = new TextDecoder().decode(files.get('assets/recording/redact.js'))
      const entries = JSON.parse(js.slice('window.__vaRedact='.length, -1)) as { id: string }[]
      files.set(
        'assets/recording/redact.js',
        new TextEncoder().encode(
          `window.__vaRedact=${JSON.stringify(entries.filter((e) => e.id !== 't1'))};`,
        ),
      )
    })
    await h.drive(4)
    const a = (await h.deps.store.listAttempts(videoId)).at(-1)
    console.log(
      JSON.stringify({
        test: 'finalize-recording',
        case: 'e2e-removed',
        stage: a?.stage,
        error: a?.errorMessage,
      }),
    )
    expect(a?.stage).toBe('failed')
    expect(a?.errorCategory).toBe('invalid_output')
    expect(a?.errorMessage).toMatch(/^redaction_removed: /)
  })
})
