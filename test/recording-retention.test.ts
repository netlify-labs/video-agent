// Screen recording retention, GC and quota (screen-recording plan §4.2, §9; va-rsk5.2.6): an unused recording goes
// 30 days after upload, or 30 days after the last video using it was deleted (the sweep starts that clock), never while
// a video uses it; the trace goes with it; a create racing GC either wins (GC skips) or gets 410 gone; screen
// recordings have their own budget, separate from takes; "Delete unused recordings" clears both kinds. On the memory
// store and PGlite with a fake clock; one JSON line per sweep decision (logged by the sweep itself).
import { describe, expect, it } from 'vitest'
import { lockRecordings, sweepRecordings } from '../src/domain/recording-retention.js'
import { NO_PROVENANCE, type MediaRow, type VersionMediaRow } from '../src/domain/types.js'
import { ApiError } from '../src/lib/errors.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, readyVideo, type Harness } from './helpers.js'

const DAY = 24 * 3600_000
const MiB = 1024 * 1024
const budget = () => ({ deadline: Date.now() + 60_000 })

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

/** A ready screen recording (or take) of Mia's, with its file and a trace in the media store. */
async function item(h: Harness, id: string, over: Partial<MediaRow> = {}) {
  const at = h.deps.clock.now().toISOString()
  await h.deps.blobs.set('media', `${id}/original.mp4`, new Uint8Array(16))
  await h.deps.blobs.set('media', `${id}/trace.json`, new TextEncoder().encode('{}'))
  await h.deps.store.insertMedia({
    id,
    uploaderId: 'u_member',
    kind: 'video',
    status: 'ready',
    rejectReason: null,
    filename: `${id}.mp4`,
    title: null,
    caption: null,
    mime: 'video/mp4',
    ext: 'mp4',
    bytes: MiB,
    originalKey: `${id}/original.mp4`,
    originalSha256: 'a'.repeat(64),
    cleanKey: `${id}/original.mp4`,
    cleanSha256: 'a'.repeat(64),
    width: 320,
    height: 180,
    durationSec: 3,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role: 'screen-recording',
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    traceKey: `${id}/trace.json`,
    traceSha256: 'b'.repeat(64),
    ...NO_PROVENANCE,
    ...over,
  })
  return id
}

const use = (jobId: string, mediaId: string): VersionMediaRow => ({
  jobId,
  versionN: 1,
  mediaId,
  position: 0,
  kind: 'video',
  key: `${mediaId}/original.mp4`,
  sha256: 'a'.repeat(64),
  filename: `${mediaId}.mp4`,
  caption: null,
})

const gone = async (h: Harness, id: string) => {
  const m = await h.deps.store.getMedia(id)
  return !!m?.deletedAt && (await h.deps.blobs.list('media', `${id}/`)).length === 0
}

describe.each(stores)('screen recording retention (%s)', (_store, make) => {
  it('an unused recording goes 30 days after upload, with its trace', async () => {
    const h = harness({}, { store: await make() })
    const id = await item(h, 'med_rec')
    h.deps.clock.advance(29 * DAY)
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(false)
    h.deps.clock.advance(2 * DAY)
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(true)
  })

  it('a used recording stays; once its video is deleted, it goes 30 days later', async () => {
    const h = harness({}, { store: await make() })
    const id = await item(h, 'med_used')
    const job = await readyVideo(h)
    await h.deps.store.insertVersionMedia([use(job, id)])
    h.deps.clock.advance(40 * DAY)
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(false)
    expect((await h.call('DELETE', `/api/v1/videos/${job}`, { as: h.member })).status).toBeLessThan(300)
    // The first sweep after the deletion starts the clock (it's past upload + 30 days, but that doesn't count).
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(false)
    expect((await h.deps.store.getMedia(id))?.retainUntil).toBe(
      new Date(h.deps.clock.now().getTime() + 30 * DAY).toISOString(),
    )
    h.deps.clock.advance(29 * DAY)
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(false)
    h.deps.clock.advance(2 * DAY)
    await sweepRecordings(h.deps, budget())
    expect(await gone(h, id)).toBe(true)
  })

  it('a create racing GC: either GC skips the recording or the create gets 410 gone, never both', async () => {
    const h = harness({}, { store: await make() })
    const id = await item(h, 'med_race')
    const job = await readyVideo(h)
    h.deps.clock.advance(31 * DAY)
    const create = h.deps.store
      .tx(async (repo) => {
        await lockRecordings(repo, [id])
        await repo.insertVersionMedia([use(job, id)])
        return 'created' as const
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'gone') return 'gone' as const
        throw e
      })
    const [created] = await Promise.all([create, sweepRecordings(h.deps, budget())])
    const deleted = await gone(h, id)
    console.log(JSON.stringify({ test: 'race', created, deleted }))
    expect(created === 'created' ? !deleted : deleted).toBe(true)
    // After the sweep, a create always sees the outcome.
    if (deleted)
      await expect(h.deps.store.tx((repo) => lockRecordings(repo, [id]))).rejects.toMatchObject({
        code: 'gone',
      })
  })

  it('has its own budget: 413 with what is left, apart from takes', async () => {
    const h = harness({}, { store: await make() })
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { recordingQuotaBytes: 3 * MiB } })
    await item(h, 'med_a', { bytes: 2 * MiB })
    await item(h, 'med_take', { role: 'narration-take', kind: 'audio', bytes: 50 * MiB })
    expect(await h.deps.store.screenRecordingBytes('u_member')).toBe(2 * MiB)
    expect(await h.deps.store.narrationTakeBytes('u_member')).toBe(50 * MiB)
    const res = await h.call('POST', '/api/v1/media/uploads', {
      as: h.member,
      body: { filename: 'b.mp4', size: 2 * MiB, sha256: 'c'.repeat(64), role: 'screen-recording' },
    })
    const body = await h.json<{ error: { code: string; message: string } }>(res)
    console.log(JSON.stringify({ test: 'quota', status: res.status, message: body.error.message }))
    expect(res.status).toBe(413)
    expect(body.error.message).toBe(
      'Your screen recordings have 1 MB of 3 MB left, not enough for this one (2 MB). Delete unused recordings on the Media page, or ask an admin for more space.',
    )
  })

  it('"Delete unused recordings" clears unused takes and screen recordings, not used ones', async () => {
    const h = harness({}, { store: await make() })
    const rec = await item(h, 'med_unused')
    const take = await item(h, 'med_unused_take', { role: 'narration-take', kind: 'audio', traceKey: null })
    const kept = await item(h, 'med_kept')
    const job = await readyVideo(h)
    await h.deps.store.insertVersionMedia([use(job, kept)])
    const res = await h.call('POST', '/api/v1/media/recordings/delete-unused', { as: h.member, body: {} })
    expect(await h.json(res)).toEqual({ deleted: 2 })
    expect(await gone(h, rec)).toBe(true)
    expect(await gone(h, take)).toBe(true)
    expect(await gone(h, kept)).toBe(false)
  })
})
