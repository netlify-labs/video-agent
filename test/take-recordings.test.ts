// A video's recordings and the library's Recordings filter (plan 2026-11-02 §2.3, §6.1 draft expiry): GET
// /api/v1/videos/:id/recordings lists the takes made for or used on a video that the caller may read (canReadTake),
// with where each is used and how long it's kept; never someone else's unused take, never to a Reviewer. GET
// /api/v1/media?recordings=only|exclude splits your own takes from the rest of the library.
import { describe, expect, it } from 'vitest'
import type { EditRow, MediaRefRow } from '../src/domain/types.js'
import type { Store } from '../src/store/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import { harness, person, pgStore, png, readyVideo, upload, type Harness } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const draft = (id: string, jobId: string, authorId: string, at: string): EditRow => ({
  id,
  jobId,
  baseN: 1,
  authorId,
  rev: 0,
  ops: [],
  bundleSha256: null,
  renderedN: null,
  createdAt: at,
  updatedAt: at,
  expiresAt: '2099-01-01T00:00:00.000Z',
})

type Take = 'used' | 'miaDraft' | 'coraDraft' | 'unused' | 'coraUnused' | 'elsewhere'

interface Recording {
  id: string
  title: string | null
  durationSec: number | null
  createdAt: string
  recording: {
    role: string
    videoId: string | null
    usedIn: (
      { kind: 'version'; videoId: string; n: number } | { kind: 'draft'; videoId: string; draftId: string }
    )[]
    retainUntil: string | null
  } | null
}

/**
 * On one team video: Mia's (the uploader's) takes used on v1, in her own draft, in Cora's draft, and unused, plus
 * Cora's own unused take; and one of Mia's takes made for another video. Plus one ordinary library item.
 */
async function setup(store: Store) {
  const h = harness({}, { store })
  const cora = await person(h, 'u_cora', 'creator')
  const rita = await person(h, 'u_rita', 'reviewer')
  const team = await readyVideo(h)
  const other = await readyVideo(h)
  const now = h.deps.clock.now().toISOString()
  await h.deps.store.insertEdit(draft('edt_mia', team, 'u_member', now))
  await h.deps.store.insertEdit(draft('edt_cora', team, 'u_cora', now))
  const ids = {} as Record<Take, string>
  const takes: Take[] = ['used', 'miaDraft', 'coraDraft', 'unused', 'coraUnused', 'elsewhere']
  for (const [i, take] of takes.entries()) {
    const as = take === 'coraUnused' ? cora : h.member
    const m = await h.json<{ id: string }>(await upload(h, as, png(100 + i, 50), `filename=take-${take}.png`))
    await h.deps.store.updateMedia(m.id, {
      role: i % 2 ? 'narration-upload' : 'narration-take',
      kind: 'audio',
      scopeJobId: take === 'elsewhere' ? other : team,
      title: `Take ${take}`,
      // Newest first: each take a minute after the one before.
      createdAt: new Date(Date.parse(now) + i * 60_000).toISOString(),
    })
    ids[take] = m.id
  }
  const ref = (mediaId: string, ownerKind: MediaRefRow['ownerKind'], ownerId: string, jobId: string) => ({
    mediaId,
    ownerKind,
    ownerId,
    jobId,
    createdAt: now,
  })
  await h.deps.store.insertMediaRefs([
    ref(ids.used, 'version', `${team}#1`, team),
    ref(ids.miaDraft, 'draft', 'edt_mia', team),
    ref(ids.coraDraft, 'draft', 'edt_cora', team),
    // Made for the other video, but placed on this one's v1 too.
    ref(ids.elsewhere, 'version', `${team}#1`, team),
  ])
  const library = await h.json<{ id: string }>(await upload(h, h.member, png(320, 200), 'filename=logo.png'))
  return { h, cora, rita, team, other, ids, library: library.id }
}

const recordings = async (h: Harness, as: string, videoId: string) => {
  const res = await h.call('GET', `/api/v1/videos/${videoId}/recordings`, { as })
  expect(res.status).toBe(200)
  return (await h.json<{ items: Recording[] }>(res)).items
}

