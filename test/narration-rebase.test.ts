// Stale base (plan 2026-11-02 §2.7): a draft's DTO says when a newer ready version changed the narration (a stable
// hash of the resolved op, base vs newest), and Rebase moves the draft's narration op onto the caller's draft of that
// version through the save path, so it's revalidated there (lock, take access, limits).
import { describe, expect, it } from 'vitest'
import { narrationHash } from '../src/domain/narration-stale.js'
import type { VersionNarration, VersionRow } from '../src/domain/types.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import { contractSource, editableVideo, harness, narrationTake, person, stubNetlify } from './helpers.js'
import { BUS, narrationAt as narration } from './narration-render.js'

const S = SAMPLE_RATE

describe('narrationHash', () => {
  type Narrated = Pick<VersionRow, 'narration' | 'frozen'>
  const v = (op: unknown): Narrated => ({
    narration: op ? ({ op } as VersionNarration) : null,
    frozen: null,
  })
  it('is stable across key order, and tells ops (and none) apart', () => {
    const op = narration('med_a')
    const flipped = Object.fromEntries(Object.entries(op).reverse())
    expect(narrationHash(v(flipped))).toBe(narrationHash(v(op)))
    expect(narrationHash(v(narration('med_a', 2 * S)))).not.toBe(narrationHash(v(op)))
    expect(narrationHash(v(null))).toBe(narrationHash(null))
    expect(narrationHash(v(null))).not.toBe(narrationHash(v(op)))
    // The render's frozen op counts until finalize records the version's.
    expect(narrationHash({ narration: null, frozen: { narration: { op } } } as unknown as Narrated)).toBe(
      narrationHash(v(op)),
    )
  })
})

describe('stale base and rebase', () => {
  stubNetlify()

  // Each run's saved source: an editable contract-1 composition.
  async function setup() {
    const h = harness()
    const id = await editableVideo(h)
    const dana = await person(h, 'u_dana', 'creator')
    const take = (as: string) => narrationTake(h, id, as)
    const draft = async (as: string, n = 1) =>
      h.json<{ id: string; rev: number }>(
        await h.call('POST', `/api/v1/videos/${id}/versions/${n}/edits`, { as }),
      )
    const lock = (as: string, draftId: string) =>
      h.call('POST', `/api/v1/videos/${id}/narration-lock/take-over`, { as, body: { draftId } })
    const save = (as: string, editId: string, rev: number, ops: object[]) =>
      h.call('PUT', `/api/v1/edits/${editId}`, { as, body: { rev, ops } })
    /** Dana renders `ops` from v1 as v2 and it finishes. */
    async function danaRenders(ops: object[]) {
      const e = await draft(dana)
      await lock(dana, e.id)
      expect((await save(dana, e.id, 0, ops)).status).toBe(200)
      h.deps.nextSource = contractSource()
      // A narrated render uploads its bus with the outputs; finalize fails a version without one.
      h.deps.nextBus = BUS
      expect((await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: dana })).status).toBe(202)
      await h.drive(6)
      expect((await h.deps.store.getVersion(id, 2))?.status).toBe('ready')
      return e.id
    }
    const rebase = (as: string, editId: string, toN: number) =>
      h.call('POST', `/api/v1/edits/${editId}/rebase-narration`, { as, body: { toN } })
    return { h, id, dana, take, draft, lock, save, danaRenders, rebase }
  }
  const errorOf = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; message: string } }
    return { status: res.status, ...body.error }
  }

  it('says when a newer version changed the narration, and rebases onto it', async () => {
    const { h, id, dana, take, draft, lock, save, danaRenders, rebase } = await setup()
    const mine = await take(h.member)
    const a = await draft(h.member)
    await lock(h.member, a.id)
    expect(
      (await save(h.member, a.id, 0, [{ op: 'retime', beat: 'intro', duration: 4 }, narration(mine)])).status,
    ).toBe(200)
    expect(
      (await h.json(await h.call('GET', `/api/v1/edits/${a.id}`, { as: h.member }))).narrationChanged,
    ).toBeNull()
    const danas = await danaRenders([narration(await take(dana), 2 * S)])
    const stale = await h.json(await h.call('GET', `/api/v1/edits/${a.id}`, { as: h.member }))
    expect(stale.narrationChanged).toEqual({
      inVersion: 2,
      by: { userId: 'u_dana', name: 'u_dana' },
      at: (await h.deps.store.getVersion(id, 2))!.createdAt,
      yoursReplaces: true,
    })
    // While Dana holds the lock, the rebase's save is refused and says why.
    await lock(dana, danas)
    const refused = await errorOf(await rebase(h.member, a.id, 2))
    expect(refused).toMatchObject({ status: 409, code: 'narration_locked' })
    expect(refused.message).toMatch(/^Your narration can't move to v2: u_dana took over the narration/)
    await lock(h.member, a.id)
    const res = await rebase(h.member, a.id, 2)
    expect(res.status).toBe(201)
    const moved = await h.json(res)
    // Only the narration moves: the retime was v1's.
    expect(moved).toMatchObject({ baseN: 2, rev: 1, ops: [narration(mine)], narrationChanged: null })
    expect((await h.deps.store.listMediaRefsByOwner('draft', moved.id)).map((r) => r.mediaId)).toEqual([mine])
    // The v1 draft is kept; rebasing again updates the v2 draft.
    expect((await h.call('GET', `/api/v1/edits/${a.id}`, { as: h.member })).status).toBe(200)
    expect((await rebase(h.member, a.id, 2)).status).toBe(200)
    expect(h.deps.logs.some((l) => l.includes('edit.rebase_narration'))).toBe(true)
  }, 60_000)

  it("revalidates on the new base: a take that's no longer usable is refused, leaving no new draft", async () => {
    const { h, id, take, draft, lock, save, danaRenders, rebase } = await setup()
    const cora = await person(h, 'u_cora', 'creator')
    const coras = await take(cora)
    // v1's narration plays Cora's take, so my v1 draft inherits it, even after she deletes it.
    await h.deps.store.insertMediaRefs([
      {
        mediaId: coras,
        ownerKind: 'version',
        ownerId: `${id}#1`,
        jobId: id,
        createdAt: '2026-11-01T00:00:00Z',
      },
    ])
    await h.call('DELETE', `/api/v1/media/${coras}`, { as: cora })
    const a = await draft(h.member)
    await lock(h.member, a.id)
    expect((await save(h.member, a.id, 0, [narration(coras)])).status).toBe(200)
    await danaRenders([{ op: 'retime', beat: 'intro', duration: 4 }])
    await lock(h.member, a.id)
    // v2 doesn't hold it: on v2 it's a deleted take of someone else's.
    const refused = await errorOf(await rebase(h.member, a.id, 2))
    expect(refused).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(refused.message).toBe(
      `Your narration can't move to v2: That edit can't be made: recording ${coras} isn't available.`,
    )
    expect(await h.deps.store.findEdit('u_member', id, 2, h.deps.clock.now().toISOString())).toBeNull()
    // Nothing to rebase, or onto its own base.
    const b = await draft(h.member, 2)
    expect((await errorOf(await rebase(h.member, b.id, 1))).message).toBe(
      'This draft has no narration to rebase.',
    )
    expect((await rebase(h.member, a.id, 1)).status).toBe(400)
  }, 60_000)
})
