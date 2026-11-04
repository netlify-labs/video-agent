// Files on comments: a comment (or a note in a block) carries ready library media; the list returns them with signed
// links; incorporating the comment adds them to the revision's media and names them in the agent's feedback.
import { describe, expect, it } from 'vitest'
import { harness, person, pgStore, png, PROMPT, upload, type Harness } from './helpers.js'

const comment = (h: Harness, as: string, id: string, body: object) =>
  h.call('POST', `/api/v1/videos/${id}/comments`, { as, body: { versionN: 1, ...body } })

async function scenario(h: Harness) {
  const rita = await person(h, 'u_rita', 'reviewer')
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const id = v.id as string
  const logo = await h.json<{ id: string }>(await upload(h, h.member, png(64, 64), 'filename=anthropic.png'))
  const shot = await h.json<{ id: string }>(await upload(h, h.member, png(320, 180), 'filename=shot.png'))

  // A comment with two files; the list returns them in order, with signed links.
  const res = await comment(h, rita, id, {
    body: 'Use this logo, like the screenshot',
    mediaIds: [logo.id, shot.id],
  })
  expect(res.status).toBe(201)
  const made = await h.json(res)
  expect(made.attachments.map((a: { id: string }) => a.id)).toEqual([logo.id, shot.id])
  expect(made.attachments[0]).toMatchObject({ kind: 'image', filename: 'anthropic.png' })
  expect(made.attachments[0].url).toMatch(new RegExp(`^/media/${logo.id}/file\\?exp=\\d+&sig=`))
  const plain = await h.json(await comment(h, rita, id, { body: 'Tighter ending' }))
  expect(plain.attachments).toEqual([])

  // In a block too.
  const block = await h.json(
    await h.call('POST', `/api/v1/videos/${id}/comments/batch`, {
      as: rita,
      body: {
        versionN: 1,
        notes: [{ body: 'Here', timeSec: 0.5, mediaIds: [shot.id] }, { body: 'And here' }],
      },
    }),
  )
  expect(block.items[0].attachments.map((a: { id: string }) => a.id)).toEqual([shot.id])

  // Unknown media and too many files are refused.
  expect((await comment(h, rita, id, { body: 'x', mediaIds: ['med_nope'] })).status).toBe(400)
  expect((await comment(h, rita, id, { body: 'x', mediaIds: ['a', 'b', 'c', 'd', 'e', 'f'] })).status).toBe(
    400,
  )

  // Incorporating: the files join the revision's media and the agent's feedback names them.
  const queued = await h.call('POST', `/api/v1/videos/${id}/versions`, {
    as: h.member,
    body: { prompt: 'Incorporate the feedback below.', fromVersion: 1, commentIds: [made.id, plain.id] },
  })
  expect(queued.status).toBe(202)
  const media = await h.deps.store.listVersionMedia(id, 2)
  expect(media.map((m) => m.mediaId)).toEqual([logo.id, shot.id])
  const snaps = await h.deps.store.listVersionComments(id, 2)
  expect(snaps.map((s) => s.files ?? null)).toEqual([
    [`assets/media/${logo.id}.png`, `assets/media/${shot.id}.png`],
    null,
  ])
  await h.drive(2)
  const prompt = h.deps.runner.starts[1]?.prompt ?? ''
  expect(prompt).toContain(
    `"files":["video/assets/media/${logo.id}.png","video/assets/media/${shot.id}.png"]`,
  )
  expect(prompt).toContain('files are what the commenter attached')

  // A file deleted from the library drops out of the comment.
  await h.call('DELETE', `/api/v1/media/${shot.id}`, { as: h.member })
  const list = await h.json(await h.call('GET', `/api/v1/videos/${id}/comments`, { as: h.member }))
  const again = list.items.find((c: { id: string }) => c.id === made.id)
  expect(again.attachments.map((a: { id: string }) => a.id)).toEqual([logo.id])
}

describe('files on comments', () => {
  it('attach, list, incorporate (memory)', async () => {
    await scenario(harness())
  })
  it('attach, list, incorporate (Postgres)', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})
