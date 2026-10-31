// Plan v2 roles: admin, creator, reviewer, viewer (plan §3, §14 rules 1–2).
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { can, ROLES, type Action, type Principal } from '../src/domain/policy.js'
import type { Role } from '../src/domain/types.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

/** Signs a new person in (which creates their row) and, if asked, has the admin set their role. */
async function person(h: Harness, id: string, role?: Role) {
  const cookie = h.deps.identity.addUser({ id, email: `${id}@acme.com`, name: id }).cookie
  await h.call('GET', '/api/v1/me', { as: cookie })
  if (role) {
    const res = await h.call('PATCH', `/api/v1/users/${id}`, { as: h.admin, body: { role } })
    expect(res.status).toBe(200)
  }
  return cookie
}

async function mcpCreate(h: Harness, key: string) {
  const res = await h.call('POST', '/api/mcp', {
    origin: null,
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_video', arguments: { prompt: PROMPT } },
    },
  })
  return (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
}

describe('roles', () => {
  it('new people join as creators and can make videos', async () => {
    const h = harness()
    expect((await h.json(await h.call('GET', '/api/v1/me', { as: h.member }))).role).toBe('creator')
    expect((await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })).status).toBe(
      202,
    )
  })

  it('reviewers and viewers watch but never spend credits, through the API, keys and MCP', async () => {
    const h = harness()
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    for (const role of ['reviewer', 'viewer'] as const) {
      const cookie = await person(h, `u_${role}`, role)
      expect((await h.call('GET', `/api/v1/videos/${video.id}`, { as: cookie })).status).toBe(200)
      expect((await h.call('GET', '/api/v1/videos', { as: cookie })).status).toBe(200)

      const denied = await h.call('POST', '/api/v1/videos', { as: cookie, body: { prompt: PROMPT } })
      expect(denied.status).toBe(403)
      expect((await h.json(denied)).error.message).toBe(
        `Your role (${role}) can't create videos. Ask an admin to change it.`,
      )
      expect(
        (
          await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
            as: cookie,
            body: { prompt: 'Make it blue' },
          })
        ).status,
      ).toBe(403)

      // Keys inherit the role.
      const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: cookie, body: { name: role } })))
        .key
      expect(
        (await h.call('POST', '/api/v1/videos', { key, origin: null, body: { prompt: PROMPT } })).status,
      ).toBe(403)
      const mcp = await mcpCreate(h, key)
      expect(mcp.result.isError).toBe(true)
      // The tool isn't even listed for this role, so calling it fails as unknown.
      expect(mcp.result.content[0]?.text).toContain('create_video')
    }
  })

  it('a demotion takes effect on the next request; a demoted author can cancel but not retry', async () => {
    const h = harness()
    const cookie = await person(h, 'u_cara')
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: cookie, body: { prompt: PROMPT } }),
    )
    await person(h, 'u_cara', 'reviewer')
    expect((await h.call('POST', '/api/v1/videos', { as: cookie, body: { prompt: PROMPT } })).status).toBe(
      403,
    )
    const cancel = await h.call('POST', `/api/v1/videos/${video.id}/versions/1/cancel`, { as: cookie })
    expect([200, 202]).toContain(cancel.status)
    await h.drive(3)
    const after = await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: cookie }))
    expect(after.versions[0].status).toBe('cancelled')
    expect((await h.call('POST', `/api/v1/videos/${video.id}/versions/1/retry`, { as: cookie })).status).toBe(
      403,
    )
  })

  it('the last enabled admin cannot be demoted to any role or disabled', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.admin })
    for (const role of ['creator', 'reviewer', 'viewer'] as const) {
      const res = await h.call('PATCH', '/api/v1/users/u_admin', { as: h.admin, body: { role } })
      expect(res.status).toBe(409)
    }
    expect(
      (await h.call('PATCH', '/api/v1/users/u_admin', { as: h.admin, body: { disabled: true } })).status,
    ).toBe(409)
    await person(h, 'u_second', 'admin')
    expect(
      (await h.call('PATCH', '/api/v1/users/u_admin', { as: h.admin, body: { role: 'viewer' } })).status,
    ).toBe(200)
  })

  it('only admins manage people', async () => {
    const h = harness()
    for (const role of ['creator', 'reviewer', 'viewer'] as const) {
      const cookie = await person(h, `u_${role}`, role === 'creator' ? undefined : role)
      expect((await h.call('GET', '/api/v1/users', { as: cookie })).status).toBe(403)
    }
  })
})

