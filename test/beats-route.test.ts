// A version's beats for older versions (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.2): filled from the
// bundle on first read and stored, never for someone who can't see the video, never inside a transaction.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fillBeats } from '../src/domain/beats.js'
import type { Principal } from '../src/domain/policy.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]
const opts = async (store: () => Promise<Store | undefined>) => {
  const s = await store()
  return s ? { store: s } : {}
}

const person = (userId: string, role: Principal['role']): Principal => ({
  kind: 'user',
  userId,
  email: `${userId}@acme.com`,
  name: userId,
  role,
  apiKeyId: null,
})
const mia = person('u_member', 'creator')
const eve = person('u_out', 'viewer')

/** Records every Blobs call, and fails the test if one happens while a store transaction is open. */
function watch(h: Harness) {
  const calls: string[] = []
  let inTx = 0
  const tx = h.deps.store.tx.bind(h.deps.store)
  h.deps.store.tx = async (f) => {
    inTx++
    try {
      return await tx(f)
    } finally {
      inTx--
    }
  }
  for (const m of ['get', 'set', 'list', 'delete'] as const) {
    const orig = h.deps.blobs[m].bind(h.deps.blobs) as (...a: unknown[]) => Promise<unknown>
    ;(h.deps.blobs as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
      if (inTx) throw new Error(`Blobs ${m} inside a transaction`)
      calls.push(`${m}:${String(a[0])}:${String(a[1])}`)
      return orig(...a)
    }
  }
  return calls
}

/** A ready contract-v1 video made before beats were recorded: no beats on the version, no bundle yet. */
async function prePlan(h: Harness, html = music) {
  h.deps.nextSource = tarGz([{ name: 'video/index.html', body: html }])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const id = v.id as string
  await h.deps.store.updateVersion(id, 1, { beats: null })
  for (const k of await h.deps.blobs.list('bundles', `${id}/`)) await h.deps.blobs.delete('bundles', k)
  return id
}

describe.each(stores)('fillBeats (%s)', (_name, store) => {
  it('fills an older version from its bundle, stores it, then serves it without Blobs', async () => {
    const h = harness({}, await opts(store))
    const id = await prePlan(h)
    const calls = watch(h)
    const beats = await fillBeats(h.deps, mia, id, 1)
    expect(beats?.map((b) => [b.id, b.label])).toEqual([
      ['intro', 'Opening'],
      ['demo', null],
      ['outro', null],
    ])
    expect(calls.some((c) => c.startsWith('get:sources:'))).toBe(true)
    expect((await h.deps.store.getVersion(id, 1))?.beats).toEqual(beats)
    expect((await h.deps.store.getVersion(id, 1))?.contract).toBe(1)
    calls.length = 0
    expect(await fillBeats(h.deps, mia, id, 1)).toEqual(beats)
    expect(calls).toEqual([])
    expect(h.deps.logs.some((l) => l.includes('beats.fill') && l.includes('"cached":true'))).toBe(true)
  })

  it('a non-contract version has no beats and nothing is unpacked', async () => {
    const h = harness({}, await opts(store))
    const id = await prePlan(h, '<!doctype html><h1>free-form</h1>')
    const calls = watch(h)
    expect(await fillBeats(h.deps, mia, id, 1)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('fillBeats refusals', () => {
  it('a version that is not ready is not_ready; a missing one is not_found', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await expect(fillBeats(h.deps, mia, v.id, 1)).rejects.toMatchObject({ code: 'not_ready' })
    await expect(fillBeats(h.deps, mia, v.id, 9)).rejects.toMatchObject({ code: 'not_found' })
  })

  it("a private video someone can't see, or a deleted one, is not_found with no Blobs work", async () => {
    const h = harness()
    const id = await prePlan(h)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    const calls = watch(h)
    await expect(fillBeats(h.deps, eve, id, 1)).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toEqual([])
    // The owner and an admin can.
    expect(await fillBeats(h.deps, person('u_admin', 'admin'), id, 1)).toHaveLength(3)
    await h.call('DELETE', `/api/v1/videos/${id}`, { as: h.member })
    calls.length = 0
    await expect(fillBeats(h.deps, mia, id, 1)).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toEqual([])
  })
})
