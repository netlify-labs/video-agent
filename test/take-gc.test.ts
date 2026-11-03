// Two-phase GC for narration takes (plan 2026-11-02 §8): unreferenced takes past their retention (or that their
// uploader asked to delete) are tombstoned with a deletion work item under the row lock, then their bytes go outside
// the transaction, retried with backoff. Referenced takes never lose bytes. Stale narration locks are reaped.
import { describe, expect, it } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import {
  NARRATION_LOCK_STALE_MS,
  replaceDraftRefs,
  sweepTakes,
  TAKE_RETAIN_MS,
  takePeaksKey,
  takeTranscriptPrefix,
} from '../src/domain/takes.js'
import type { MediaRow } from '../src/domain/types.js'
import { ApiError } from '../src/lib/errors.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Store } from '../src/store/types.js'
import { harness, person, pgStore, png, readyVideo, upload, type Harness } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const DAY = 24 * 3600_000
const budget = () => ({ deadline: Date.now() + 30_000, maxItems: 20 })
const iso = (h: Harness, offsetMs = 0) => new Date(h.deps.clock.now().getTime() + offsetMs).toISOString()

let seq = 0
/** One of `as`'s takes, with the bytes a take keeps: the original and meta.json, peaks and a cached transcript. */
async function take(h: Harness, as: string, patch: Partial<MediaRow> = {}) {
  const m = await h.json<{ id: string }>(
    await upload(h, as, png(300 + seq++, 100), `filename=take${seq}.png`),
  )
  await h.deps.store.updateMedia(m.id, { role: 'narration-take', kind: 'audio', ...patch })
  await h.deps.blobs.set('media', takePeaksKey(m.id), new Uint8Array([1, 2, 3]))
  await h.deps.blobs.set('media', `${takeTranscriptPrefix(m.id)}local.json`, '{"words":[]}')
  return m.id
}

const keys = (h: Harness, id: string) => h.deps.blobs.list('media', `${id}/`)
const pending = async (h: Harness) =>
  (await h.deps.store.listDueCleanup('9999-01-01T00:00:00.000Z', 100)).filter((c) => c.kind === 'delete_take')

async function expectGone(h: Harness, id: string, label = id) {
  expect(await keys(h, id), label).toEqual([])
  const m = await h.deps.store.getMedia(id)
  expect(m?.deletingAt, label).toBeTruthy()
  expect(m?.deletedAt, label).toBeTruthy()
}
async function expectKept(h: Harness, id: string, label = id) {
  expect((await keys(h, id)).length, label).toBeGreaterThan(2)
  expect((await h.deps.store.getMedia(id))?.deletingAt ?? null, label).toBeNull()
}