describe('policy matrix', () => {
  const p = (role: Role, userId = 'me'): Principal => ({
    kind: 'user',
    userId,
    email: 'x@acme.com',
    name: null,
    role,
    apiKeyId: null,
  })
  const table: [Action, Record<Role, boolean>, { ownerId?: string; authorId?: string }?][] = [
    ['video:read', { admin: true, creator: true, reviewer: true, viewer: true }],
    ['keys:manage', { admin: true, creator: true, reviewer: true, viewer: true }],
    ['comment:create', { admin: true, creator: true, reviewer: true, viewer: false }],
    ['verdict:set', { admin: true, creator: true, reviewer: true, viewer: false }],
    ['video:create', { admin: true, creator: true, reviewer: false, viewer: false }],
    ['version:create', { admin: true, creator: true, reviewer: false, viewer: false }],
    ['plan:create', { admin: true, creator: true, reviewer: false, viewer: false }],
    ['edit:create', { admin: true, creator: true, reviewer: false, viewer: false }],
    ['media:upload', { admin: true, creator: true, reviewer: false, viewer: false }],
    ['video:publish', { admin: true, creator: true, reviewer: false, viewer: false }, { ownerId: 'me' }],
    ['video:publish', { admin: true, creator: false, reviewer: false, viewer: false }, { ownerId: 'other' }],
    ['video:private', { admin: true, creator: true, reviewer: false, viewer: false }, { ownerId: 'me' }],
    ['video:incorporate', { admin: true, creator: true, reviewer: false, viewer: false }, { ownerId: 'me' }],
    ['version:retry', { admin: true, creator: true, reviewer: false, viewer: false }, { authorId: 'me' }],
    ['version:cancel', { admin: true, creator: true, reviewer: true, viewer: true }, { authorId: 'me' }],
    [
      'version:cancel',
      { admin: true, creator: false, reviewer: false, viewer: false },
      { authorId: 'other' },
    ],
    ['users:manage', { admin: true, creator: false, reviewer: false, viewer: false }],
    ['settings:manage', { admin: true, creator: false, reviewer: false, viewer: false }],
    ['video:transfer', { admin: true, creator: false, reviewer: false, viewer: false }],
  ]
  it.each(table)('%s', (action, expected, resource) => {
    for (const role of ROLES) expect([role, can(p(role), action, resource)]).toEqual([role, expected[role]])
  })
})

describe('roles migration', () => {
  it('moves existing members to creator', async () => {
    const pg = new PGlite()
    const dir = new URL('../netlify/database/migrations/', import.meta.url)
    const [init, ...rest] = readdirSync(dir).sort()
    const run = async (m: string) => {
      const sql = readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8')
      for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
    }
    await run(init as string)
    const now = new Date().toISOString()
    await pg.query(
      `INSERT INTO users (id, email, name, role, admitted_via, created_at, last_seen_at) VALUES
       ('u1', 'a@acme.com', null, 'admin', 'domain', $1, $1), ('u2', 'b@acme.com', null, 'member', 'domain', $1, $1)`,
      [now],
    )
    for (const m of rest) await run(m)
    const rows = await pg.query<{ id: string; role: string }>('SELECT id, role FROM users ORDER BY id')
    expect(rows.rows).toEqual([
      { id: 'u1', role: 'admin' },
      { id: 'u2', role: 'creator' },
    ])
  })
})

describe('MCP tools by role', () => {
  it('reviewers and viewers see only the tools their role can use', async () => {
    const h = harness()
    const names = async (cookie: string) => {
      const key = (await h.json(await h.call('POST', '/api/v1/keys', { as: cookie, body: { name: 'k' } })))
        .key
      const res = await h.call('POST', '/api/mcp', {
        origin: null,
        headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools
        .map((t) => t.name)
        .sort()
    }
    expect(await names(h.member)).toEqual(
      [
        'cancel_video',
        'create_video',
        'get_video',
        'list_videos',
        'publish_video',
        'revise_video',
        'unpublish_video',
      ].sort(),
    )
    for (const role of ['reviewer', 'viewer'] as const) {
      const cookie = await person(h, `u_${role}`, role)
      expect(await names(cookie)).toEqual(['cancel_video', 'get_video', 'list_videos'])
    }
  })
})
