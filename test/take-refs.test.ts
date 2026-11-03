// media_refs writers and the take-row lock protocol (plan 2026-11-02 §6.1, §8): every writer locks the takes it
// references (media-id order) inside its transaction and refuses one GC has begun deleting, so a reference and GC's
// tombstone never both win; releasing a reference starts the take's 30 days.
import { describe, expect, it } from 'vitest'
import { discardEdit, deleteExpiredEdits } from '../src/domain/edits.js'
import type { Principal } from '../src/domain/policy.js'
import {
  addAttemptRefs,
  promoteAttemptRefs,
  releaseOwnerRefs,
  replaceDraftRefs,
  TAKE_RETAIN_MS,
} from '../src/domain/takes.js'
import type { EditRow } from '../src/domain/types.js'
import { ApiError } from '../src/lib/errors.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Repo, Store } from '../src/store/types.js'
import { harness, pgStore, png, readyVideo, upload, type Harness } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const mia: Principal = {
  kind: 'user',
  userId: 'u_member',
  email: 'mia@acme.com',
  name: 'Mia Member',
  role: 'creator',
  apiKeyId: null,
}

/** n of Mia's takes for the video. */
async function takes(h: Harness, jobId: string, n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const m = await h.json<{ id: string }>(
      await upload(h, h.member, png(200 + i, 100), `filename=take${i}.png`),
    )
    await h.deps.store.updateMedia(m.id, { role: 'narration-take', kind: 'audio', scopeJobId: jobId })
    ids.push(m.id)
  }
  return ids.sort()
}

function draft(h: Harness, jobId: string, id = 'edt_1', expiresAt = '2099-01-01T00:00:00.000Z'): EditRow {
  const now = h.deps.clock.now().toISOString()
  return {
    id,
    jobId,
    baseN: 1,
    authorId: 'u_member',
    rev: 0,
    ops: [],
    bundleSha256: null,
    renderedN: null,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  }
}

async function setup(store: Store, n = 3) {
  const h = harness({}, { store })
  const jobId = await readyVideo(h)
  const ids = await takes(h, jobId, n)
  return { h, jobId, ids }
}

const owned = async (repo: Repo, kind: 'draft' | 'frozen_attempt' | 'version', id: string) =>
  (await repo.listMediaRefsByOwner(kind, id)).map((r) => r.mediaId).sort()

/** GC's first phase, as the lock protocol needs it: under the lock, no references left, then the tombstone. */
const tombstone = (store: Store, mediaId: string, at: string) =>
  store.tx(async (repo) => {
    const [m] = await repo.lockMedia([mediaId])
    if (!m || m.deletingAt || (await repo.listMediaRefsByMedia([mediaId])).length) return false
    await repo.updateMedia(mediaId, { deletingAt: at })
    return true
  })

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : String(e)
  }
}