describe.each(stores)('take GC (%s)', (_name, make) => {
  it('deletes only unreferenced takes whose retention passed, with all their bytes', async () => {
    const h = harness({}, { store: await make() })
    const jobId = await readyVideo(h)
    const expired = await take(h, h.member, { retainUntil: iso(h, -1000) })
    const retained = await take(h, h.member, { retainUntil: iso(h, DAY) })
    const used = await take(h, h.member, { retainUntil: iso(h, -1000) })
    await h.deps.store.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [used]))
    const softDeleted = await take(h, h.member, { retainUntil: iso(h, -1000), deletedAt: iso(h, -2000) })
    const fresh = await take(h, h.member)
    const library = await h.json<{ id: string }>(await upload(h, h.member, png(90, 90), 'filename=logo.png'))
    await h.deps.store.updateMedia(library.id, { retainUntil: iso(h, -1000) })

    await runCleanup(h.deps, budget())
    await expectGone(h, expired, 'expired')
    // Soft delete never overrides retention, nor does it block GC once nothing holds the take.
    await expectGone(h, softDeleted, 'soft-deleted')
    await expectKept(h, retained, 'retained')
    await expectKept(h, used, 'used')
    await expectKept(h, fresh, 'never referenced, made just now')
    expect((await keys(h, library.id)).length).toBeGreaterThan(0)
    expect((await h.deps.store.getMedia(library.id))?.deletingAt).toBeNull()
    expect(await pending(h)).toEqual([])

    // A take nothing ever referenced (no retain_until) goes 30 days after it was made.
    h.deps.clock.advance(TAKE_RETAIN_MS + 60_000)
    await runCleanup(h.deps, budget())
    await expectGone(h, fresh, 'never referenced, 30 days on')
    await expectGone(h, retained, 'retention passed')
    await expectKept(h, used, 'used')
    expect(await h.deps.store.listMediaRefsByMedia([used])).toHaveLength(1)
  })

  it('stays bounded: at most a batch per tick', async () => {
    const h = harness({}, { store: await make() })
    const ids: string[] = []
    for (let i = 0; i < 23; i++) ids.push(await take(h, h.member, { retainUntil: iso(h, -1000) }))
    expect(await sweepTakes(h.deps, budget())).toBe(20)
    expect(await sweepTakes(h.deps, budget())).toBe(3)
    for (const id of ids) await expectGone(h, id)
  })

  it('races with a concurrent save: exactly one wins, and a used take keeps its bytes', async () => {
    const h = harness({}, { store: await make() })
    const jobId = await readyVideo(h)
    for (let round = 0; round < 4; round++) {
      const id = await take(h, h.member, { retainUntil: iso(h, -1000) })
      const save = h.deps.store
        .tx((repo) => replaceDraftRefs(repo, h.deps, `edt_${round}`, jobId, [id]))
        .then(
          () => 'saved',
          (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
        )
      const gc = sweepTakes(h.deps, budget())
      const [saved] = round % 2 ? await Promise.all([save, gc]) : [(await Promise.all([gc, save]))[1]]
      const refs = await h.deps.store.listMediaRefsByMedia([id])
      if (saved === 'saved') {
        expect(refs, `round ${round}`).toHaveLength(1)
        await expectKept(h, id, `round ${round}`)
      } else {
        expect(saved, `round ${round}`).toBe('take_deleted')
        expect(refs, `round ${round}`).toEqual([])
        await expectGone(h, id, `round ${round}`)
      }
    }
  })

  it('a release that bumps retention just before GC locks the row keeps the take', async () => {
    const h = harness({}, { store: await make() })
    const jobId = await readyVideo(h)
    const id = await take(h, h.member, { retainUntil: iso(h, -1000) })
    await h.deps.store.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [id]))
    // Discarding the draft releases it: its 30 days start now, so GC (which re-checks under the lock) keeps it.
    await h.deps.store.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, []))
    await runCleanup(h.deps, budget())
    await expectKept(h, id)
  })

  it('retries a failed Blob deletion with backoff, then marks the take deleted', async () => {
    const h = harness({}, { store: await make() })
    const id = await take(h, h.member, { retainUntil: iso(h, -1000) })
    const del = h.deps.blobs.delete.bind(h.deps.blobs)
    let failures = 3
    h.deps.blobs.delete = async (s, k) => {
      if (failures > 0) {
        failures--
        throw new Error('blobs unavailable')
      }
      return del(s, k)
    }
    const started = h.deps.clock.now().getTime()
    await runCleanup(h.deps, budget())
    // Tombstoned (so nobody can read or reference it), bytes still there, retried in a minute.
    const m = await h.deps.store.getMedia(id)
    expect(m?.deletingAt).toBeTruthy()
    expect(m?.deletedAt).toBeNull()
    expect((await h.call('GET', `/api/v1/media/${id}`, { as: h.member })).status).toBe(404)
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      const [item] = await pending(h)
      expect(item?.kind).toBe('delete_take')
      waits.push(Date.parse(item?.nextActionAt ?? '') - started)
      if (i === 2) break
      h.deps.clock.t = Date.parse(item?.nextActionAt ?? '')
      await runCleanup(h.deps, budget())
    }
    // Each wait is as long as it has been failing: 1, 2, 4 minutes after the first try.
    expect(waits).toEqual([60_000, 120_000, 240_000])
    h.deps.clock.t = started + 240_000
    await runCleanup(h.deps, budget())
    await expectGone(h, id)
    expect(await pending(h)).toEqual([])
  })

  it("POST /media/recordings/delete-unused deletes only the caller's unreferenced takes, at once", async () => {
    const h = harness({}, { store: await make() })
    const jobId = await readyVideo(h)
    const cora = await person(h, 'u_cora', 'creator')
    const viewer = await person(h, 'u_vic', 'viewer')
    const unused = await take(h, h.member)
    const retained = await take(h, h.member, { retainUntil: iso(h, DAY) })
    const used = await take(h, h.member)
    await h.deps.store.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [used]))
    const coras = await take(h, cora)
    const library = await h.json<{ id: string }>(await upload(h, h.member, png(91, 91), 'filename=logo.png'))

    const res = await h.call('POST', '/api/v1/media/recordings/delete-unused', { as: h.member })
    expect(res.status).toBe(200)
    expect(await h.json(res)).toEqual({ deleted: 2 })
    await expectGone(h, unused)
    await expectGone(h, retained)
    await expectKept(h, used)
    await expectKept(h, coras)
    expect((await keys(h, library.id)).length).toBeGreaterThan(0)
    const listed = await h.json<{ items: { id: string }[] }>(
      await h.call('GET', '/api/v1/media', { as: h.member }),
    )
    expect(listed.items.map((m) => m.id).sort()).toEqual([library.id, used].sort())

    expect(
      await h.json(await h.call('POST', '/api/v1/media/recordings/delete-unused', { as: h.member })),
    ).toEqual({
      deleted: 0,
    })
    expect(
      await h.json(await h.call('POST', '/api/v1/media/recordings/delete-unused', { as: viewer })),
    ).toEqual({
      deleted: 0,
    })
    await expectKept(h, coras)
  })

  it('reaps narration locks whose heartbeat is over two minutes old', async () => {
    const h = harness({}, { store: await make() })
    const lock = (jobId: string, ageMs: number) => ({
      jobId,
      holderId: 'u_member',
      draftId: 'edt_1',
      acquiredAt: iso(h, -ageMs),
      heartbeatAt: iso(h, -ageMs),
    })
    await h.deps.store.upsertNarrationLock(lock('job_stale', NARRATION_LOCK_STALE_MS + 1000))
    await h.deps.store.upsertNarrationLock(lock('job_live', 30_000))
    await runCleanup(h.deps, budget())
    expect(await h.deps.store.getNarrationLock('job_stale')).toBeNull()
    expect(await h.deps.store.getNarrationLock('job_live')).toEqual(lock('job_live', 30_000))
  })
})
