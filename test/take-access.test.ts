// Who reads a recorded voice-over take (plan 2026-11-02 §1 goal 5, §2.7, §8): canReadTake on every path that can
// expose one, per principal. The uploader and admins always; a Creator who can see a video once the take is used on
// it (a version of it, or the uploader's own draft of it); never Reviewers or Viewers, never through someone else's
// draft, never through a private video the reader can't see. Denials are 404s, so a take's existence doesn't leak.
import { describe, expect, it } from 'vitest'
import { canReadTake } from '../src/domain/takes.js'
import type { EditRow, MediaRefRow } from '../src/domain/types.js'
import type { Store } from '../src/store/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import {
  apiKey,
  harness,
  mcpCall,
  person,
  pgStore,
  png,
  PROMPT,
  readyVideo,
  upload,
  type Harness,
} from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

type Take = 'version' | 'uploaderDraft' | 'otherDraft' | 'unused' | 'private'
type Who = 'uploader' | 'admin' | 'creator' | 'reviewer' | 'viewer'
const TAKES: Take[] = ['version', 'uploaderDraft', 'otherDraft', 'unused', 'private']
const WHO: Who[] = ['uploader', 'admin', 'creator', 'reviewer', 'viewer']

/** The expected answer: may this person read this take? */
const allowed = (who: Who, take: Take) =>
  who === 'uploader' ||
  who === 'admin' ||
  (who === 'creator' && (take === 'version' || take === 'uploaderDraft'))

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

/**
 * Five takes, all Mia's (the uploader): used on a version of a team video, in her own draft of it, in another
 * Creator's draft of it, unused, and used on a version of her private video. Plus one ordinary library item.
 */
async function setup(store: Store) {
  const h = harness({}, { store })
  const as: Record<Who, string> = {
    uploader: h.member,
    admin: h.admin,
    creator: await person(h, 'u_cora', 'creator'),
    reviewer: await person(h, 'u_rita', 'reviewer'),
    viewer: await person(h, 'u_vic', 'viewer'),
  }
  const team = await readyVideo(h)
  const secret = await readyVideo(h)
  expect(
    (await h.call('PATCH', `/api/v1/videos/${secret}`, { as: h.member, body: { private: true } })).status,
  ).toBe(200)
  const now = h.deps.clock.now().toISOString()
  await h.deps.store.insertEdit(draft('edt_mia', team, 'u_member', now))
  await h.deps.store.insertEdit(draft('edt_cora', team, 'u_cora', now))
  const ids = {} as Record<Take, string>
  const shas = {} as Record<Take, string>
  for (const take of TAKES) {
    const bytes = png(100 + TAKES.indexOf(take), 50)
    const m = await h.json<{ id: string }>(await upload(h, h.member, bytes, `filename=take-${take}.png`))
    await h.deps.store.updateMedia(m.id, {
      role: 'narration-take',
      kind: 'audio',
      scopeJobId: take === 'private' ? secret : team,
      caption: 'calm narration take',
    })
    ids[take] = m.id
    shas[take] = (await h.deps.store.getMedia(m.id))?.originalSha256 ?? ''
  }
  const ref = (mediaId: string, ownerKind: MediaRefRow['ownerKind'], ownerId: string, jobId: string) => ({
    mediaId,
    ownerKind,
    ownerId,
    jobId,
    createdAt: now,
  })
  await h.deps.store.insertMediaRefs([
    ref(ids.version, 'version', `${team}#1`, team),
    ref(ids.uploaderDraft, 'draft', 'edt_mia', team),
    ref(ids.otherDraft, 'draft', 'edt_cora', team),
    ref(ids.private, 'version', `${secret}#1`, secret),
    // A frozen render attempt doesn't share a take: only the version it becomes does.
    ref(ids.unused, 'frozen_attempt', 'att_x', team),
  ])
  const library = await h.json<{ id: string }>(await upload(h, h.member, png(320, 200), 'filename=logo.png'))
  return { h, as, ids, shas, library: library.id, team }
}

