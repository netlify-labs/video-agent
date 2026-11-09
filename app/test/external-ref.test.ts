// externalRef, externalUrl and private on create and remix, and GET /api/v1/videos?externalRef= (github-action plan
// §6.2, §6.3; bead va-mg4i.4.3). The GitHub Action finds a PR's video by its ref; private from the first moment closes
// the create-then-PATCH window. Not unique: the client takes the oldest match.
import { describe, expect, it } from 'vitest'
import { accessKey } from '../server/domain/files.js'
import { apiKey, harness, mcpCall, person, pgStore, PROMPT, readyVideo, type Harness } from './helpers.js'

const REF = 'github:acme/web#pr-123'
const URL_ = 'https://github.com/acme/web/pull/123'

const create = (h: Harness, as: string, body: Record<string, unknown>) =>
  h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT, ...body } })
const list = async (h: Harness, as: string, query: string) =>
  (await h.json(await h.call('GET', `/api/v1/videos?${query}`, { as }))).items as {
    id: string
    externalRef: string | null
    externalUrl: string | null
    private: boolean
  }[]
const byRef = (ref: string, more = '') => `externalRef=${encodeURIComponent(ref)}${more}`

describe.each([
  ['memory', () => harness()],
  ['postgres', async () => harness({}, { store: await pgStore() })],
])('external refs (%s)', (_name, make) => {
  it('a video made with externalRef, externalUrl and private is private at once and found by the filter', async () => {
    const h = await make()
    const res = await create(h, h.member, { externalRef: REF, externalUrl: URL_, private: true })
    expect(res.status).toBe(202)
    const video = await h.json(res)
    expect(video).toMatchObject({ externalRef: REF, externalUrl: URL_, private: true })
    // The access mirror the file routes read is private from the first moment, not after a PATCH.
    const mirror = await h.deps.blobs.get('internal', accessKey(video.id))
    expect(JSON.parse(new TextDecoder().decode(mirror ?? new Uint8Array()))).toMatchObject({
      private: true,
    })
    expect((await list(h, h.member, byRef(REF, '&owner=me'))).map((v) => v.id)).toEqual([video.id])
    // Someone else can't see a private video, so the filter doesn't return it to them.
    const carl = await person(h, 'u_carl', 'creator')
    expect(await list(h, carl, byRef(REF))).toEqual([])
    // Videos made without one say null.
    const plain = await h.json(await create(h, h.member, {}))
    expect(plain).toMatchObject({ externalRef: null, externalUrl: null, private: false })
  })

  it('is not unique: both come back, newest first, so the oldest is last; owner=me leaves others out', async () => {
    const h = await make()
    const first = await h.json(await create(h, h.member, { externalRef: REF }))
    h.deps.clock.advance(1000)
    const second = await h.json(await create(h, h.member, { externalRef: REF }))
    const carl = await person(h, 'u_carl', 'creator')
    const theirs = await h.json(await create(h, carl, { externalRef: REF }))
    await create(h, h.member, { externalRef: 'github:acme/web#pr-12' })

    expect((await list(h, h.member, byRef(REF, '&owner=me'))).map((v) => v.id)).toEqual([second.id, first.id])
    expect((await list(h, h.member, byRef(REF))).map((v) => v.id).sort()).toEqual(
      [first.id, second.id, theirs.id].sort(),
    )
    // Exact match: pr-12 is not a prefix match for pr-123, nor the other way round.
    expect(await list(h, h.member, byRef('github:acme/web#pr-1'))).toEqual([])
    // It combines with q and the cursor like any other filter.
    expect((await list(h, h.member, byRef(REF, '&owner=me&limit=1'))).map((v) => v.id)).toEqual([second.id])
  })
})

describe('external refs: validation and permissions', () => {
  it('refuses bad refs and non-https URLs with 400', async () => {
    const h = harness()
    for (const externalRef of [
      'github: acme/web#pr-1',
      'GitHub:acme/web#pr-1',
      'noscheme',
      `github:${'x'.repeat(194)}`,
    ])
      expect((await create(h, h.member, { externalRef })).status, externalRef).toBe(400)
    expect((await create(h, h.member, { externalRef: REF, externalUrl: 'http://github.com/a' })).status).toBe(
      400,
    )
    expect(
      (
        await h.call('GET', `/api/v1/videos?externalRef=${encodeURIComponent('has space:x')}`, {
          as: h.member,
        })
      ).status,
    ).toBe(400)
    // 200 characters is fine.
    expect((await create(h, h.member, { externalRef: `github:${'x'.repeat(193)}` })).status).toBe(202)
  })

  it('private needs permission to make videos private: a reviewer is refused', async () => {
    const h = harness()
    const rita = await person(h, 'u_rita', 'reviewer')
    const key = await apiKey(h, rita)
    const res = await h.call('POST', '/api/v1/videos', { key, body: { prompt: PROMPT, private: true } })
    expect(res.status).toBe(403)
  })

  it('a remix takes externalRef, externalUrl and private', async () => {
    const h = harness()
    const source = await readyVideo(h)
    const res = await h.call('POST', `/api/v1/videos/${source}/remix`, {
      as: h.member,
      body: {
        prompt: 'Same video, for payments.',
        externalRef: 'github:acme/web@v2.4.0',
        externalUrl: URL_,
        private: true,
      },
    })
    expect(res.status).toBe(202)
    const remix = await h.json(res)
    expect(remix).toMatchObject({ externalRef: 'github:acme/web@v2.4.0', externalUrl: URL_, private: true })
    expect((await list(h, h.member, byRef('github:acme/web@v2.4.0'))).map((v) => v.id)).toEqual([remix.id])
    // The source keeps its own (none).
    expect(
      (await h.json(await h.call('GET', `/api/v1/videos/${source}`, { as: h.member }))).externalRef,
    ).toBeNull()
  })

  it('MCP create_video and list_videos take external_ref; create_video takes private', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const made = (await mcpCall(h, key, 'tools/call', {
      name: 'create_video',
      arguments: { prompt: PROMPT, external_ref: REF, private: true },
    })) as { structuredContent?: { video_id?: string }; content: { text: string }[] }
    const id = made.structuredContent?.video_id ?? JSON.parse(made.content[0]?.text ?? '{}').video_id
    const video = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(video).toMatchObject({ externalRef: REF, private: true })
    const found = (await mcpCall(h, key, 'tools/call', {
      name: 'list_videos',
      arguments: { external_ref: REF },
    })) as { content: { text: string }[] }
    expect(JSON.parse(found.content[0]?.text ?? '{}').videos).toEqual([
      expect.objectContaining({ video_id: id, external_ref: REF }),
    ])
  })
})
