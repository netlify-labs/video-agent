// Comments (plan v2 §5, §14 rules 3, 13): who reads and writes, pins, resolve, unread, events and MCP.
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema.js'
import { getSettings } from '../src/domain/settings.js'
import type { Role } from '../src/domain/types.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { encrypt } from '../src/lib/crypto.js'
import { createDrizzleStore } from '../src/store/drizzle.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

async function person(h: Harness, id: string, role?: Role) {
  const cookie = h.deps.identity.addUser({ id, email: `${id}@acme.com`, name: id }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  if (role) await h.call('PATCH', `/api/v1/users/${id}`, { as: h.admin, body: { role } })
  return cookie
}

async function readyVideo(h: Harness, as: string) {
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

const post = (h: Harness, as: string, id: string, body: unknown) =>
  h.call('POST', `/api/v1/videos/${id}/comments`, { as, body })
const list = async (h: Harness, as: string, id: string, qs = '') =>
  h.json(await h.call('GET', `/api/v1/videos/${id}/comments${qs}`, { as }))

async function pgStore() {
  const pg = new PGlite()
  const dir = new URL('../netlify/database/migrations/', import.meta.url)
  for (const m of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  return createDrizzleStore(drizzle({ client: pg, schema }))
}

describe('comments', () => {
  it('reviewers comment and pin; viewers read only; the list shows author and permissions', async () => {
    const h = harness()
    const rita = await person(h, 'u_rita', 'reviewer')
    const vic = await person(h, 'u_vic', 'viewer')
    const id = await readyVideo(h, h.member)
    const res = await post(h, rita, id, {
      versionN: 1,
      body: '  Logo too small  ',
      timeSec: 2.5,
      x: 0.4,
      y: 0.6,
    })
    expect(res.status).toBe(201)
    const c = await h.json(res)
    expect(c).toMatchObject({
      versionN: 1,
      body: 'Logo too small',
      timeSec: 2.5,
      x: 0.4,
      y: 0.6,
      author: { id: 'u_rita', name: 'u_rita' },
      can: { edit: true, delete: true, resolve: false },
    })
    const denied = await post(h, vic, id, { versionN: 1, body: 'Hi' })
    expect(denied.status).toBe(403)
    expect((await h.json(denied)).error.message).toContain('Your role (viewer)')
    const asVic = await list(h, vic, id)
    expect(asVic.items).toHaveLength(1)
    expect(asVic.items[0].can).toEqual({ edit: false, delete: false, resolve: false })
    const asOwner = await list(h, h.member, id)
    expect(asOwner.items[0].can).toEqual({ edit: false, delete: true, resolve: true })
  })

  it('validates pins: x/y paired, 0–1, need a moment, within the video, ready versions only', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    const bad = async (body: object) => (await post(h, bob, id, { versionN: 1, body: 'x', ...body })).status
    expect(await bad({ timeSec: 1, x: 0.5 })).toBe(400)
    expect(await bad({ x: 0.5, y: 0.5 })).toBe(400)
    expect(await bad({ timeSec: 1, x: 1.5, y: 0.5 })).toBe(400)
    expect(await bad({ timeSec: 9999 })).toBe(400)
    expect(await bad({ body: '   ' })).toBe(400)
    expect((await post(h, bob, id, { versionN: 9, body: 'x' })).status).toBe(404)
    // A version still running takes text comments but not pins.
    await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    expect((await post(h, bob, id, { versionN: 2, body: 'x', timeSec: 1 })).status).toBe(409)
    expect((await post(h, bob, id, { versionN: 2, body: 'Looking forward to it' })).status).toBe(201)
    expect((await list(h, bob, id, '?version=2')).items).toHaveLength(1)
    expect((await list(h, bob, id)).items).toHaveLength(1)
  })

  it('authors edit and delete their own; the owner and admins resolve or delete any', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const rita = await person(h, 'u_rita', 'reviewer')
    const id = await readyVideo(h, h.member)
    const c = await h.json(await post(h, bob, id, { versionN: 1, body: 'Too fast' }))
    const patch = (as: string, body: object) => h.call('PATCH', `/api/v1/comments/${c.id}`, { as, body })
    expect((await patch(rita, { body: 'hijack' })).status).toBe(403)
    expect((await patch(h.member, { body: 'owner edit' })).status).toBe(403)
    const edited = await h.json(await patch(bob, { body: 'Too fast at the end' }))
    expect(edited.body).toBe('Too fast at the end')
    expect(edited.editedAt).toBeTruthy()
    expect((await patch(bob, { resolved: true })).status).toBe(403)
    expect((await patch(rita, { resolved: true })).status).toBe(403)
    const resolved = await h.json(await patch(h.member, { resolved: true }))
    expect(resolved.resolvedBy).toMatchObject({ id: 'u_member' })
    const reopened = await h.json(await patch(h.admin, { resolved: false }))
    expect(reopened.resolvedAt).toBeNull()
    expect((await h.call('DELETE', `/api/v1/comments/${c.id}`, { as: rita })).status).toBe(403)
    expect((await h.call('DELETE', `/api/v1/comments/${c.id}`, { as: h.member })).status).toBe(204)
    expect((await list(h, bob, id)).items).toHaveLength(0)
    expect((await patch(bob, { body: 'gone' })).status).toBe(404)
    const own = await h.json(await post(h, rita, id, { versionN: 1, body: 'Mine' }))
    expect((await h.call('DELETE', `/api/v1/comments/${own.id}`, { as: rita })).status).toBe(204)
  })

  it('private videos hide their comments (404) from everyone but the owner and admins', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    const c = await h.json(await post(h, bob, id, { versionN: 1, body: 'Before private' }))
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await h.call('GET', `/api/v1/videos/${id}/comments`, { as: bob })).status).toBe(404)
    expect((await post(h, bob, id, { versionN: 1, body: 'x' })).status).toBe(404)
    expect((await h.call('PATCH', `/api/v1/comments/${c.id}`, { as: bob, body: { body: 'y' } })).status).toBe(
      404,
    )
    expect((await h.call('DELETE', `/api/v1/comments/${c.id}`, { as: bob })).status).toBe(404)
    expect((await list(h, h.admin, id)).items).toHaveLength(1)
    expect((await list(h, h.member, id)).items).toHaveLength(1)
  })

  it('counts unread comments from others and marks them read', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    await post(h, bob, id, { versionN: 1, body: 'One' })
    h.deps.clock.advance(1000)
    await post(h, bob, id, { versionN: 1, body: 'Two' })
    expect((await list(h, h.member, id)).unreadCount).toBe(2)
    expect((await list(h, bob, id)).unreadCount).toBe(0)
    expect((await h.call('POST', `/api/v1/videos/${id}/comments/read`, { as: h.member })).status).toBe(204)
    expect((await list(h, h.member, id)).unreadCount).toBe(0)
    h.deps.clock.advance(1000)
    await post(h, bob, id, { versionN: 1, body: 'Three' })
    expect((await list(h, h.member, id)).unreadCount).toBe(1)
    // Replying marks the thread read for you.
    h.deps.clock.advance(1000)
    await post(h, h.member, id, { versionN: 1, body: 'Thanks' })
    expect((await list(h, h.member, id)).unreadCount).toBe(0)
  })

  it('pages oldest first with a cursor', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    for (let i = 0; i < 5; i++) {
      await post(h, bob, id, { versionN: 1, body: `c${i}` })
      h.deps.clock.advance(1000)
    }
    const first = await list(h, bob, id, '?limit=2')
    expect(first.items.map((c: { body: string }) => c.body)).toEqual(['c0', 'c1'])
    const second = await list(h, bob, id, `?limit=2&cursor=${first.nextCursor}`)
    expect(second.items.map((c: { body: string }) => c.body)).toEqual(['c2', 'c3'])
    const third = await list(h, bob, id, `?limit=2&cursor=${second.nextCursor}`)
    expect(third.items.map((c: { body: string }) => c.body)).toEqual(['c4'])
    expect(third.nextCursor).toBeNull()
  })

  it("emits comment.created to the owner's webhook and notifies the owner, not the author", async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    const { dataEncryptionKey } = await getSettings(h.deps)
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.putUserWebhook({
      userId: 'u_member',
      url: 'https://mia.example.com/hook',
      secretEnc: encrypt(dataEncryptionKey, 's'),
      createdAt: now,
      updatedAt: now,
    })
    await post(h, bob, id, { versionN: 1, body: 'The CTA is too quick', timeSec: 1.5 })
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    const body = JSON.parse(h.deps.http.calls.at(-1)?.body ?? '{}')
    expect(body.event).toBe('comment.created')
    expect(body.comment).toMatchObject({
      body: 'The CTA is too quick',
      author: { id: 'u_bob' },
      timeSec: 1.5,
    })
    const feed = await h.json(await h.call('GET', '/api/v1/notifications', { as: h.member }))
    expect(feed.items[0].summary).toBe('u_bob commented on v1 at 1.5s: The CTA is too quick')
    // The owner commenting on their own video notifies nobody.
    await post(h, h.member, id, { versionN: 1, body: 'Noted' })
    const again = await h.json(await h.call('GET', '/api/v1/notifications', { as: h.member }))
    expect(again.items).toHaveLength(1)
  })

  it('MCP add_comment and list_comments; add_comment is hidden from viewers', async () => {
    const h = harness()
    const rita = await person(h, 'u_rita', 'reviewer')
    const vic = await person(h, 'u_vic', 'viewer')
    const id = await readyVideo(h, h.member)
    const mcp = async (cookie: string, method: string, params: unknown) => {
      const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: cookie, body: { name: 'k' } })))
        .key
      const res = await h.call('POST', '/api/mcp', {
        origin: null,
        headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: { jsonrpc: '2.0', id: 1, method, params },
      })
      return ((await res.json()) as { result: any }).result
    }
    const added = await mcp(rita, 'tools/call', {
      name: 'add_comment',
      arguments: { video_id: id, version: 1, body: 'Slower intro', time_sec: 1 },
    })
    expect(added.isError).toBeFalsy()
    expect(added.structuredContent.comment_id).toBeTruthy()
    const listed = await mcp(vic, 'tools/call', { name: 'list_comments', arguments: { video_id: id } })
    expect(listed.structuredContent.comments).toEqual([
      expect.objectContaining({ author: 'u_rita', body: 'Slower intro', time_sec: 1, version: 1 }),
    ])
    const tools = (await mcp(vic, 'tools/list', {})).tools.map((t: { name: string }) => t.name)
    expect(tools).not.toContain('add_comment')
  })

  it('works on Postgres: insert, list by version, resolve, read watermark upsert', async () => {
    const h = harness({}, { store: await pgStore() })
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    const c = await h.json(await post(h, bob, id, { versionN: 1, body: 'pg', timeSec: 1, x: 0.1, y: 0.2 }))
    expect((await list(h, h.member, id, '?version=1')).items[0]).toMatchObject({ body: 'pg', x: 0.1 })
    await h.call('PATCH', `/api/v1/comments/${c.id}`, { as: h.member, body: { resolved: true } })
    expect((await list(h, h.member, id)).items[0].resolvedAt).toBeTruthy()
    await h.call('POST', `/api/v1/videos/${id}/comments/read`, { as: h.member })
    await h.call('POST', `/api/v1/videos/${id}/comments/read`, { as: h.member })
    expect((await list(h, h.member, id)).unreadCount).toBe(0)
  })
})
