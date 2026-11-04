// Favorites: each person stars videos in their own library, and the list filters to them.
import { describe, expect, it } from 'vitest'
import { harness, person, pgStore, readyVideo, type Harness } from './helpers.js'

const star = (h: Harness, as: string, id: string, on = true) =>
  h.call(on ? 'PUT' : 'DELETE', `/api/v1/videos/${id}/favorite`, { as })
const list = async (h: Harness, as: string, qs = '') =>
  (await h.json(await h.call('GET', `/api/v1/videos${qs}`, { as }))).items as {
    id: string
    favorite: boolean
  }[]

async function scenario(h: Harness) {
  const bob = await person(h, 'u_bob', 'viewer')
  const a = await readyVideo(h, h.member)
  const b = await readyVideo(h, h.member)

  // Anyone who can see a video can star it, viewers too; starring twice is fine.
  expect((await star(h, bob, a)).status).toBe(204)
  expect((await star(h, bob, a)).status).toBe(204)

  // Favorites are per person: bob sees his star, the owner doesn't.
  const asBob = await list(h, bob)
  expect(asBob.find((v) => v.id === a)?.favorite).toBe(true)
  expect(asBob.find((v) => v.id === b)?.favorite).toBe(false)
  expect((await list(h, h.member)).every((v) => !v.favorite)).toBe(true)
  expect((await list(h, bob, '?favorite=true')).map((v) => v.id)).toEqual([a])
  expect(await list(h, h.member, '?favorite=true')).toEqual([])
  // favorite=false is no filter.
  expect(await list(h, bob, '?favorite=false')).toHaveLength(2)

  // The single video shows it too, and its validator changes so a cached copy isn't served.
  const before = await h.call('GET', `/api/v1/videos/${b}`, { as: bob })
  expect((await h.json(before)).favorite).toBe(false)
  await star(h, bob, b)
  const after = await h.call('GET', `/api/v1/videos/${b}`, {
    as: bob,
    headers: { 'if-none-match': before.headers.get('etag') ?? '' },
  })
  expect(after.status).toBe(200)
  expect((await h.json(after)).favorite).toBe(true)

  // Unstarring removes it from the filter; unstarring again is fine.
  expect((await star(h, bob, a, false)).status).toBe(204)
  expect((await star(h, bob, a, false)).status).toBe(204)
  expect((await list(h, bob, '?favorite=true')).map((v) => v.id)).toEqual([b])

  // A private video can't be starred by someone who can't see it, and drops out of their favorites.
  await h.call('PATCH', `/api/v1/videos/${b}`, { as: h.member, body: { private: true } })
  expect((await star(h, bob, b)).status).toBe(404)
  expect(await list(h, bob, '?favorite=true')).toEqual([])
  expect((await star(h, bob, 'vid_missing')).status).toBe(404)
}

describe('favorites', () => {
  it('star, list and filter (memory store)', async () => {
    await scenario(harness())
  })

  it('star, list and filter (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})
