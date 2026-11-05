// /docs/destinations stays true (docs/plans/2026-11-04-publish-destinations.md §3): the documented signature vectors
// match the server's signer, and the documented example receiver works end to end against the app.
import { describe, expect, it } from 'vitest'
import { createReceiver, verifySignature } from '../examples/destination-receiver/receiver.js'
import { runPublication } from '../src/domain/destinations/run.js'
import { webhookSignature } from '../src/lib/crypto.js'
import { DESTINATION_VECTORS } from '../ui/src/lib/destination-vectors.js'
import { harness, readyVideo } from './helpers.js'

describe('destination contract docs', () => {
  it('the test vectors are what the server signs', () => {
    for (const v of DESTINATION_VECTORS) {
      expect(webhookSignature(v.secret, v.body, v.t)).toBe(v.signature)
      expect(verifySignature(v.secret, v.body, v.signature, v.t + 100)).toBe(true)
      expect(verifySignature(v.secret, v.body, v.signature, v.t + 301)).toBe(false)
      expect(verifySignature(v.secret, `${v.body} `, v.signature, v.t)).toBe(false)
    }
  })

  it('the example receiver: ping, publish (202 + callbacks), targets, add to an existing page, remove', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const dest = await h.json(
      await h.call('POST', '/api/v1/admin/destinations', {
        as: h.admin,
        body: { name: 'Pages', url: 'https://pages.example.com/hook' },
      }),
    )
    const rx = createReceiver({
      secret: dest.secret,
      now: () => Math.floor(h.deps.clock.now().getTime() / 1000),
      post: async (url, token, body) =>
        (
          await h.call('POST', new URL(url).pathname, {
            origin: null,
            headers: { authorization: `Bearer ${token}` },
            body,
          })
        ).status,
    })
    h.deps.http.receiver = async ({ body, headers }) => {
      const r = await rx.handle(body, headers)
      return { status: r.status, body: JSON.stringify(r.body) }
    }
    const test = await h.json(
      await h.call('POST', `/api/v1/admin/destinations/${dest.id}/test`, { as: h.admin }),
    )
    expect(test.capabilities).toMatchObject({ targets: true, targetNoun: 'page', instructions: true })

    const publish = (as: string, body: object) =>
      h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, {
        as,
        body: { destination: dest.id, ...body },
      })
    const first = await h.json(await publish(h.member, { options: {}, instructions: 'Hero section' }))
    await runPublication(h.deps, first.id)
    expect((await h.deps.store.getDestinationPublication(first.id))?.status).toBe('waiting')
    await rx.settle()
    const live = await h.deps.store.getDestinationPublication(first.id)
    expect(live).toMatchObject({ status: 'live', url: `https://pages.example.com/page-1#${first.id}` })

    // The page is now one of this publisher's targets, and the next video can go there.
    const targets = await h.json(
      await h.call('GET', `/api/v1/destinations/${dest.id}/targets?videoId=${id}`, { as: h.member }),
    )
    expect(targets.targets).toEqual([
      {
        id: 'page-1',
        name: expect.any(String),
        description: '1 video(s)',
        url: 'https://pages.example.com/page-1',
        metadata: { videos: 1 },
      },
    ])
    // Another publisher (the admin here) can't add to it, even with its exact target.
    const theirs = await h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, {
      as: h.admin,
      body: { destination: dest.id, target: targets.targets[0] },
    })
    expect(theirs.status).toBe(200)
    const theirsRow = await h.json(theirs)
    await runPublication(h.deps, theirsRow.id)
    expect(await h.deps.store.getDestinationPublication(theirsRow.id)).toMatchObject({
      status: 'failed',
      error: { code: 'http_403' },
    })

    // Remove: the receiver drops it from the page.
    await h.call('DELETE', `/api/v1/destination-publications/${first.id}`, { as: h.member })
    await runPublication(h.deps, first.id)
    expect((await h.deps.store.getDestinationPublication(first.id))?.status).toBe('removed')
    expect(rx.pages.get('page-1')?.videos).toEqual([])
  })
})
