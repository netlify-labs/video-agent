// Looks' data (plan 2026-11-04-looks §4.3, §6): versions.look round-trips its snapshot on both stores, old rows read
// as no look, and the settings' default look and disabled looks round-trip with their defaults (none, nothing off).
import { describe, expect, it } from 'vitest'
import { lookSettings } from '../server/domain/look-settings.js'
import type { VersionLook } from '../server/domain/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const look = (restyle: boolean): VersionLook => ({
  id: 'kinetic',
  name: 'Kinetic type',
  hash: 'c'.repeat(64),
  key: `vid_0001/looks/${'c'.repeat(64)}.tar.gz`,
  sha256: 'd'.repeat(64),
  bytes: 4275,
  source: 'builtin',
  restyle,
})

async function scenario(h: Harness) {
  const { id } = await h.json<{ id: string }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  // A version made before looks existed reads as no look.
  expect((await h.deps.store.getVersion(id, 1))?.look ?? null).toBeNull()
  for (const restyle of [true, false]) {
    await h.deps.store.updateVersion(id, 1, { look: look(restyle) })
    expect((await h.deps.store.getVersion(id, 1))?.look).toEqual(look(restyle))
  }
  await h.deps.store.updateVersion(id, 1, { look: null })
  expect((await h.deps.store.getVersion(id, 1))?.look ?? null).toBeNull()

  expect(await lookSettings(h.deps)).toEqual({ defaultLook: null, disabledLooks: [] })
  await h.deps.store.updateSettings({
    defaultLook: 'clean',
    disabledLooks: ['terminal', 'kinetic', 'terminal'],
  })
  // Kept as written: the domain layer validates and de-duplicates.
  expect(await lookSettings(h.deps)).toEqual({
    defaultLook: 'clean',
    disabledLooks: ['terminal', 'kinetic', 'terminal'],
  })
  await h.deps.store.updateSettings({ defaultLook: null, disabledLooks: [] })
  expect(await lookSettings(h.deps)).toEqual({ defaultLook: null, disabledLooks: [] })
}

describe('looks data', () => {
  it('round-trips on the memory store', async () => {
    await scenario(harness())
  })

  it('round-trips on Postgres, every migration applied', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})
