// Publishing and unpublishing move the video's validator, so the UI's refetch gets the new publication, not a 304.
import { describe, expect, it } from 'vitest'
import { harness, readyVideo } from './helpers.js'

describe('publish etag', () => {
  it('publish and unpublish change the video ETag', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const get = (etag = '') =>
      h.call('GET', `/api/v1/videos/${id}`, { as: h.member, headers: { 'if-none-match': etag } })

    const before = await get()
    expect(
      (await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member, body: {} })).status,
    ).toBe(200)
    const published = await get(before.headers.get('etag') ?? '')
    expect(published.status).toBe(200)
    const dto = await h.json(published)
    expect(dto.versions[0].publications.some((p: { urls: unknown }) => p.urls)).toBe(true)

    expect((await h.call('DELETE', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member })).status).toBe(
      204,
    )
    const unpublished = await get(published.headers.get('etag') ?? '')
    expect(unpublished.status).toBe(200)
    const after = await h.json(unpublished)
    expect(after.versions[0].publications.every((p: { urls: unknown }) => !p.urls)).toBe(true)
  })

  it('a publication made without moving job.version still changes the ETag', async () => {
    // Videos published before publishing moved job.version: the live publication alone must change the validator.
    const h = harness()
    const id = await readyVideo(h, h.member)
    const before = await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })
    await h.deps.store.insertPublication({
      slug: 'oldpub1234',
      jobId: id,
      versionN: 1,
      publishedBy: h.member,
      publishedAt: new Date().toISOString(),
      unpublishedAt: null,
      showTranscript: false,
    })
    const after = await h.call('GET', `/api/v1/videos/${id}`, {
      as: h.member,
      headers: { 'if-none-match': before.headers.get('etag') ?? '' },
    })
    expect(after.status).toBe(200)
  })
})
