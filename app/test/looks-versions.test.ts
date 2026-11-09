// Which look each new version gets (plan 2026-11-04-looks §4.3's table), through the domain functions (the API's look
// fields are va-nifa.3.9): create, revise (inherit, restyle, none, narrated refusal), remix (inherit from the source's
// blob, restyle) and edit renders (refused, base's look kept).
import { describe, expect, it } from 'vitest'
import { renderEdit } from '../server/domain/edits.js'
import { lookKey, lookReservationId } from '../server/domain/look-snapshot.js'
import { getLook } from '../server/domain/looks.js'
import { userPrincipal, type Principal } from '../server/domain/policy.js'
import { remixVideo } from '../server/domain/remix.js'
import { createVideo, reviseVideo } from '../server/domain/videos.js'
import { ApiError } from '../server/lib/errors.js'
import { harness, PROMPT, type Harness } from './helpers.js'

async function member(h: Harness): Promise<Principal> {
  await h.call('GET', '/api/v1/me', { as: h.member })
  const u = (await h.deps.store.getUser('u_member'))!
  return userPrincipal(u)
}

const created = async (h: Harness, p: Principal, look?: string | null) =>
  (await createVideo(h.deps, p, { prompt: PROMPT, ...(look === undefined ? {} : { look }) })).body
    .id

const v = async (h: Harness, id: string, n = 1) => (await h.deps.store.getVersion(id, n))!

const fails = async (f: () => Promise<unknown>) => {
  try {
    await f()
  } catch (e) {
    return e instanceof ApiError ? [e.code, e.status] : String(e)
  }
  return null
}

async function scenario(h: Harness) {
  const p = await member(h)
  const kinetic = getLook(h.deps, 'kinetic')!
  const clean = getLook(h.deps, 'clean')!

  // Create: a pick is snapshotted and adopted; omitted with no default and explicit null are none.
  const a = await created(h, p, 'kinetic')
  expect((await v(h, a)).look).toMatchObject({
    id: 'kinetic',
    hash: kinetic.hash,
    key: lookKey(a, kinetic.hash),
    restyle: false,
  })
  expect(await h.deps.blobs.get('sources', lookKey(a, kinetic.hash))).not.toBeNull()
  expect(
    (await h.deps.store.listDueCleanup('9999-12-31T00:00:00.000Z', 500)).some(
      (c) => c.id === lookReservationId(a, kinetic.hash),
    ),
  ).toBe(false)
  expect((await v(h, await created(h, p))).look ?? null).toBeNull()
  // The admin default applies only when omitted; null still means none; unknown is 400, disabled is 409.
  await h.deps.store.updateSettings({ defaultLook: 'clean', disabledLooks: ['terminal'] })
  expect((await v(h, await created(h, p))).look?.id).toBe('clean')
  expect((await v(h, await created(h, p, null))).look ?? null).toBeNull()
  expect(await fails(() => created(h, p, 'nope'))).toEqual(['unknown_look', 400])
  expect(await fails(() => created(h, p, 'terminal'))).toEqual(['look_disabled', 409])
  await h.deps.store.updateSettings({ defaultLook: null, disabledLooks: [] })

  // Revise: omitted inherits the parent's snapshot (same key, no copy); a new look restyles; null is none.
  await h.drive(4)
  const parent = (await v(h, a)).look!
  await reviseVideo(h.deps, p, a, { prompt: 'Tighter' })
  expect((await v(h, a, 2)).look).toEqual({ ...parent, restyle: false })
  await h.drive(4)
  await reviseVideo(h.deps, p, a, { prompt: 'Calmer', look: 'clean' })
  expect((await v(h, a, 3)).look).toMatchObject({
    id: 'clean',
    hash: clean.hash,
    key: lookKey(a, clean.hash),
    restyle: true,
  })
  await h.drive(4)
  await reviseVideo(h.deps, p, a, { prompt: 'Same look, picked again', look: 'clean' })
  expect((await v(h, a, 4)).look?.restyle).toBe(false)
  await h.drive(4)
  await reviseVideo(h.deps, p, a, { prompt: 'No look', look: null })
  expect((await v(h, a, 5)).look ?? null).toBeNull()
  await h.drive(4)
  // A look-less parent stays look-less when omitted, even with an admin default set.
  await h.deps.store.updateSettings({ defaultLook: 'kinetic' })
  await reviseVideo(h.deps, p, a, { prompt: 'Still none' })
  expect((await v(h, a, 6)).look ?? null).toBeNull()
  await h.deps.store.updateSettings({ defaultLook: null })
  await h.drive(4)

  // A restyle of a version with recorded narration is 409; its own look again is fine.
  await h.deps.store.updateVersion(a, 6, { narration: { bus: { samples: 48000 } } as never })
  expect(await fails(() => reviseVideo(h.deps, p, a, { prompt: 'Restyle', look: 'kinetic' }))).toEqual([
    'look_not_allowed',
    409,
  ])

  // Remix: omitted keeps the source's look, copied under the remix's prefix from the source's blob; another look
  // restyles as a new video.
  const r1 = (await remixVideo(h.deps, p, a, { prompt: 'Same, for payments', fromVersion: 3 })).body
    .id
  expect((await v(h, r1)).look).toMatchObject({
    id: 'clean',
    hash: clean.hash,
    key: lookKey(r1, clean.hash),
    restyle: false,
  })
  expect(await h.deps.blobs.get('sources', lookKey(r1, clean.hash))).not.toBeNull()
  const r2 = (await remixVideo(h.deps, p, a, { prompt: 'Punchier', fromVersion: 3, look: 'kinetic' })).body
    .id
  expect((await v(h, r2)).look).toMatchObject({ id: 'kinetic', restyle: true })
  expect(h.deps.logs.some((l) => l.includes('"video.remixed"') && l.includes('"restyle":true'))).toBe(true)

  // Edit renders keep the edited version's look; a look in the request is refused.
  expect(await fails(() => renderEdit(h.deps, p, 'edt_any', undefined, { look: 'kinetic' }))).toEqual([
    'look_not_allowed',
    400,
  ])
}

// Memory store only: these call the domain functions directly, which this harness can't do on PGlite (a direct
// createVideo hangs there with or without looks; the HTTP path doesn't). The Postgres round-trip of the look columns
// is in app/test/look-settings.test.ts, and va-nifa.3.9 runs this table through the API on both stores.
describe('looks on new versions', () => {
  it('follows the §4.3 table', async () => {
    await scenario(harness())
  })
})
