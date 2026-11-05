// The same lifecycle against real Postgres semantics (PGlite + the committed migrations).
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import type { JobRow, VersionContext, VersionRow } from '../src/domain/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { JobQuery, Store } from '../src/store/types.js'
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

// jobs.external_ref/external_url and versions.context (github-action plan §6.1, §6.2): null until set, round-trip on
// both stores, and an exact externalRef filter on the list.
const bareJob = (id: string, extra: Partial<JobRow> = {}): JobRow => ({
  id,
  title: id,
  aspect: '16:9',
  ownerId: 'u_member',
  status: 'queued',
  latestVersion: 1,
  nextVersionN: 2,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  private: false,
  accessEpoch: 0,
  language: 'en',
  ...extra,
})

const context: VersionContext = {
  source: 'github_pr',
  label: 'GitHub PR #123',
  url: 'https://github.com/acme/web/pull/123',
  text: 'Adds a retry button.',
}

async function externalRoundTrip(store: Store) {
  await store.tx(async (repo) => {
    await repo.insertJob(bareJob('j_plain'))
    await repo.insertJob(
      bareJob('j_pr123', {
        externalRef: 'github:acme/web#pr-123',
        externalUrl: 'https://github.com/acme/web/pull/123',
        createdAt: '2026-11-05T00:00:01.000Z',
      }),
    )
    await repo.insertJob(bareJob('j_pr12', { externalRef: 'github:acme/web#pr-12' }))
    await repo.insertJob(bareJob('j_other', { ownerId: 'u_other', externalRef: 'github:acme/web#pr-123' }))
    await repo.insertVersion(bareVersion('j_plain'))
    await repo.insertVersion(bareVersion('j_pr123', { context }))
  })
  return store.tx(async (repo) => {
    const plain = await repo.getJob('j_plain')
    const pr = await repo.getJob('j_pr123')
    const ids = async (q: Partial<JobQuery>) => (await repo.listJobs({ limit: 10, ...q })).map((j) => j.id)
    return {
      plain: [
        plain?.externalRef ?? null,
        plain?.externalUrl ?? null,
        (await repo.getVersion('j_plain', 1))?.context ?? null,
      ],
      pr: [pr?.externalRef, pr?.externalUrl, (await repo.getVersion('j_pr123', 1))?.context],
      mine: await ids({ ownerId: 'u_member', externalRef: 'github:acme/web#pr-123' }),
      anyone: await ids({ externalRef: 'github:acme/web#pr-123' }),
      none: await ids({ externalRef: 'github:acme/web#pr-1' }),
    }
  })
}

describe('external refs and version context', () => {
  const expected = {
    plain: [null, null, null],
    pr: ['github:acme/web#pr-123', 'https://github.com/acme/web/pull/123', context],
    mine: ['j_pr123'],
    anyone: expect.arrayContaining(['j_pr123', 'j_other']),
    none: [],
  }

  it('round-trip on postgres, null for rows that never set them', async () => {
    expect(await externalRoundTrip(await pgStore())).toEqual(expected)
  })

  it('round-trip on the memory store', async () => {
    expect(await externalRoundTrip(createMemoryStore())).toEqual(expected)
  })

  it('the owner + externalRef lookup can use jobs_owner_external_ref_idx', async () => {
    const pg = new PGlite()
    const dir = new URL('../netlify/database/migrations/', import.meta.url)
    for (const m of readdirSync(dir).sort()) {
      const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
      for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
    }
    // A small table is cheapest to scan, so take the planner's choice away to see whether the index applies.
    await pg.exec('set enable_seqscan = off')
    const plan = await pg.query<{ 'QUERY PLAN': string }>(
      "explain select id from jobs where owner_id = 'u_member' and external_ref = 'github:acme/web#pr-123'",
    )
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('jobs_owner_external_ref_idx')
  })
})
