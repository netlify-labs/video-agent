// Look snapshots (plan 2026-11-04-looks §4.3): copied once per video and hash under a reservation the creating
// transaction adopts and the sweep deletes otherwise; re-opened, never inserted twice; a remix copies its source's own
// snapshot. Memory store and PGlite.
import { describe, expect, it } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { adoptLookSnapshot, lookKey, lookReservationId, snapshotLook } from '../src/domain/look-snapshot.js'
import { getLook } from '../src/domain/looks.js'
import { ApiError } from '../src/lib/errors.js'
import { sha256Hex } from '../src/lib/run-manifest.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const video = async (h: Harness) =>
  (
    await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
  ).id

const due = async (h: Harness, id: string) =>
  (await h.deps.store.listDueCleanup('9999-12-31T00:00:00.000Z', 500)).find((c) => c.id === id) ?? null

const copies = (h: Harness, copied: boolean) =>
  h.deps.logs.filter((l) => l.includes('"look.snapshot"') && l.includes(`"copied":${copied}`)).length

async function scenario(h: Harness) {
  const jobId = await video(h)
  const kinetic = getLook(h.deps, 'kinetic')!
  const key = lookKey(jobId, kinetic.hash)
  const rid = lookReservationId(jobId, kinetic.hash)

  // A pick copies the bundled archive under an open reservation, and reads it back.
  const look = await snapshotLook(h.deps, jobId, { from: 'bundle', entry: kinetic }, false)
  expect(look).toMatchObject({
    id: 'kinetic',
    hash: kinetic.hash,
    key,
    sha256: kinetic.sha256,
    restyle: false,
  })
  expect(sha256Hex((await h.deps.blobs.get('sources', key))!)).toBe(kinetic.sha256)
  expect(await due(h, rid)).toMatchObject({ prefix: key, doneAt: null })
  expect(copies(h, true)).toBe(1)

  // A failed create never adopted it: the next pick re-opens the same row (no unique-index error) and copies again,
  // never trusting the blob that's there.
  await snapshotLook(h.deps, jobId, { from: 'bundle', entry: kinetic }, true)
  expect(copies(h, true)).toBe(2)

  // Adoption inside the transaction; then a committed version references the key, so later picks skip the copy.
  await h.deps.store.tx((repo) =>
    adoptLookSnapshot(repo, h.deps, jobId, look, h.deps.clock.now().toISOString()),
  )
  await h.deps.store.updateVersion(jobId, 1, { look })
  expect(await due(h, rid)).toBeNull()
  await snapshotLook(h.deps, jobId, { from: 'bundle', entry: kinetic }, false)
  expect(copies(h, false)).toBe(1)

  // Deleting the video removes the snapshot with its prefix.
  expect((await h.call('DELETE', `/api/v1/videos/${jobId}`, { as: h.member })).status).toBe(202)
  await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 50 })
  expect(await h.deps.blobs.list('sources', `${jobId}/looks/`)).toEqual([])
}

describe('look snapshots', () => {
  it('copy, re-open, adopt and delete with the video (memory)', async () => {
    await scenario(harness())
  })

  it('copy, re-open, adopt and delete with the video (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })

  it('the sweep deletes a copy no version adopted', async () => {
    const h = harness()
    const jobId = await video(h)
    const kinetic = getLook(h.deps, 'kinetic')!
    await snapshotLook(h.deps, jobId, { from: 'bundle', entry: kinetic }, false)
    h.deps.clock.t += 2 * 60 * 60 * 1000
    await runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 50 })
    expect(await h.deps.blobs.get('sources', lookKey(jobId, kinetic.hash))).toBeNull()
  })

  it('a corrupt bundled archive is a server error, logged', async () => {
    const h = harness()
    const jobId = await video(h)
    const kinetic = getLook(h.deps, 'kinetic')!
    h.deps.looks.archives.set(`kinetic:${kinetic.hash}`, new Uint8Array([1, 2, 3]))
    const err = await snapshotLook(h.deps, jobId, { from: 'bundle', entry: kinetic }, false).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect(h.deps.logs.some((l) => l.includes('look.archive_corrupt') && l.includes('"id":"kinetic"'))).toBe(
      true,
    )
  })
})

describe('a remix inheriting its source look', () => {
  async function source(h: Harness) {
    const from = await video(h)
    const kinetic = getLook(h.deps, 'kinetic')!
    const look = await snapshotLook(h.deps, from, { from: 'bundle', entry: kinetic }, false)
    return { look, kinetic }
  }

  it("copies the source's own snapshot, even when the catalog has a newer version", async () => {
    const h = harness()
    const { look } = await source(h)
    h.deps.looks.entries = h.deps.looks.entries.map((e) =>
      e.id === 'kinetic' ? h.deps.looks.make('kinetic', { body: 'v2' }) : e,
    )
    const remix = await video(h)
    const copied = await snapshotLook(h.deps, remix, { from: 'blob', look }, false)
    expect(copied.hash).toBe(look.hash)
    expect(copied.key).toBe(lookKey(remix, look.hash))
    expect(sha256Hex((await h.deps.blobs.get('sources', copied.key))!)).toBe(look.sha256)
  })

  it('falls back to the bundled archive at the same hash, else refuses with 409', async () => {
    const h = harness()
    const { look } = await source(h)
    await h.deps.blobs.delete('sources', look.key)
    const remix = await video(h)
    expect((await snapshotLook(h.deps, remix, { from: 'blob', look }, false)).hash).toBe(look.hash)

    h.deps.looks.entries = h.deps.looks.entries.map((e) =>
      e.id === 'kinetic' ? h.deps.looks.make('kinetic', { body: 'v2' }) : e,
    )
    const other = await video(h)
    const err = await snapshotLook(h.deps, other, { from: 'blob', look }, false).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).message).toBe(
      "The source video's look snapshot is missing; pick a look for the remix.",
    )
  })
})
