// Admin → People: each person's video count (deleted videos don't count).
import { describe, expect, it } from 'vitest'
import { harness, pgStore, readyVideo, type Harness } from './helpers.js'

async function scenario(h: Harness) {
  const a = await readyVideo(h)
  await readyVideo(h)
  const counts = async () => {
    const users = await h.json<{ id: string; videoCount: number }[]>(
      await h.call('GET', '/api/v1/users', { as: h.admin }),
    )
    return Object.fromEntries(users.map((u) => [u.id, u.videoCount]))
  }
  expect(await counts()).toMatchObject({ u_member: 2, u_admin: 0 })
  expect((await h.call('DELETE', `/api/v1/videos/${a}`, { as: h.member })).status).toBe(202)
  expect(await counts()).toMatchObject({ u_member: 1, u_admin: 0 })
}

describe('admin users: video counts', () => {
  it('memory', async () => {
    await scenario(harness())
  })
  it('Postgres', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})
