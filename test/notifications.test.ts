// In-app notifications (plan v2 §3, §14 rule 13).
import { describe, expect, it } from 'vitest'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

async function setup(h: Harness) {
  const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
  await h.call('GET', '/api/v1/me', { as: bob })
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return { bob, id: v.id as string }
}

const feed = async (h: Harness, as: string, q = '') =>
  h.json(await h.call('GET', `/api/v1/notifications${q}`, { as }))

describe('notifications', () => {
  it('tells the owner about a verdict on their (already ready) video; marking read clears the badge', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    expect((await feed(h, h.member)).unreadCount).toBe(0)
    await h.call('PUT', `/api/v1/videos/${id}/versions/1/verdict`, {
      as: bob,
      body: { verdict: 'changes_requested', note: 'Shorter end card' },
    })
    const f = await feed(h, h.member)
    expect(f.unreadCount).toBe(1)
    expect(f.items[0]).toEqual(
      expect.objectContaining({
        type: 'version.changes_requested',
        video: { id, title: expect.any(String) },
        versionN: 1,
        summary: 'Bob requested changes on v1: Shorter end card',
        unread: true,
      }),
    )
    // The person who acted isn't notified.
    expect((await feed(h, bob)).items).toHaveLength(0)
    expect((await h.call('POST', '/api/v1/notifications/read', { as: h.member, body: {} })).status).toBe(204)
    const after = await feed(h, h.member)
    expect(after.unreadCount).toBe(0)
    expect(after.items[0].unread).toBe(false)
  })

  it('drops items for videos the reader can no longer see', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    await h.call('PUT', `/api/v1/videos/${id}/versions/1/verdict`, { as: bob, body: { verdict: 'approved' } })
    expect((await feed(h, h.member)).items).toHaveLength(1)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    await h.call('POST', '/api/v1/transfers', { as: h.admin, body: { toUserId: 'u_bob', videoIds: [id] } })
    const f = await feed(h, h.member)
    expect(f.items).toHaveLength(0)
    expect(f.unreadCount).toBe(0)
  })

  it('paginates newest first, on Postgres too', async () => {
    const h = harness({}, { store: await pgStore() })
    const { id } = await setup(h)
    for (let i = 0; i < 3; i++) {
      const c = h.deps.identity.addUser({ id: `u_r${i}`, email: `r${i}@acme.com`, name: `R${i}` }).cookie
      await h.call('GET', '/api/v1/me', { as: c })
      await h.call('PUT', `/api/v1/videos/${id}/versions/1/verdict`, { as: c, body: { verdict: 'approved' } })
      h.deps.clock.advance(1000)
    }
    const p1 = await feed(h, h.member, '?limit=2')
    expect(p1.items.map((n: { actor: { name: string } }) => n.actor.name)).toEqual(['R2', 'R1'])
    const p2 = await feed(h, h.member, `?limit=2&cursor=${p1.nextCursor}`)
    expect(p2.items.map((n: { actor: { name: string } }) => n.actor.name)).toEqual(['R0'])
    expect(p2.nextCursor).toBeNull()
    expect(p1.unreadCount).toBe(3)
  })
})