const listed = async (h: Harness, cookie: string, query = '') =>
  (
    await h.json<{ items: { id: string }[] }>(await h.call('GET', `/api/v1/media${query}`, { as: cookie }))
  ).items.map((m) => m.id)

describe.each(stores)('take access (%s)', (_name, make) => {
  it('GET /media/:id and its signed links, per take and principal', async () => {
    const { h, as, ids, library } = await setup(await make())
    for (const who of WHO) {
      const lib = await h.call('GET', `/api/v1/media/${library}`, { as: as[who] })
      expect(lib.status, `${who} library item`).toBe(200)
      for (const take of TAKES) {
        const res = await h.call('GET', `/api/v1/media/${ids[take]}`, { as: as[who] })
        expect(res.status, `${who} ${take}`).toBe(allowed(who, take) ? 200 : 404)
        if (res.status === 200) expect((await h.json(res)).urls?.file, `${who} ${take}`).toMatch(/^\/media\//)
        else expect((await h.json(res)).error.code).toBe('not_found')
      }
    }
  })

  it('PATCH and DELETE are 404 to anyone who may not read the take', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of ['creator', 'reviewer', 'viewer'] as const)
      for (const take of TAKES) {
        const patch = await h.call('PATCH', `/api/v1/media/${ids[take]}`, {
          as: as[who],
          body: { title: 'mine now' },
        })
        const del = await h.call('DELETE', `/api/v1/media/${ids[take]}`, { as: as[who] })
        // Readers who aren't the uploader keep today's answer: forbidden.
        const expected = allowed(who, take) ? 403 : 404
        expect(patch.status, `${who} ${take}`).toBe(expected)
        expect(del.status, `${who} ${take}`).toBe(expected)
      }
  })

  it('the library list and its search show only your own takes', async () => {
    const { h, as, ids, library } = await setup(await make())
    for (const who of WHO)
      for (const query of ['', '?q=narration', '?kind=audio', '?sort=name']) {
        const got = await listed(h, as[who], query)
        for (const take of TAKES)
          expect(got.includes(ids[take]), `${who} ${take} ${query}`).toBe(who === 'uploader')
        if (query === '' || query === '?sort=name') expect(got, `${who} ${query}`).toContain(library)
      }
  })

  it('music library search never offers a take, even to its uploader', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of WHO) {
      const res = await h.call('GET', '/api/v1/media/openverse/library?q=calm%20narration', { as: as[who] })
      expect(res.status, who).toBe(200)
      const got = (await h.json<{ items: { id: string }[] }>(res)).items.map((m) => m.id)
      for (const take of TAKES) expect(got, `${who} ${take}`).not.toContain(ids[take])
    }
  })

  it("the duplicate check never reveals someone else's take", async () => {
    const { h, as, ids, shas } = await setup(await make())
    const files = TAKES.map((t) => ({ filename: `take-${t}.png`, sha256: shas[t] }))
    for (const who of WHO) {
      const res = await h.call('POST', '/api/v1/media/check', { as: as[who], body: { files } })
      if (who === 'reviewer' || who === 'viewer') {
        expect(res.status, who).toBe(403)
        continue
      }
      const out = (await h.json<{ files: { sameFile: { id: string } | null; sameName: unknown }[] }>(res))
        .files
      TAKES.forEach((take, i) => {
        expect(out[i]?.sameFile?.id ?? null, `${who} ${take}`).toBe(who === 'uploader' ? ids[take] : null)
        expect(out[i]?.sameName ?? null, `${who} ${take}`).toBeNull()
      })
    }
  })

  it('MCP list_media lists only your own takes', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of WHO) {
      const key = await apiKey(h, as[who], `k_${who}`)
      const r = await mcpCall(h, key, 'tools/call', { name: 'list_media', arguments: { query: 'narration' } })
      const got = (r.structuredContent.media as { id: string }[]).map((m) => m.id)
      for (const take of TAKES) expect(got.includes(ids[take]), `${who} ${take}`).toBe(who === 'uploader')
    }
  })

  it('a take is never a library pick: videos, plans and edits refuse it', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of ['uploader', 'admin', 'creator'] as const) {
      const create = await h.call('POST', '/api/v1/videos', {
        as: as[who],
        body: { prompt: PROMPT, mediaIds: [ids.version] },
      })
      expect(create.status, who).toBe(400)
      expect((await h.json(create)).error.message).toBe(
        `Media ${ids.version} isn't a ready item in the library.`,
      )
    }
    const key = await apiKey(h, h.member)
    const r = await mcpCall(h, key, 'tools/call', {
      name: 'create_video',
      arguments: { prompt: PROMPT, media_ids: [ids.unused] },
    })
    expect(r.isError).toBe(true)
  })

  it('a take GC is deleting is gone, even for its uploader', async () => {
    const { h, as, ids } = await setup(await make())
    await h.deps.store.updateMedia(ids.unused, { deletingAt: h.deps.clock.now().toISOString() })
    for (const who of ['uploader', 'admin'] as const)
      expect((await h.call('GET', `/api/v1/media/${ids.unused}`, { as: as[who] })).status).toBe(404)
    expect(await listed(h, h.member)).not.toContain(ids.unused)
  })

  it('upload finalization keeps a take private to its uploader', async () => {
    const { h, as, team } = await setup(await make())
    const bytes = png(800, 600)
    const { createHash } = await import('node:crypto')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const s = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/media/uploads', {
        as: h.member,
        body: { filename: 'take-session.png', size: bytes.byteLength, sha256 },
      }),
    )
    const put = await h.app.fetch(
      new Request(`https://video.example.com/api/v1/media/uploads/${s.id}/parts/0`, {
        method: 'PUT',
        headers: {
          cookie: h.member,
          origin: 'https://video.example.com',
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      }),
      { context: { deploy: { published: true }, waitUntil: () => undefined } },
    )
    expect(put.status).toBe(200)
    // Upload sessions learn the narration role in a later bead; here the pending row gets it before assembly.
    h.deps.platform.onAssemble = async () => undefined
    const done = await h.json<{ mediaId: string }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    await h.deps.store.updateMedia(done.mediaId, { role: 'narration-upload', scopeJobId: team })
    const { assembleUpload } = await import('../src/domain/media-uploads.js')
    expect(await assembleUpload(h.deps, s.id)).toBe('ready')
    expect(await h.deps.store.getMedia(done.mediaId)).toMatchObject({
      role: 'narration-upload',
      status: 'ready',
    })
    expect((await h.call('GET', `/api/v1/media/${done.mediaId}`, { as: h.member })).status).toBe(200)
    for (const who of ['creator', 'reviewer', 'viewer'] as const) {
      expect((await h.call('GET', `/api/v1/media/${done.mediaId}`, { as: as[who] })).status).toBe(404)
      expect((await h.call('GET', `/api/v1/media/uploads/${s.id}`, { as: as[who] })).status).toBe(404)
    }
  })

  it('the predicate itself: a deleted video shares nothing, and a library item always passes', async () => {
    const { h, ids, library, team } = await setup(await make())
    const cora = {
      kind: 'user' as const,
      userId: 'u_cora',
      email: 'u_cora@acme.com',
      name: 'u_cora',
      role: 'creator' as const,
      apiKeyId: null,
    }
    const m = async (id: string) => (await h.deps.store.getMedia(id))!
    expect(await canReadTake(h.deps.store, cora, await m(library))).toBe(true)
    expect(await canReadTake(h.deps.store, cora, await m(ids.version))).toBe(true)
    await h.deps.store.updateJob(team, { deletedAt: h.deps.clock.now().toISOString() })
    expect(await canReadTake(h.deps.store, cora, await m(ids.version))).toBe(false)
    expect(await canReadTake(h.deps.store, cora, await m(ids.uploaderDraft))).toBe(false)
  })
})
