// Setup boxes are shortenable in the editor (screen-final item 1): a demo draft's boxSpan op changes when one of the
// person's setup boxes hides. The draft shows it (the composition's setupBoxes, the rev's redact.js), the patcher
// keeps every other locked entry exactly, a trace area or a span outside the recording is refused, and the rendered
// version stores the new span on its boxes, so finalize checks redact.js against the person's choice.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRedactScript } from '../server/lib/recording.js'
import { readTarGz } from '../server/lib/tar.js'
import type { VersionRecording } from '../server/domain/types.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/contract1-recording/${f}`, import.meta.url), 'utf8')

const SETUP = { start: 0, end: 20, reason: 'Hidden by you', boxes: [[0, 0.8, 0, 0.2, 0.08]] }
const LOCKED = [
  {
    id: 't1',
    origin: 'trace',
    start: 0,
    end: 20,
    reason: 'password field',
    boxes: [[0, 0.3, 0.5, 0.4, 0.04]],
  },
  { id: 's1', origin: 'setup', ...SETUP },
]

async function demoDraft(h: Harness) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
    { name: 'video/assets/recording/redact.js', body: `window.__vaRedact=${JSON.stringify(LOCKED)};` },
    { name: 'video/assets/recording/analysis.json', body: JSON.stringify({ source: { duration: 20 } }) },
  ])
  const v = await h.json<{ id: string }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  await h.drive(4)
  // The version as a demo would have it: the person's one setup box.
  const rec: VersionRecording = {
    mediaId: 'med_rec',
    trace: null,
    trim: null,
    boxes: [SETUP as VersionRecording['boxes'][number]],
    compose: false,
    summary: null,
    hidden: [],
  }
  await h.deps.store.updateVersion(v.id, 1, { recording: rec })
  const e = await h.json<{ id: string; base: { setupBoxes?: unknown } }>(
    await h.call('POST', `/api/v1/videos/${v.id}/versions/1/edits`, { as: h.member }),
  )
  return { id: v.id, edit: e }
}
const save = (h: Harness, id: string, ops: unknown[], rev = 0) =>
  h.call('PUT', `/api/v1/edits/${id}`, { as: h.member, body: { rev, ops } })

describe('setup box spans in the editor', () => {
  it('the draft shows the new span; redact.js changes only that box; the render keeps it on the version', async () => {
    const h = harness()
    const { id, edit } = await demoDraft(h)
    expect(edit.base.setupBoxes).toEqual([{ id: 's1', start: 0, end: 20 }])
    const res = await save(h, edit.id, [{ op: 'boxSpan', id: 's1', start: 2, end: 9.5 }])
    const body = await h.json<{ composition: { setupBoxes?: unknown }; base: { setupBoxes?: unknown } }>(res)
    console.log(JSON.stringify({ test: 'box-span', composition: body.composition.setupBoxes }))
    expect(body.composition.setupBoxes).toEqual([{ id: 's1', start: 2, end: 9.5 }])
    expect(body.base.setupBoxes).toEqual([{ id: 's1', start: 0, end: 20 }])

    const r = await h.call('POST', `/api/v1/edits/${edit.id}/render`, { as: h.member })
    expect(r.status, await r.clone().text()).toBe(202)
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2?.recording?.boxes.map((b) => [b.start, b.end, b.boxes])).toEqual([[2, 9.5, SETUP.boxes]])
    // The frozen bundle's redact.js: the trace area exactly as it was, the setup box with its new span.
    const gz = await h.deps.blobs.get('sources', v2?.frozen?.key ?? '')
    if (!gz) throw new Error('no frozen bundle')
    const files = readTarGz(gz)
    const js = files.get('assets/recording/redact.js')
    const parsed = parseRedactScript(new TextDecoder().decode(js))
    expect(parsed.ok && parsed.entries).toEqual([LOCKED[0], { ...LOCKED[1], start: 2, end: 9.5 }])
  })

  it('refuses a trace area, an unknown box, an inside-out span and one past the recording', async () => {
    const h = harness()
    const { edit } = await demoDraft(h)
    const cases: [unknown, RegExp][] = [
      [{ op: 'boxSpan', id: 't1', start: 0, end: 5 }, /only the boxes you drew can change/],
      [{ op: 'boxSpan', id: 's9', start: 0, end: 5 }, /no hidden area s9/],
      [{ op: 'boxSpan', id: 's1', start: 6, end: 5 }, /must start before it ends/],
      [{ op: 'boxSpan', id: 's1', start: 0, end: 30 }, /must end inside the recording/],
    ]
    for (const [op, msg] of cases) {
      const res = await save(h, edit.id, [op])
      const text = await res.text()
      console.log(JSON.stringify({ test: 'box-span', op, status: res.status }))
      expect(res.status).toBe(400)
      expect(text).toMatch(msg)
    }
  })
})
