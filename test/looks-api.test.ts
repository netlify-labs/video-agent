// Looks in the REST API (plan 2026-11-04-looks §4.9): GET /api/v1/looks for every role, `look` on create, revise and
// remix through HTTP, the version DTO's look, the error codes and statuses, the `looks` feature, and the OpenAPI
// x-sdk gating. Memory store and PGlite.
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { getSettings } from '../src/domain/settings.js'
import { harness, person, pgStore, PROMPT, type Harness } from './helpers.js'

interface Dto {
  id: string
  versions: { n: number; look: { id: string; name: string; hash: string } | null }[]
  error?: { code: string; message: string }
}

const look = (d: Dto, n: number) => d.versions.find((v) => v.n === n)?.look ?? null

async function scenario(h: Harness) {
  const post = async (path: string, body: unknown, as = h.member) => {
    const res = await h.call('POST', path, { as, body })
    return { status: res.status, body: await h.json<Dto>(res) }
  }
  // Create with a look; the DTO names it with its hash; omitted is none by default; null is none.
  const kinetic = h.deps.looks.catalog().find((l) => l.id === 'kinetic')!
  const a = await post('/api/v1/videos', { prompt: PROMPT, look: 'kinetic' })
  expect(a.status).toBe(202)
  expect(look(a.body, 1)).toEqual({ id: 'kinetic', name: kinetic.name, hash: kinetic.hash })
  expect(look((await post('/api/v1/videos', { prompt: PROMPT })).body, 1)).toBeNull()
  expect(look((await post('/api/v1/videos', { prompt: PROMPT, look: null })).body, 1)).toBeNull()
  // Errors with their statuses.
  const unknown = await post('/api/v1/videos', { prompt: PROMPT, look: 'nope' })
  expect([unknown.status, unknown.body.error?.code]).toEqual([400, 'unknown_look'])
  expect((await post('/api/v1/videos', { prompt: PROMPT, look: 'Not A Slug' })).status).toBe(400)
  await h.deps.store.updateSettings({ disabledLooks: ['terminal'] })
  const disabled = await post('/api/v1/videos', { prompt: PROMPT, look: 'terminal' })
  expect([disabled.status, disabled.body.error?.code]).toEqual([409, 'look_disabled'])
  await h.deps.store.updateSettings({ disabledLooks: [] })

  // Revise inherits, restyles; remix inherits and restyles.
  await h.drive(4)
  expect(look((await post(`/api/v1/videos/${a.body.id}/versions`, { prompt: 'Tighter' })).body, 2)).toEqual(
    look(a.body, 1),
  )
  await h.drive(4)
  const restyled = await post(`/api/v1/videos/${a.body.id}/versions`, { prompt: 'Calmer', look: 'clean' })
  expect(look(restyled.body, 3)?.id).toBe('clean')
  await h.drive(4)
  const remix = await post(`/api/v1/videos/${a.body.id}/remix`, { prompt: 'For payments', fromVersion: 1 })
  expect(remix.status).toBe(202)
  expect(look(remix.body, 1)?.id).toBe('kinetic')
  // A narrated restyle is 409 look_not_allowed (the same code a render with a look gets as 400).
  await h.deps.store.updateVersion(a.body.id, 3, { narration: { bus: { samples: 48000 } } as never })
  const narrated = await post(`/api/v1/videos/${a.body.id}/versions`, { prompt: 'Restyle', look: 'kinetic' })
  expect([narrated.status, narrated.body.error?.code]).toEqual([409, 'look_not_allowed'])

  // A Viewer can list looks but can't create.
  const viewer = await person(h, 'u_viewer', 'viewer')
  expect((await h.call('GET', '/api/v1/looks', { as: viewer })).status).toBe(200)
  expect((await post('/api/v1/videos', { prompt: PROMPT, look: 'kinetic' }, viewer)).status).toBe(403)
}

describe('looks API', () => {
  it('lists every look with enabled and the default, for every role', async () => {
    const h = harness()
    await getSettings(h.deps) // the settings row is made on first read
    const body = await h.json<{
      looks: { id: string; enabled: boolean; hash: string }[]
      default: string | null
    }>(await h.call('GET', '/api/v1/looks', { as: h.member }))
    expect(body.looks.map((l) => l.id)).toEqual(['clean', 'kinetic', 'terminal'])
    expect(body.looks.every((l) => l.enabled && /^[0-9a-f]{64}$/.test(l.hash))).toBe(true)
    expect(body.default).toBeNull()
    await h.deps.store.updateSettings({ defaultLook: 'clean', disabledLooks: ['kinetic'] })
    const after = await h.json<{ looks: { id: string; enabled: boolean }[]; default: string | null }>(
      await h.call('GET', '/api/v1/looks', { as: h.member }),
    )
    expect(after.looks.find((l) => l.id === 'kinetic')?.enabled).toBe(false)
    expect(after.default).toBe('clean')
  })

  it('lists looks among the features', async () => {
    const h = harness()
    const config = await h.json<{ features: string[] }>(
      await h.call('GET', '/api/v1/config', { as: h.member }),
    )
    expect(config.features).toContain('looks')
  })

  it('takes look on create, revise and remix (memory)', async () => {
    await scenario(harness())
  })

  it('takes look on create, revise and remix (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  }, 60_000)

  it('gates listLooks and the look fields on the looks feature in OpenAPI', () => {
    const doc = createApp(harness().deps, {
      isLive: () => true,
      contextIsDefault: false,
    }).getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    }) as unknown as {
      paths: Record<string, Record<string, { operationId: string; 'x-sdk': Record<string, unknown> }>>
    }
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p))
    const op = (id: string) => ops.find((o) => o.operationId === id)!['x-sdk']
    expect(op('listLooks')).toMatchObject({ resource: 'looks', method: 'list', feature: 'looks' })
    for (const id of ['createVideo', 'reviseVideo', 'remixVideo'])
      expect((op(id).fieldFeatures as Record<string, string>).look).toBe('looks')
  })
})
