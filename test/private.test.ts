// Private videos (plan v2 §3, §14 rules 3 and 6): visible only to the owner and admins, 404 for everyone else.
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema.js'
import { createDrizzleStore } from '../src/store/drizzle.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

async function pgStore() {
  const pg = new PGlite()
  const dir = new URL('../netlify/database/migrations/', import.meta.url)
  for (const m of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  return createDrizzleStore(drizzle({ client: pg, schema }))
}

async function setup(h: Harness) {
  const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
  await h.call('GET', '/api/v1/me', { as: bob })
  const video = await h.json(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  await h.drive(4)
  return { bob, id: video.id as string }
}

const makePrivate = async (h: Harness, id: string, value = true) =>
  h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: value } })

describe('private videos', () => {
  it('the owner and admins see a private video; other people get 404 on every path', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    const before = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    const toggled = await makePrivate(h, id)
    expect(toggled.status).toBe(200)
    const after = await h.json(toggled)
    expect(after.private).toBe(true)
    expect(after.etag).not.toBe(before.etag)

    expect((await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })).status).toBe(200)
    expect((await h.call('GET', `/api/v1/videos/${id}`, { as: h.admin })).status).toBe(200)

    const paths: [string, string, unknown?][] = [
      ['GET', `/api/v1/videos/${id}`],
      ['GET', `/api/v1/videos/${id}/versions/1/video`],
      ['POST', `/api/v1/videos/${id}/versions`, { prompt: 'Make it blue' }],
      ['POST', `/api/v1/videos/${id}/versions/1/retry`],
      ['POST', `/api/v1/videos/${id}/versions/1/cancel`],
      ['PATCH', `/api/v1/videos/${id}`, { title: 'Mine now' }],
      ['POST', `/api/v1/videos/${id}/versions/1/publish`],
      ['DELETE', `/api/v1/videos/${id}`],
    ]
    for (const [method, path, body] of paths) {
      const res = await h.call(method, path, { as: bob, ...(body ? { body } : {}) })
      expect([method, path, res.status]).toEqual([method, path, 404])
    }

    const list = await h.json(await h.call('GET', '/api/v1/videos', { as: bob }))
    expect(list.items.map((v: { id: string }) => v.id)).not.toContain(id)
    const search = await h.json(await h.call('GET', `/api/v1/videos?q=webhooks`, { as: bob }))
    expect(search.items).toHaveLength(0)
    const adminList = await h.json(await h.call('GET', '/api/v1/videos', { as: h.admin }))
    expect(adminList.items.map((v: { id: string }) => v.id)).toContain(id)

    await makePrivate(h, id, false)
    expect((await h.call('GET', `/api/v1/videos/${id}`, { as: bob })).status).toBe(200)
  })

  it('only the owner or an admin toggles privacy', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    expect((await h.call('PATCH', `/api/v1/videos/${id}`, { as: bob, body: { private: true } })).status).toBe(
      403,
    )
    expect(
      (await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.admin, body: { private: true } })).status,
    ).toBe(200)
  })

  it('an idempotent replay does not leak a video that has since gone private', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    const headers = { 'idempotency-key': 'k-1' }
    const first = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: bob,
      headers,
      body: { prompt: 'Make the end card orange' },
    })
    expect(first.status).toBe(202)
    await makePrivate(h, id)
    const replay = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: bob,
      headers,
      body: { prompt: 'Make the end card orange' },
    })
    expect(replay.status).toBe(404)
  })

  it('MCP hides private videos from other people', async () => {
    const h = harness()
    const { bob, id } = await setup(h)
    await makePrivate(h, id)
    const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: bob, body: { name: 'mcp' } }))).key
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await h.call('POST', '/api/mcp', {
        origin: null,
        headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      })
      return ((await res.json()) as { result: { isError?: boolean; structuredContent?: any } }).result
    }
    expect((await call('get_video', { video_id: id })).isError).toBe(true)
    const list = await call('list_videos', { scope: 'everyone' })
    expect(JSON.stringify(list.structuredContent ?? {})).not.toContain(id)
  })

  it('lists paginate without gaps when private videos are mixed in', async () => {
    const h = harness()
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const v = await h.json(
        await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: `${PROMPT} ${i}` } }),
      )
      ids.push(v.id)
      h.deps.clock.advance(1000)
    }
    await makePrivate(h, ids[1] as string)
    await makePrivate(h, ids[3] as string)
    const seen: string[] = []
    let cursor = ''
    for (let i = 0; i < 5; i++) {
      const page = await h.json(await h.call('GET', `/api/v1/videos?limit=1&cursor=${cursor}`, { as: bob }))
      seen.push(...page.items.map((v: { id: string }) => v.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen.sort()).toEqual([ids[0], ids[2], ids[4]].sort())
  })

  it('filters private videos in SQL on Postgres', async () => {
    const h = harness({}, { store: await pgStore() })
    const { bob, id } = await setup(h)
    await makePrivate(h, id)
    expect((await h.json(await h.call('GET', '/api/v1/videos', { as: bob }))).items).toHaveLength(0)
    expect((await h.json(await h.call('GET', '/api/v1/videos', { as: h.member }))).items).toHaveLength(1)
    expect((await h.call('GET', `/api/v1/videos/${id}`, { as: bob })).status).toBe(404)
  })

  it('private file links carry the access epoch, expire within 10 minutes, and are mirrored for the edge', async () => {
    const h = harness()
    const { id } = await setup(h)
    const pub = await h.call('GET', `/api/v1/videos/${id}/versions/1/video`, { as: h.member })
    expect(pub.headers.get('location')).not.toContain('&e=')
    await makePrivate(h, id)
    const priv = await h.call('GET', `/api/v1/videos/${id}/versions/1/video`, { as: h.member })
    const loc = new URL(priv.headers.get('location') ?? '', 'https://x')
    expect(loc.searchParams.get('e')).toBe('1')
    const ttl = Number(loc.searchParams.get('exp')) - Math.floor(h.deps.clock.now().getTime() / 1000)
    expect(ttl).toBeLessThanOrEqual(600)
    const mirror = await h.deps.blobs.get('internal', `access/${id}.json`)
    expect(JSON.parse(new TextDecoder().decode(mirror ?? new Uint8Array()))).toEqual({
      private: true,
      epoch: 1,
    })
    await makePrivate(h, id, false)
    const mirror2 = await h.deps.blobs.get('internal', `access/${id}.json`)
    expect(JSON.parse(new TextDecoder().decode(mirror2 ?? new Uint8Array()))).toEqual({
      private: false,
      epoch: 2,
    })
    await h.call('DELETE', `/api/v1/videos/${id}`, { as: h.member })
    expect(await h.deps.blobs.get('internal', `access/${id}.json`)).toBeNull()
  })
})
