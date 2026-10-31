// Ownership transfer (plan v2 §3, §14 rule 7).
import { describe, expect, it } from 'vitest'
import type { Role } from '../src/domain/types.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

async function person(h: Harness, id: string, role?: Role) {
  const cookie = h.deps.identity.addUser({ id, email: `${id}@acme.com`, name: id }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  if (role) await h.call('PATCH', `/api/v1/users/${id}`, { as: h.admin, body: { role } })
  return cookie
}

async function video(h: Harness, as: string) {
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

const transfer = (h: Harness, body: unknown, as = h.admin) =>
  h.call('POST', '/api/v1/transfers', { as, body })

describe('ownership transfer', () => {
  it('moves one video: new owner gets owner powers, authorship stays, the change is audited', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await video(h, h.member)
    const before = await h.deps.store.getJob(id)
    const res = await transfer(h, { toUserId: 'u_bob', videoIds: [id] })
    expect(res.status).toBe(200)
    expect(await h.json(res)).toEqual({ transferred: 1, videoIds: [id] })
    const after = await h.deps.store.getJob(id)
    expect(after?.ownerId).toBe('u_bob')
    expect(after?.version).toBe((before?.version ?? 0) + 1)
    expect(after?.accessEpoch).toBe((before?.accessEpoch ?? 0) + 1)
    const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: bob }))
    expect(v.owner.id).toBe('u_bob')
    expect(v.versions[0].authorId).toBe('u_member')
    const audit = await h.deps.store.listOwnershipTransfers(id)
    expect(audit).toEqual([
      expect.objectContaining({ fromUserId: 'u_member', toUserId: 'u_bob', byUserId: 'u_admin' }),
    ])
    // Owner powers moved.
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: bob })).status).toBe(200)
    expect(
      (await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { title: 'x' } })).status,
    ).toBe(403)
  })

  it("moves all of a person's videos, including private ones (and their old links stop working)", async () => {
    const h = harness()
    await person(h, 'u_bob')
    const a = await video(h, h.member)
    const b = await video(h, h.member)
    await h.call('PATCH', `/api/v1/videos/${b}`, { as: h.member, body: { private: true } })
    const res = await h.json(await transfer(h, { toUserId: 'u_bob', fromUserId: 'u_member' }))
    expect(res.transferred).toBe(2)
    expect((await h.deps.store.getJob(a))?.ownerId).toBe('u_bob')
    const mirror = await h.deps.blobs.get('internal', `access/${b}.json`)
    expect(JSON.parse(new TextDecoder().decode(mirror ?? new Uint8Array()))).toEqual({
      private: true,
      epoch: 2,
    })
    // The previous owner no longer sees the private video.
    expect((await h.call('GET', `/api/v1/videos/${b}`, { as: h.member })).status).toBe(404)
  })

  it('only to an active Creator or Admin; only admins can transfer', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    await person(h, 'u_rita', 'reviewer')
    await person(h, 'u_gone')
    await h.call('PATCH', '/api/v1/users/u_gone', { as: h.admin, body: { disabled: true } })
    const id = await video(h, h.member)
    expect((await transfer(h, { toUserId: 'u_rita', videoIds: [id] })).status).toBe(400)
    expect((await transfer(h, { toUserId: 'u_gone', videoIds: [id] })).status).toBe(400)
    expect((await transfer(h, { toUserId: 'u_bob', videoIds: [id] }, h.member)).status).toBe(403)
    expect((await transfer(h, { toUserId: 'u_bob', videoIds: [id] }, bob)).status).toBe(403)
  })

  it('works whether the person is disabled before or after the transfer', async () => {
    const h = harness()
    await person(h, 'u_bob')
    const leaver = await person(h, 'u_leaver')
    const first = await video(h, leaver)
    await h.call('PATCH', '/api/v1/users/u_leaver', { as: h.admin, body: { disabled: true } })
    expect((await h.json(await transfer(h, { toUserId: 'u_bob', fromUserId: 'u_leaver' }))).transferred).toBe(
      1,
    )
    expect((await h.deps.store.getJob(first))?.ownerId).toBe('u_bob')

    const leaver2 = await person(h, 'u_leaver2')
    const second = await video(h, leaver2)
    await transfer(h, { toUserId: 'u_bob', fromUserId: 'u_leaver2' })
    await h.call('PATCH', '/api/v1/users/u_leaver2', { as: h.admin, body: { disabled: true } })
    expect((await h.deps.store.getJob(second))?.ownerId).toBe('u_bob')
  })
})