describe.each(stores)('take references (%s)', (_name, make) => {
  it("a draft's references are exactly its last save; dropped takes start their 30 days", async () => {
    const { h, jobId, ids } = await setup(await make())
    const [a, b, c] = ids as [string, string, string]
    const s = h.deps.store
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [a, b, b]))
    expect(await owned(s, 'draft', 'edt_1')).toEqual([a, b])
    // c is also on a version, so dropping it from the draft doesn't release it.
    await s.insertMediaRefs([
      {
        mediaId: c,
        ownerKind: 'version',
        ownerId: `${jobId}#1`,
        jobId,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [b, c]))
    expect(await owned(s, 'draft', 'edt_1')).toEqual([b, c])
    const until = new Date(h.deps.clock.now().getTime() + TAKE_RETAIN_MS).toISOString()
    expect((await s.getMedia(a))?.retainUntil).toBe(until)
    expect((await s.getMedia(b))?.retainUntil).toBeNull()
    h.deps.clock.advance(60_000)
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, []))
    expect(await owned(s, 'draft', 'edt_1')).toEqual([])
    expect((await s.getMedia(b))?.retainUntil).toBe(
      new Date(h.deps.clock.now().getTime() + TAKE_RETAIN_MS).toISOString(),
    )
    expect((await s.getMedia(c))?.retainUntil).toBeNull()
    // Unchanged refs keep their first creation time.
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_2', jobId, [a]))
    const first = (await s.listMediaRefsByOwner('draft', 'edt_2'))[0]?.createdAt
    h.deps.clock.advance(60_000)
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_2', jobId, [a]))
    expect((await s.listMediaRefsByOwner('draft', 'edt_2'))[0]?.createdAt).toBe(first)
  })

  it('a frozen attempt holds its takes until they become its version', async () => {
    const { h, jobId, ids } = await setup(await make())
    const s = h.deps.store
    await s.tx((repo) => addAttemptRefs(repo, h.deps, 'att_1', jobId, ids))
    expect(await owned(s, 'frozen_attempt', 'att_1')).toEqual(ids)
    await s.tx((repo) => promoteAttemptRefs(repo, h.deps, 'att_1', `${jobId}#2`))
    expect(await owned(s, 'frozen_attempt', 'att_1')).toEqual([])
    expect(await owned(s, 'version', `${jobId}#2`)).toEqual(ids)
    expect((await s.listMediaRefsByMedia(ids)).every((r) => r.jobId === jobId)).toBe(true)
    expect(await s.tx((repo) => releaseOwnerRefs(repo, h.deps, 'version', `${jobId}#2`))).toEqual(ids)
    expect(await s.listMediaRefsByMedia(ids)).toEqual([])
  })

  it('writers refuse a take GC is deleting (409 take_deleted) and leave the references as they were', async () => {
    const { h, jobId, ids } = await setup(await make())
    const [a, b] = ids as [string, string]
    const s = h.deps.store
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [a]))
    expect(await tombstone(s, b, h.deps.clock.now().toISOString())).toBe(true)
    expect(await code(s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [a, b])))).toBe(
      '409 take_deleted',
    )
    expect(await code(s.tx((repo) => addAttemptRefs(repo, h.deps, 'att_1', jobId, [b])))).toBe(
      '409 take_deleted',
    )
    expect(await code(s.tx((repo) => addAttemptRefs(repo, h.deps, 'att_1', jobId, ['med_missing'])))).toBe(
      '409 take_deleted',
    )
    expect(await owned(s, 'draft', 'edt_1')).toEqual([a])
    expect(await s.listMediaRefsByMedia([b])).toEqual([])
    // Dropping a take that's being deleted is fine: only the ones kept must be live.
    await s.updateMedia(a, { deletingAt: h.deps.clock.now().toISOString() })
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, []))
    expect(await owned(s, 'draft', 'edt_1')).toEqual([])
    // And a referenced take can't be tombstoned.
    const [, , c] = ids as [string, string, string]
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_1', jobId, [c]))
    expect(await tombstone(s, c, h.deps.clock.now().toISOString())).toBe(false)
  })

  it('concurrent saves and GC tombstones: exactly one wins, and nothing references a deleting take', async () => {
    const { h, jobId, ids } = await setup(await make(), 6)
    const s = h.deps.store
    for (let round = 0; round < 6; round++) {
      const target = ids[round] as string
      await s.tx((repo) => replaceDraftRefs(repo, h.deps, `edt_${round}`, jobId, []))
      const at = h.deps.clock.now().toISOString()
      // Both orders, started together: the writer adding the take, and GC tombstoning it.
      const save = () => code(s.tx((repo) => replaceDraftRefs(repo, h.deps, `edt_${round}`, jobId, [target])))
      const gc = () => tombstone(s, target, at)
      const [saved, gcWon] =
        round % 2 ? await Promise.all([save(), gc()]) : (await Promise.all([gc(), save()])).reverse()
      const m = await s.getMedia(target)
      const refs = await s.listMediaRefsByMedia([target])
      if (gcWon) {
        expect(saved, `round ${round}`).toBe('409 take_deleted')
        expect(m?.deletingAt, `round ${round}`).toBe(at)
        expect(refs, `round ${round}`).toEqual([])
      } else {
        expect(saved, `round ${round}`).toBe('ok')
        expect(m?.deletingAt, `round ${round}`).toBeNull()
        expect(
          refs.map((r) => r.ownerId),
          `round ${round}`,
        ).toEqual([`edt_${round}`])
      }
      // Ready for the next round: the take referenced or not, never both.
      expect(Boolean(m?.deletingAt) && refs.length > 0).toBe(false)
    }
  })

  it('concurrent saves over overlapping takes both commit, in media-id lock order', async () => {
    const { h, jobId, ids } = await setup(await make(), 4)
    const s = h.deps.store
    const fwd = [...ids]
    const rev = [...ids].reverse()
    const out = await Promise.all([
      code(s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_a', jobId, fwd))),
      code(s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_b', jobId, rev))),
    ])
    expect(out).toEqual(['ok', 'ok'])
    expect(await owned(s, 'draft', 'edt_a')).toEqual(ids)
    expect(await owned(s, 'draft', 'edt_b')).toEqual(ids)
  })

  it('discarding a draft and its expiry release its takes; deleting the video releases its versions', async () => {
    const { h, jobId, ids } = await setup(await make())
    const [a, b, c] = ids as [string, string, string]
    const s = h.deps.store
    await s.insertEdit(draft(h, jobId, 'edt_live'))
    await s.insertEdit(draft(h, jobId, 'edt_old', h.deps.clock.now().toISOString()))
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_live', jobId, [a]))
    await s.tx((repo) => replaceDraftRefs(repo, h.deps, 'edt_old', jobId, [b]))
    await s.tx((repo) => addAttemptRefs(repo, h.deps, 'att_1', jobId, [c]))
    await s.tx((repo) => promoteAttemptRefs(repo, h.deps, 'att_1', `${jobId}#1`))

    await discardEdit(h.deps, mia, 'edt_live')
    expect(await s.getEdit('edt_live')).toBeNull()
    expect(await s.listMediaRefsByMedia([a])).toEqual([])
    const until = () => new Date(h.deps.clock.now().getTime() + TAKE_RETAIN_MS).toISOString()
    expect((await s.getMedia(a))?.retainUntil).toBe(until())

    h.deps.clock.advance(60_000)
    await deleteExpiredEdits(h.deps)
    expect(await s.getEdit('edt_old')).toBeNull()
    expect(await s.listMediaRefsByMedia([b])).toEqual([])
    expect((await s.getMedia(b))?.retainUntil).toBe(until())

    h.deps.clock.advance(60_000)
    expect((await h.call('DELETE', `/api/v1/videos/${jobId}`, { as: h.member })).status).toBe(202)
    expect(await s.listMediaRefsByMedia([c])).toEqual([])
    expect((await s.getMedia(c))?.retainUntil).toBe(until())
    // Releasing deletes nothing: the bytes wait for GC.
    for (const id of ids) expect((await s.getMedia(id))?.deletingAt).toBeNull()
  })
})
