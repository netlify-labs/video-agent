// The narration MCP tools (plan 2026-11-02 §7): get_narration, add_narration (media ids only, under the narration
// lock) and render_with_narration (keep visuals; fit refused for now; a draft without narration refused), and the
// video's language in get_video.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKey, editableVideo, harness, mcpCall, narrationTake, person, type Harness } from './helpers.js'

async function tool(h: Harness, key: string, name: string, args: Record<string, unknown>) {
  const result = (await mcpCall(h, key, 'tools/call', { name, arguments: args })) as {
    structuredContent: any
    isError?: boolean
  }
  return { data: result.structuredContent, isError: result.isError === true }
}

/** A ready, editable video (9 s, contract v1), a key for its owner and a 2 s take of theirs. */
async function setup() {
  const h = harness()
  const id = await editableVideo(h)
  const take = (as = h.member) => narrationTake(h, id, as, 2)
  return { h, id, key: await apiKey(h, h.member), take }
}

describe('MCP narration tools', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  it('adds a recording to a draft, reads it back and renders it with the visuals kept', async () => {
    const { h, id, key, take } = await setup()
    const media = await take()
    const empty = await tool(h, key, 'get_narration', { video_id: id })
    expect(empty.data).toMatchObject({ video_id: id, version: 1, language: 'en', narration: null })
    expect(empty.data.draft).toBeUndefined()

    const added = await tool(h, key, 'add_narration', { video_id: id, media_id: media, start_seconds: 1.5 })
    expect(added.isError).toBe(false)
    expect(added.data).toMatchObject({
      version: 1,
      clip_id: 'c1',
      narration: { clips: [{ media_id: media, start_seconds: 1.5, length_seconds: 2, gain_db: 0 }] },
    })
    expect(added.data.narration.end_seconds).toBe(3.5)
    expect(added.data.next_actions[0]).toContain('costs credits')
    // A second one goes after it, at its own level; the lock is already mine.
    const more = await tool(h, key, 'add_narration', {
      video_id: id,
      media_id: media,
      start_seconds: 5,
      gain_db: -3,
    })
    expect(more.data.clip_id).toBe('c2')
    const lock = await h.json<{ mine: boolean }>(
      await h.call('GET', `/api/v1/videos/${id}/narration-lock`, { as: h.member }),
    )
    expect(lock.mine).toBe(true)

    const got = await tool(h, key, 'get_narration', { video_id: id })
    expect(got.data.draft).toMatchObject({ edit_id: added.data.edit_id, rev: 2 })
    expect(got.data.draft.narration.clips.map((c: { gain_db: number }) => c.gain_db)).toEqual([0, -3])
    expect(got.data.next_actions[0]).toContain('render_with_narration')

    const rendered = await tool(h, key, 'render_with_narration', {
      video_id: id,
      mode: 'keep_visuals',
      hold_final_frame: true,
    })
    expect(rendered.isError).toBe(false)
    expect(rendered.data).toMatchObject({ latest_version: 2, language: 'en' })
    expect(rendered.data.next_actions[0]).toContain('get_video')
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2?.frozen?.narration?.takes.map((t) => t.mediaId)).toEqual([media])
    expect((await tool(h, key, 'get_narration', { video_id: id, version: 1 })).data.narration).toBeNull()
    // Once v2 is ready, its narration is the one it was rendered with.
    await h.drive(4)
    const v2n = await tool(h, key, 'get_narration', { video_id: id, version: 2 })
    expect(v2n.data.narration.clips.map((c: { start_seconds: number }) => c.start_seconds)).toEqual([1.5, 5])
  })

  it("can't use media the caller can't read, or URLs", async () => {
    const { h, id, key } = await setup()
    const cora = await person(h, 'u_cora', 'creator')
    const coras = await narrationTake(h, id, cora, 2)
    for (const media_id of [coras, 'med_nothere00', 'https://example.com/take.mp3']) {
      const r = await tool(h, key, 'add_narration', { video_id: id, media_id, start_seconds: 0 })
      expect(r.isError).toBe(true)
      expect(r.data.error.type).toBe('NOT_FOUND')
      expect(r.data.error.data.suggested_tool_calls[0].name).toBe('list_media')
    }
    expect(await h.deps.store.getNarrationLock(id)).toBeNull()
  })

  it('says who holds the narration lock, and saves nothing', async () => {
    const { h, id, key, take } = await setup()
    const media = await take()
    const dana = await person(h, 'u_dana', 'creator')
    const draft = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: dana }),
    )
    await h.call('POST', `/api/v1/videos/${id}/narration-lock`, { as: dana, body: { draftId: draft.id } })
    const r = await tool(h, key, 'add_narration', { video_id: id, media_id: media, start_seconds: 0 })
    expect(r.isError).toBe(true)
    expect(r.data.error).toMatchObject({
      type: 'NARRATION_LOCKED',
      message: 'u_dana is editing the narration.',
    })
    expect(r.data.error.data.details.holder).toMatchObject({ userId: 'u_dana' })
    expect((await tool(h, key, 'get_narration', { video_id: id })).data.draft.narration).toBeNull()
  })

  it('fits to the narration as an authoring version, and refuses a draft without narration', async () => {
    const { h, id, key, take } = await setup()
    const none = await tool(h, key, 'render_with_narration', { video_id: id, mode: 'keep_visuals' })
    expect(none.data.error.type).toBe('NOT_FOUND')
    // A draft with other edits only.
    const draft = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }),
    )
    await h.call('PUT', `/api/v1/edits/${draft.id}`, {
      as: h.member,
      body: { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4 }] },
    })
    const plain = await tool(h, key, 'render_with_narration', { video_id: id, mode: 'keep_visuals' })
    expect(plain.data.error).toMatchObject({ type: 'INVALID_ARGUMENT' })
    expect(plain.data.error.message).toContain('no narration')
    await tool(h, key, 'add_narration', { video_id: id, media_id: await take(), start_seconds: 0 })
    const fit = await tool(h, key, 'render_with_narration', {
      video_id: id,
      edit_id: draft.id,
      mode: 'fit_to_narration',
    })
    expect(fit.data.error).toBeUndefined()
    // An authoring run from the draft, the AI voice replaced (plan 2026-11-02 §6.4).
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2).toMatchObject({ mode: 'author', editedFromN: 1 })
    expect(v2?.frozen?.narration?.op.tracks.aiVoice.mode).toBe('replace')
  })

  it("exposes the video's language and sets it when adding narration", async () => {
    const { h, id, key, take } = await setup()
    expect((await tool(h, key, 'get_video', { video_id: id })).data.language).toBe('en')
    const r = await tool(h, key, 'add_narration', {
      video_id: id,
      media_id: await take(),
      start_seconds: 0,
      language: 'de',
    })
    expect(r.data.language).toBe('de')
    expect((await tool(h, key, 'get_video', { video_id: id })).data.language).toBe('de')
    expect((await tool(h, key, 'get_narration', { video_id: id })).data.language).toBe('de')
    const bad = await tool(h, key, 'add_narration', {
      video_id: id,
      media_id: 'med_x',
      start_seconds: 0,
      language: 'klingon',
    })
    expect(bad.isError).toBe(true)
  })
})