describe.each(stores)("a video's recordings (%s)", (_name, make) => {
  it('the uploader sees all of their own for the video, newest first, with where each is used', async () => {
    const { h, team, other, ids } = await setup(await make())
    const items = await recordings(h, h.member, team)
    expect(items.map((m) => m.id)).toEqual([ids.elsewhere, ids.unused, ids.coraDraft, ids.miaDraft, ids.used])
    const by = new Map(items.map((m) => [m.id, m.recording]))
    expect(by.get(ids.used)).toEqual({
      role: 'narration-take',
      videoId: team,
      usedIn: [{ kind: 'version', videoId: team, n: 1 }],
      retainUntil: null,
    })
    expect(by.get(ids.miaDraft)?.usedIn).toEqual([{ kind: 'draft', videoId: team, draftId: 'edt_mia' }])
    expect(by.get(ids.miaDraft)?.role).toBe('narration-upload')
    // Cora's draft holds it, so it's kept, but her draft isn't Mia's to see.
    expect(by.get(ids.coraDraft)).toMatchObject({ usedIn: [], retainUntil: null })
    // Unused: kept 30 days from when it was made.
    const unused = items.find((m) => m.id === ids.unused)
    expect(unused?.recording?.usedIn).toEqual([])
    expect(Date.parse(unused?.recording?.retainUntil ?? '') - Date.parse(unused?.createdAt ?? '')).toBe(
      30 * 24 * 3600_000,
    )
    expect(unused).toMatchObject({ title: 'Take unused' })
    expect(by.get(ids.elsewhere)?.videoId).toBe(other)
    // Cora's unused take is never Mia's to see.
    expect(items.map((m) => m.id)).not.toContain(ids.coraUnused)
  })

  it('a Creator sees the ones used on the video and their own, never anyone else’s unused take', async () => {
    const { h, cora, team, ids } = await setup(await make())
    const items = await recordings(h, cora, team)
    expect(items.map((m) => m.id)).toEqual([ids.elsewhere, ids.coraUnused, ids.miaDraft, ids.used])
    const by = new Map(items.map((m) => [m.id, m.recording]))
    expect(by.get(ids.used)?.usedIn).toEqual([{ kind: 'version', videoId: team, n: 1 }])
    // Shared through the uploader's draft, which isn't Cora's.
    expect(by.get(ids.miaDraft)?.usedIn).toEqual([])
    expect(by.get(ids.coraUnused)?.usedIn).toEqual([])
    for (const m of items)
      expect((await h.call('GET', `/api/v1/media/${m.id}`, { as: cora })).status).toBe(200)
    expect((await h.call('GET', `/api/v1/media/${ids.unused}`, { as: cora })).status).toBe(404)
  })

  it('a Reviewer sees none, and an admin sees them all', async () => {
    const { h, rita, team, ids } = await setup(await make())
    expect(await recordings(h, rita, team)).toEqual([])
    const all = (await recordings(h, h.admin, team)).map((m) => m.id)
    for (const take of ['used', 'miaDraft', 'coraDraft', 'unused', 'coraUnused', 'elsewhere'] as const)
      expect(all).toContain(ids[take])
  })

  it('a deleted or GC-tombstoned take leaves the list, and a private video is not found', async () => {
    const { h, cora, team, ids } = await setup(await make())
    expect((await h.call('DELETE', `/api/v1/media/${ids.unused}`, { as: h.member })).status).toBe(204)
    await h.deps.store.updateMedia(ids.miaDraft, { deletingAt: h.deps.clock.now().toISOString() })
    const left = (await recordings(h, h.member, team)).map((m) => m.id)
    expect(left).not.toContain(ids.unused)
    expect(left).not.toContain(ids.miaDraft)
    expect(
      (await h.call('PATCH', `/api/v1/videos/${team}`, { as: h.member, body: { private: true } })).status,
    ).toBe(200)
    const hidden = await h.call('GET', `/api/v1/videos/${team}/recordings`, { as: cora })
    expect(hidden.status).toBe(404)
    expect((await h.call('GET', '/api/v1/videos/job_nope/recordings', { as: h.member })).status).toBe(404)
  })

  it('the library lists your recordings only with the Recordings filter, or leaves them out', async () => {
    const { h, cora, ids, library } = await setup(await make())
    const listed = async (as: string, query: string) =>
      (await h.json<{ items: Recording[] }>(await h.call('GET', `/api/v1/media${query}`, { as }))).items.map(
        (m) => m.id,
      )
    const mine = [ids.used, ids.miaDraft, ids.coraDraft, ids.unused, ids.elsewhere]
    const only = await listed(h.member, '?recordings=only')
    expect([...only].sort()).toEqual([...mine].sort())
    expect(await listed(h.member, '?recordings=exclude')).toEqual([library])
    // The default keeps today's answer: your own recordings with the rest.
    expect(await listed(h.member, '')).toEqual(expect.arrayContaining([...mine, library]))
    expect(await listed(cora, '?recordings=only')).toEqual([ids.coraUnused])
    const res = await h.call('GET', '/api/v1/media?recordings=only&q=unused', { as: h.member })
    const items = (await h.json<{ items: Recording[] }>(res)).items
    expect(items.map((m) => m.id)).toEqual([ids.unused])
    expect(items[0]?.recording?.role).toBe('narration-upload')
    const lib = await h.json<Recording>(await h.call('GET', `/api/v1/media/${library}`, { as: h.member }))
    expect(lib.recording).toBeNull()
  })
})
