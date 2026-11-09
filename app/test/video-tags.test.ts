// Tags on videos: set on create or with PATCH, shown to everyone who sees the video, and filtered in the list with
// ?tag= and ?withoutTag=. GET /api/v1/video-tags lists the tags in use with their counts.
import { describe, expect, it } from 'vitest'
import { harness, person, pgStore, PROMPT, type Harness } from './helpers.js'

const create = (h: Harness, as: string, body: Record<string, unknown> = {}) =>
  h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT, ...body } })
const ids = async (h: Harness, as: string, query = '') =>
  ((await h.json(await h.call('GET', `/api/v1/videos?${query}`, { as }))).items as { id: string }[]).map(
    (v) => v.id,
  )
const tagsInUse = async (h: Harness, as: string) =>
  (await h.json(await h.call('GET', '/api/v1/video-tags', { as }))).items as { tag: string; count: number }[]

describe.each([
  ['memory', () => harness()],
  ['postgres', async () => harness({}, { store: await pgStore() })],
])('video tags (%s)', (_name, make) => {
  it('are set on create (sorted), default to none, and filter the list both ways', async () => {
    const h = await make()
    const demo = await h.json(await create(h, h.member, { tags: ['demo', 'april'] }))
    expect(demo.tags).toEqual(['april', 'demo'])
    h.deps.clock.advance(1000)
    const plain = await h.json(await create(h, h.member))
    expect(plain.tags).toEqual([])
    expect(await ids(h, h.member, 'tag=demo')).toEqual([demo.id])
    expect(await ids(h, h.member, 'withoutTag=demo')).toEqual([plain.id])
    expect(await ids(h, h.member, 'tag=nope')).toEqual([])
    expect(await ids(h, h.member)).toEqual([plain.id, demo.id])
  })

  it('PATCH replaces the whole list; [] clears it; the tags in use are counted', async () => {
    const h = await make()
    const a = await h.json(await create(h, h.member, { tags: ['demo'] }))
    const b = await h.json(await create(h, h.member))
    const patched = await h.call('PATCH', `/api/v1/videos/${b.id}`, {
      as: h.member,
      body: { tags: ['launch', 'demo'] },
    })
    expect(patched.status).toBe(200)
    expect((await h.json(patched)).tags).toEqual(['demo', 'launch'])
    expect(await tagsInUse(h, h.member)).toEqual([
      { tag: 'demo', count: 2 },
      { tag: 'launch', count: 1 },
    ])
    const cleared = await h.call('PATCH', `/api/v1/videos/${a.id}`, { as: h.member, body: { tags: [] } })
    expect((await h.json(cleared)).tags).toEqual([])
    expect(await tagsInUse(h, h.member)).toEqual([
      { tag: 'demo', count: 1 },
      { tag: 'launch', count: 1 },
    ])
  })

  it("refuses bad tags, and doesn't count a private video's tags for someone who can't see it", async () => {
    const h = await make()
    for (const tags of [
      ['Demo'],
      ['two words'],
      ['demo', 'demo'],
      Array.from({ length: 11 }, (_, i) => `t${i}`),
    ])
      expect((await create(h, h.member, { tags })).status).toBe(400)
    await create(h, h.member, { tags: ['secret'], private: true })
    await create(h, h.member, { tags: ['demo'] })
    const carl = await person(h, 'u_carl', 'creator')
    expect(await tagsInUse(h, carl)).toEqual([{ tag: 'demo', count: 1 }])
    expect(await ids(h, carl, 'tag=secret')).toEqual([])
  })

  it('only someone who may rename the video may retag it', async () => {
    const h = await make()
    const v = await h.json(await create(h, h.member, { tags: ['demo'] }))
    const carl = await person(h, 'u_carl', 'creator')
    const res = await h.call('PATCH', `/api/v1/videos/${v.id}`, { as: carl, body: { tags: [] } })
    expect(res.status).toBe(403)
  })
})
