// The same lifecycle against real Postgres semantics (PGlite + the committed migrations).
import { describe, expect, it } from 'vitest'
import type { VersionRow } from '../src/domain/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT } from './helpers.js'

const bareVersion = (jobId: string, extra: Partial<VersionRow> = {}): VersionRow => ({
  jobId,
  n: 1,
  prompt: PROMPT,
  authorId: 'u_member',
  apiKeyId: null,
  targetDurationSec: null,
  parentN: null,
  webhookUrl: null,
  status: 'queued',
  createdAt: '2026-11-05T00:00:00.000Z',
  ...extra,
})

// versions.engine (render-engines plan §4.2): rows that don't say read as hyperframes; remotion round-trips.
async function engineRoundTrip(store: Store) {
  await store.tx(async (repo) => {
    await repo.insertVersion(bareVersion('j_default'))
    await repo.insertVersion(bareVersion('j_remotion', { engine: 'remotion' }))
  })
  return store.tx(async (repo) => [
    (await repo.getVersion('j_default', 1))?.engine,
    (await repo.getVersion('j_remotion', 1))?.engine,
  ])
}

describe('postgres store', () => {
  it('runs create → ready → revise → publish → list → delete', async () => {
    const h = harness({}, { store: await pgStore() })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, aspect: '4:5' } }),
    )
    await h.drive(4)
    expect((await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))).status).toBe(
      'ready',
    )
    expect(
      (
        await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
          as: h.member,
          body: { prompt: 'Warmer colors.' },
        })
      ).status,
    ).toBe(202)
    await h.drive(4)
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${video.id}/versions/2/publish`, { as: h.member }),
    )
    expect(pub.slug).toBeTruthy()
    const list = await h.json(await h.call('GET', '/api/v1/videos?published=true&q=launch', { as: h.member }))
    expect(list.items.map((v: { id: string }) => v.id)).toEqual([video.id])
    const stats = await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))
    expect(stats.usage[0].credits).toBe(84)
    expect((await h.call('DELETE', `/api/v1/videos/${video.id}`, { as: h.member })).status).toBe(202)
    expect((await h.json(await h.call('GET', '/api/v1/videos', { as: h.member }))).items).toHaveLength(0)
  })

  it('keeps the concurrency cap under overlapping sweeps', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '2' }, { store: await pgStore() })
    for (let i = 0; i < 6; i++)
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: `${PROMPT} ${i}` } })
    let max = 0
    for (let i = 0; i < 20; i++) {
      await Promise.all([h.drive(1), h.drive(1)])
      max = Math.max(max, await h.deps.store.countSlotHolders())
    }
    expect(max).toBeLessThanOrEqual(2)
    expect(h.deps.runner.starts).toHaveLength(6)
  })

  it('versions.engine defaults to hyperframes and round-trips remotion', async () => {
    expect(await engineRoundTrip(await pgStore())).toEqual(['hyperframes', 'remotion'])
  })

  it('the memory store fills the same default', async () => {
    expect(await engineRoundTrip(createMemoryStore())).toEqual(['hyperframes', 'remotion'])
  })

  it('a video made through the API records hyperframes', async () => {
    const h = harness({}, { store: await pgStore() })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    expect((await h.deps.store.tx((repo) => repo.getVersion(video.id, 1)))?.engine).toBe('hyperframes')
  })
})
