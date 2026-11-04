// Notes posted together (a review pass through the video): one comment per note, each with its own moment and
// optional spot, sharing a groupId; one notification for the block; lone comments keep groupId null.
import { describe, expect, it } from 'vitest'
import { harness, person, pgStore, readyVideo, type Harness } from './helpers.js'

const batch = (h: Harness, as: string, id: string, body: unknown) =>
  h.call('POST', `/api/v1/videos/${id}/comments/batch`, { as, body })

async function scenario(h: Harness) {
  const rita = await person(h, 'u_rita', 'reviewer')
  const vic = await person(h, 'u_vic', 'viewer')
  const id = await readyVideo(h, h.member)
  const res = await batch(h, rita, id, {
    versionN: 1,
    notes: [
      { body: 'Logo too small', timeSec: 0.5 },
      { body: 'Here: the button', timeSec: 1.5, x: 0.4, y: 0.6 },
      { body: 'And the colours overall' },
    ],
  })
  expect(res.status).toBe(201)
  const { items } = await h.json(res)
  expect(items).toHaveLength(3)
  const group = items[0].groupId
  expect(group).toEqual(expect.any(String))
  expect(items.every((c: { groupId: string }) => c.groupId === group)).toBe(true)
  expect(items.map((c: { timeSec: number | null }) => c.timeSec)).toEqual([0.5, 1.5, null])
  expect(items[1]).toMatchObject({ x: 0.4, y: 0.6 })

  // Listed in the order posted; a lone comment has no group.
  h.deps.clock.advance(1000)
  await h.call('POST', `/api/v1/videos/${id}/comments`, { as: rita, body: { versionN: 1, body: 'Lone one' } })
  const list = await h.json(await h.call('GET', `/api/v1/videos/${id}/comments`, { as: h.member }))
  expect(list.items.map((c: { body: string }) => c.body)).toEqual([
    'Logo too small',
    'Here: the button',
    'And the colours overall',
    'Lone one',
  ])
  expect(list.items[3].groupId).toBeNull()

  // One notification for the block (plus one for the lone comment).
  const notes = await h.json(await h.call('GET', '/api/v1/notifications', { as: h.member }))
  const summaries = notes.items.map((n: { summary: string }) => n.summary)
  expect(summaries.some((s: string) => s.includes('left 3 notes on v1 at 0.5s: Logo too small'))).toBe(true)
  expect(summaries).toHaveLength(2)

  // Same rules as one comment: viewers can't, pins are validated, at most 20 notes, none empty.
  expect((await batch(h, vic, id, { versionN: 1, notes: [{ body: 'x' }] })).status).toBe(403)
  expect((await batch(h, rita, id, { versionN: 1, notes: [{ body: 'x', x: 0.5, y: 0.5 }] })).status).toBe(400)
  expect((await batch(h, rita, id, { versionN: 1, notes: [] })).status).toBe(400)
  const many = Array.from({ length: 21 }, (_, i) => ({ body: `n${i}` }))
  expect((await batch(h, rita, id, { versionN: 1, notes: many })).status).toBe(400)
  expect((await batch(h, rita, id, { versionN: 1, notes: [{ body: '   ' }] })).status).toBe(400)
}

describe('comment groups', () => {
  it('posts a block of notes (memory)', async () => {
    await scenario(harness())
  })
  it('posts a block of notes (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})
