// Looks' admin settings (plan 2026-11-04-looks §6): the default look and the disabled looks round-trip through
// PATCH /api/v1/admin/settings, checked as they'd be after the patch, and only admins change them.
import { describe, expect, it } from 'vitest'
import { harness, pgStore, type Harness } from './helpers.js'

async function scenario(h: Harness) {
  const patch = async (body: unknown, as = h.admin) => {
    const res = await h.call('PATCH', '/api/v1/admin/settings', { as, body })
    return {
      status: res.status,
      body: await h.json<Record<string, unknown> & { error?: { code: string; message: string } }>(res),
    }
  }
  const get = async () => h.json(await h.call('GET', '/api/v1/admin/settings', { as: h.admin }))

  expect(await get()).toMatchObject({ defaultLook: null, disabledLooks: [] })
  // Stored de-duplicated in catalog order.
  expect((await patch({ disabledLooks: ['terminal', 'kinetic', 'terminal'] })).body).toMatchObject({
    disabledLooks: ['kinetic', 'terminal'],
  })
  expect((await patch({ defaultLook: 'clean' })).body).toMatchObject({ defaultLook: 'clean' })
  expect(await get()).toMatchObject({ defaultLook: 'clean', disabledLooks: ['kinetic', 'terminal'] })

  const refused = async (body: unknown, message: RegExp) => {
    const r = await patch(body)
    expect(r.status).toBe(400)
    expect(r.body.error?.code).toBe('invalid_request')
    expect(r.body.error?.message).toMatch(message)
  }
  await refused({ defaultLook: 'nope' }, /no look called "nope"/)
  await refused({ disabledLooks: ['nope'] }, /no look called "nope"/)
  await refused({ defaultLook: 'kinetic' }, /Kinetic is turned off/)
  await refused(
    { disabledLooks: ['clean'] },
    /Clean is the default look. Pick another default first, or None/,
  )
  // Both at once is fine: a new default and the old one off.
  expect((await patch({ defaultLook: null, disabledLooks: ['clean'] })).body).toMatchObject({
    defaultLook: null,
    disabledLooks: ['clean'],
  })
  // Members can't change them.
  expect((await patch({ defaultLook: 'kinetic' }, h.member)).status).toBe(403)
}

describe('looks admin settings', () => {
  it('round-trips and refuses bad combinations (memory)', async () => {
    await scenario(harness())
  })

  it('round-trips and refuses bad combinations (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  }, 60_000)
})
