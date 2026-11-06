// One engine per video (render-engines plan §4.2): every derived version takes its parent's engine, a mismatch is
// refused as engine_mismatch, and the version DTO says which engine made it and what its editor may offer.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { encrypt } from '../src/lib/crypto.js'
import { assertSameEngine, engineInfo } from '../src/domain/engines.js'
import { ApiError } from '../src/lib/errors.js'
import { failedSnap, running } from './fakes.js'
import { editableVideo, harness, PROMPT, readyVideo, type Harness } from './helpers.js'

/** A ready video whose v1 is marked as made by Remotion, as only a Remotion deployment (Phase 2) would make it. */
async function remotionVideo(h: Harness) {
  const id = await readyVideo(h)
  await h.deps.store.updateVersion(id, 1, { engine: 'remotion' })
  return id
}
const engineOfVersion = async (h: Harness, id: string, n: number) =>
  (await h.deps.store.getVersion(id, n))?.engine

describe('one engine per video', () => {
  it('a new video is HyperFrames, and its DTO says so next to editable', async () => {
    const h = harness()
    const id = await readyVideo(h)
    expect(await engineOfVersion(h, id, 1)).toBe('hyperframes')
    const dto = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(dto.versions[0]).toMatchObject({
      editable: false,
      editing: { engine: 'hyperframes', capabilities: engineInfo('hyperframes').capabilities },
    })
  })

  it('a revision takes its parent’s engine', async () => {
    const h = harness()
    const id = await remotionVideo(h)
    expect(
      (await h.call('POST', `/api/v1/videos/${id}/versions`, { as: h.member, body: { prompt: 'Warmer.' } }))
        .status,
    ).toBe(202)
    expect(await engineOfVersion(h, id, 2)).toBe('remotion')
    const dto = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(dto.versions.find((x: { n: number }) => x.n === 2).editing).toEqual({
      engine: 'remotion',
      capabilities: engineInfo('remotion').capabilities,
    })
  })

  it('incorporating feedback takes the engine of the version the comments are on', async () => {
    const h = harness()
    const id = await remotionVideo(h)
    const c = await h.json(
      await h.call('POST', `/api/v1/videos/${id}/comments`, {
        as: h.member,
        body: { versionN: 1, body: 'Bigger logo' },
      }),
    )
    const res = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Incorporate the feedback.', fromVersion: 1, commentIds: [c.id] },
    })
    expect(res.status).toBe(202)
    expect(await engineOfVersion(h, id, 2)).toBe('remotion')
  })

  it('a remix is made the way its source was', async () => {
    const h = harness()
    const id = await remotionVideo(h)
    const res = await h.call('POST', `/api/v1/videos/${id}/remix`, {
      as: h.member,
      body: { prompt: 'Same video, for the payments API.' },
    })
    expect(res.status).toBe(202)
    const remix = await h.json(res)
    expect(await engineOfVersion(h, remix.id, 1)).toBe('remotion')
  })

  it('an edit renders with its base’s engine', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const e = await h.json(await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }))
    await h.call('PUT', `/api/v1/edits/${e.id}`, {
      as: h.member,
      body: { rev: 0, ops: [{ op: 'retime', beat: 'intro', duration: 4 }] },
    })
    const res = await h.call('POST', `/api/v1/edits/${e.id}/render`, {
      as: h.member,
      headers: { 'idempotency-key': 'k1' },
    })
    expect(res.status).toBe(202)
    expect(await engineOfVersion(h, id, 2)).toBe('hyperframes')
  })

  it('Try again keeps the version, so it keeps its engine', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const id = await readyVideo(h)
    await h.deps.store.updateVersion(id, 1, { engine: 'remotion' })
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/1/retry`, { as: h.admin })).status).toBe(202)
    await h.drive(4)
    expect(await engineOfVersion(h, id, 1)).toBe('remotion')
  })

  it('refuses a version whose engine differs from its parent’s, and logs it', () => {
    const h = harness()
    const parent = { jobId: 'vid_1', n: 1, engine: 'remotion' as const }
    let err: unknown
    try {
      assertSameEngine(h.deps, parent, { jobId: 'vid_1', n: 2, engine: 'hyperframes' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'engine_mismatch', status: 409 })
    const line = h.deps.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'engine.mismatch')
    expect(line).toMatchObject({ jobId: 'vid_1', n: 2, parentEngine: 'remotion', engine: 'hyperframes' })
    // A row from before engines is HyperFrames on both sides.
    expect(() =>
      assertSameEngine(h.deps, { jobId: 'vid_1', n: 1 }, { jobId: 'vid_1', n: 2, engine: 'hyperframes' }),
    ).not.toThrow()
  })

  it('the video.ready webhook carries the editing field', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.member })
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.putUserWebhook({
      userId: 'u_member',
      url: 'https://me.example.com/hook',
      secretEnc: encrypt((await getSettings(h.deps)).dataEncryptionKey, 's'),
      createdAt: now,
      updatedAt: now,
    })
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(4)
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })
    const raw = h.deps.http.calls[0]?.body ?? '{}'
    const body = JSON.parse(raw) as { event?: string }
    expect(body.event).toBe('video.ready')
    // Webhooks embed the video DTO (shared rule 10), so the new field reaches them with no change of their own.
    expect(raw).toContain('"editing":{"engine":"hyperframes"')
  })
})
