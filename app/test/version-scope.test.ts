// versions.scope and versions.beats (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.2, §5): both stores
// keep them, null round-trips as null, and beats can be filled on an existing version.
import { describe, expect, it } from 'vitest'
import type { VersionRow } from '../server/domain/types.js'
import { createMemoryStore } from '../server/store/memory.js'
import type { Store } from '../server/store/types.js'
import { pgStore } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const row = (n: number, extra: Partial<VersionRow> = {}): VersionRow => ({
  jobId: 'vid_scope',
  n,
  prompt: 'Make the headline say Ship on Friday.',
  authorId: 'u_1',
  apiKeyId: null,
  targetDurationSec: 12,
  parentN: n > 1 ? n - 1 : null,
  webhookUrl: null,
  status: 'queued',
  createdAt: '2026-11-05T00:00:00.000Z',
  ...extra,
})

const BEATS = [
  { id: 'intro', label: 'Opening', start: 0, duration: 3 },
  { id: 'features', label: null, start: 3, duration: 3.85 },
]

describe.each(stores)('versions.scope and versions.beats (%s)', (_name, make) => {
  it('stores both and reads them back', async () => {
    const store = await make()
    await store.insertVersion(row(1, { status: 'ready', contract: 1, beats: BEATS }))
    await store.insertVersion(row(2, { scope: { beats: ['features'] } }))
    expect((await store.getVersion('vid_scope', 1))?.beats).toEqual(BEATS)
    expect((await store.getVersion('vid_scope', 2))?.scope).toEqual({ beats: ['features'] })
    const listed = await store.listVersions('vid_scope')
    expect(listed.map((v) => [v.n, v.scope ?? null, v.beats ?? null])).toEqual([
      [2, { beats: ['features'] }, null],
      [1, null, BEATS],
    ])
  })

  it('fills beats on an existing version and keeps null as null', async () => {
    const store = await make()
    await store.insertVersion(row(1, { status: 'ready', scope: null, beats: null }))
    const before = await store.getVersion('vid_scope', 1)
    expect(before?.beats ?? null).toBeNull()
    expect(before?.scope ?? null).toBeNull()
    await store.updateVersion('vid_scope', 1, { beats: BEATS })
    expect((await store.getVersion('vid_scope', 1))?.beats).toEqual(BEATS)
    await store.updateVersion('vid_scope', 1, { beats: null })
    expect((await store.getVersion('vid_scope', 1))?.beats ?? null).toBeNull()
  })
})
