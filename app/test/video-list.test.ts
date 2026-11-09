// The library list loads a page of videos in one batch (store.videoPage) instead of a dozen queries per video. Each
// item must be exactly what GET /api/v1/videos/{id} returns, in both stores.
import { describe, expect, it, vi } from 'vitest'
import { harness, pgStore, PROMPT, readyVideo, type Harness } from './helpers.js'
import { running } from './fakes.js'

/** Videos in different states: ready, published with a comment, revised, still running, and someone else's private one. */
async function library(h: Harness) {
  const published = await readyVideo(h)
  await h.call('POST', `/api/v1/videos/${published}/versions/1/publish`, { as: h.member })
  await h.call('POST', `/api/v1/videos/${published}/comments`, {
    as: h.member,
    body: { versionN: 1, body: 'Nice pacing', timeSec: 1, x: 0.5, y: 0.5 },
  })
  const revised = await readyVideo(h)
  await h.call('POST', `/api/v1/videos/${revised}/versions`, {
    as: h.member,
    body: { prompt: 'Warmer colours' },
  })
  await h.drive(4)
  const hidden = await readyVideo(h, h.admin)
  await h.call('PATCH', `/api/v1/videos/${hidden}`, { as: h.admin, body: { private: true } })
  h.deps.runner.nextScripts.push({ timeline: [running()] })
  await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
  await h.drive(2)
}

for (const [name, makeStore] of [
  ['memory', () => undefined],
  ['Postgres', pgStore],
] as const) {
  describe(`video list (${name})`, () => {
    it('returns each video exactly as GET /videos/{id} does, without per-video queries', async () => {
      const store = await makeStore()
      const h = harness({}, store ? { store } : {})
      await library(h)
      const perVideo = vi.spyOn(h.deps.store, 'listVersions')
      for (const as of [h.member, h.admin]) {
        perVideo.mockClear()
        const list = await h.json(await h.call('GET', '/api/v1/videos?limit=50', { as }))
        // One batch for the page, not a query per video.
        expect(perVideo).not.toHaveBeenCalled()
        expect(list.items.length).toBeGreaterThanOrEqual(3)
        for (const item of list.items) {
          const one = await h.json(await h.call('GET', `/api/v1/videos/${item.id}`, { as }))
          expect(item).toEqual(one)
        }
      }
      // The member doesn't see the admin's private video; the admin does.
      const mine = await h.json<{ items: unknown[] }>(
        await h.call('GET', '/api/v1/videos?limit=50', { as: h.member }),
      )
      const all = await h.json<{ items: unknown[] }>(
        await h.call('GET', '/api/v1/videos?limit=50', { as: h.admin }),
      )
      expect(all.items.length).toBe(mine.items.length + 1)
    })
  })
}
