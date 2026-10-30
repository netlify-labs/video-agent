// The same lifecycle against real Postgres semantics (PGlite + the committed migrations).
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema.js'
import { createDrizzleStore } from '../src/store/drizzle.js'
import { harness } from './helpers.js'

async function pgStore() {
  const pg = new PGlite()
  const dir = new URL('../netlify/database/migrations/', import.meta.url)
  for (const m of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  return createDrizzleStore(drizzle({ client: pg, schema }))
}

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

describe('postgres store', () => {
  it('runs create → ready → revise → publish → list → delete', async () => {
    const h = harness({}, { store: await pgStore() })
    const video = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, aspect: '4:5' } }))
    await h.drive(4)
    expect((await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))).status).toBe('ready')
    expect((await h.call('POST', `/api/v1/videos/${video.id}/versions`, { as: h.member, body: { prompt: 'Warmer colors.' } })).status).toBe(202)
    await h.drive(4)
    const pub = await h.json(await h.call('POST', `/api/v1/videos/${video.id}/versions/2/publish`, { as: h.member }))
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
    for (let i = 0; i < 6; i++) await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: `${PROMPT} ${i}` } })
    let max = 0
    for (let i = 0; i < 20; i++) {
      await Promise.all([h.drive(1), h.drive(1)])
      max = Math.max(max, await h.deps.store.countSlotHolders())
    }
    expect(max).toBeLessThanOrEqual(2)
    expect(h.deps.runner.starts).toHaveLength(6)
  })
})
