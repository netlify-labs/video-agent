// Render picture first (plan 2026-11-02 §2.1, §5.3): with timing edits pending, the editor renders the draft's other
// ops as a normal new version, without its narration op (excludeNarration), then moves the narration onto that
// version with rebase-narration, ready to record against the new picture.
import { describe, expect, it } from 'vitest'
import { contractSource, editableVideo, harness, narrationTake, stubNetlify } from './helpers.js'
import { narrationAt as narration } from './narration-render.js'

describe('render picture first', () => {
  stubNetlify()

  async function setup() {
    const h = harness()
    const id = await editableVideo(h)
    const take = await narrationTake(h, id)
    const e = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }),
    )
    const lock = () =>
      h.call('POST', `/api/v1/videos/${id}/narration-lock/take-over`, {
        as: h.member,
        body: { draftId: e.id },
      })
    await lock()
    const ops = [{ op: 'retime', beat: 'intro', duration: 4 }, narration(take)]
    expect(
      (await h.call('PUT', `/api/v1/edits/${e.id}`, { as: h.member, body: { rev: 0, ops } })).status,
    ).toBe(200)
    const render = (body: object) =>
      h.call('POST', `/api/v1/edits/${e.id}/render`, {
        as: h.member,
        body: { mode: 'keep_visuals', ...body },
      })
    const rebase = (toN: number) =>
      h.call('POST', `/api/v1/edits/${e.id}/rebase-narration`, { as: h.member, body: { toN } })
    return { h, id, take, editId: e.id, render, rebase, lock }
  }

  it('freezes the timing edits without the narration, then moves the narration onto the new version', async () => {
    const { h, id, take, editId, render, rebase, lock } = await setup()
    const res = await render({ excludeNarration: true })
    expect(res.status).toBe(202)
    const v2 = await h.deps.store.getVersion(id, 2)
    // A normal new version of the picture: the retime's length, no frozen narration, no takes held by the attempt.
    expect(v2).toMatchObject({ mode: 'render_unchanged', editedFromN: 1, targetDurationSec: 10 })
    expect(v2?.frozen?.editId).toBe(editId)
    expect(v2?.frozen?.narration).toBeUndefined()
    expect(
      h.deps.logs.some((l) => l.includes('"edit.render"') && l.includes('"excludeNarration":true')),
    ).toBe(true)
    // The draft keeps its narration op; it can't move onto a version that isn't ready yet.
    const draft = await h.json<{ ops: { op: string }[]; renderedN: number }>(
      await h.call('GET', `/api/v1/edits/${editId}`, { as: h.member }),
    )
    expect(draft.renderedN).toBe(2)
    expect(draft.ops.map((o) => o.op)).toEqual(['retime', 'narration'])
    expect((await rebase(2)).status).toBe(409)
    h.deps.nextSource = contractSource()
    await h.drive(6)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('ready')
    // Onto v2, the version it made (the editor's heartbeat keeps the lock meanwhile; here the clock ran past it):
    // only the narration moves, since the retime is v2's picture now.
    await lock()
    const moved = await rebase(2)
    expect(moved.status).toBe(201)
    expect(await h.json(moved)).toMatchObject({ baseN: 2, rev: 1, ops: [narration(take)] })
    // Never onto another version.
    expect((await rebase(1)).status).toBe(409)
  }, 60_000)

  it('a normal render of the same draft still freezes the narration, and then nothing rebases', async () => {
    const { h, id, render, rebase, lock } = await setup()
    expect((await render({})).status).toBe(202)
    expect((await h.deps.store.getVersion(id, 2))?.frozen?.narration).toBeDefined()
    h.deps.nextSource = contractSource()
    await h.drive(6)
    await lock()
    expect((await rebase(2)).status).toBe(409)
  }, 60_000)

  it('refuses holding the last frame without the narration', async () => {
    const { render } = await setup()
    const res = await render({ excludeNarration: true, holdFinalFrame: true })
    expect(res.status).toBe(400)
  }, 60_000)
})
