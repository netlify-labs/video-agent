// Screen recording visibility (screen-recording plan §9, §14 Q3; va-rsk5.2.5): a raw recording is readable by its
// uploader and admins; by another Creator only once a version of a video they can see lists it in version_media;
// never by Reviewers or Viewers. Private videos keep it private and deleting the video makes it private again. It's
// never a plain library pick. Checked through GET (and its signed links), the library list and MCP list_media, on the
// memory store and PGlite; one JSON line per (principal, state, route, status).
import { describe, expect, it } from 'vitest'
import type { VersionMediaRow } from '../server/domain/types.js'
import { createMemoryStore } from '../server/store/memory.js'
import type { Store } from '../server/store/types.js'
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

type State = 'unused' | 'team' | 'private' | 'deleted'
type Who = 'uploader' | 'admin' | 'creator' | 'reviewer' | 'viewer'
const STATES: State[] = ['unused', 'team', 'private', 'deleted']
const WHO: Who[] = ['uploader', 'admin', 'creator', 'reviewer', 'viewer']

/** The expected answer: may this person read a recording in this state? */
const allowed = (who: Who, state: State) =>
  who === 'uploader' || who === 'admin' || (who === 'creator' && state === 'team')

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

const vm = (jobId: string, mediaId: string): VersionMediaRow => ({
  jobId,
  versionN: 1,
  mediaId,
  position: 0,
  kind: 'video',
  key: `${mediaId}/original.mp4`,
  sha256: 'a'.repeat(64),
  filename: `${mediaId}.mp4`,
  caption: null,
})

/** Four recordings, all Mia's: unused, in a team video, in her private video, in a video that's then deleted. */
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
  const gone = await readyVideo(h)
  expect(
    (await h.call('PATCH', `/api/v1/videos/${secret}`, { as: h.member, body: { private: true } })).status,
  ).toBe(200)
  const ids = {} as Record<State, string>
  for (const state of STATES) {
    const m = await h.json<{ id: string }>(
      await upload(h, h.member, png(200 + STATES.indexOf(state), 50), `filename=screen-${state}.png`),
    )
    await h.deps.store.updateMedia(m.id, { role: 'screen-recording', kind: 'video', caption: 'screen take' })
    ids[state] = m.id
  }
  await h.deps.store.insertVersionMedia([vm(team, ids.team), vm(secret, ids.private), vm(gone, ids.deleted)])
  expect((await h.call('DELETE', `/api/v1/videos/${gone}`, { as: h.member })).status).toBeLessThan(300)
  return { h, as, ids, team }
}

const listed = async (h: Harness, cookie: string) =>
  (
    await h.json<{ items: { id: string }[] }>(await h.call('GET', '/api/v1/media?limit=100', { as: cookie }))
  ).items.map((m) => m.id)

describe.each(stores)('screen recording visibility (%s)', (store, make) => {
  it('GET /media/:id, its signed links and the library list, per state and principal', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of WHO) {
      const list = await listed(h, as[who])
      for (const state of STATES) {
        const res = await h.call('GET', `/api/v1/media/${ids[state]}`, { as: as[who] })
        log({ store, who, state, route: 'GET /media/:id', status: res.status })
        expect(res.status, `${who} ${state}`).toBe(allowed(who, state) ? 200 : 404)
        if (res.status === 200)
          expect((await h.json(res)).urls?.file, `${who} ${state}`).toMatch(/^\/media\//)
        else expect((await h.json(res)).error.code).toBe('not_found')
        log({ store, who, state, route: 'GET /media', listed: list.includes(ids[state]) })
        expect(list.includes(ids[state]), `${who} ${state} listed`).toBe(allowed(who, state))
      }
    }
  })

  it('MCP list_media follows the same rule', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of WHO) {
      const key = await apiKey(h, as[who], `k_${who}`)
      const r = await mcpCall(h, key, 'tools/call', { name: 'list_media', arguments: { query: 'screen' } })
      const got = ((r.structuredContent?.media ?? []) as { id: string }[]).map((m) => m.id)
      for (const state of STATES) {
        log({ store, who, state, route: 'mcp list_media', listed: got.includes(ids[state]) })
        expect(got.includes(ids[state]), `${who} ${state}`).toBe(allowed(who, state))
      }
    }
  })

  it('is never a plain library pick, even for its uploader', async () => {
    const { h, as, ids } = await setup(await make())
    for (const who of ['uploader', 'admin', 'creator'] as const) {
      const res = await h.call('POST', '/api/v1/videos', {
        as: as[who],
        body: { prompt: PROMPT, mediaIds: [ids.team] },
      })
      log({ store, who, state: 'team', route: 'POST /videos mediaIds', status: res.status })
      expect(res.status, who).toBe(400)
      expect((await h.json(res)).error.message).toBe(`Media ${ids.team} isn't a ready item in the library.`)
    }
  })

  it('jobsUsingMedia lists versions of undeleted videos only', async () => {
    const s = await make()
    const { h, ids, team } = await setup(s)
    expect(await h.deps.store.jobsUsingMedia(ids.unused)).toEqual([])
    expect(await h.deps.store.jobsUsingMedia(ids.deleted)).toEqual([])
    await h.deps.store.insertVersionMedia([{ ...vm(team, ids.team), versionN: 2 }])
    expect(await h.deps.store.jobsUsingMedia(ids.team)).toEqual([
      { jobId: team, versionN: 1 },
      { jobId: team, versionN: 2 },
    ])
  })
})
