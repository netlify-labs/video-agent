// Publish destinations, phase 2 (docs/plans/2026-11-04-publish-destinations.md §3): the HTTP destination contract v1
// against a fake receiver that verifies signatures with its own implementation of the documented algorithm.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runPublication } from '../src/domain/destinations/run.js'
import { harness, person, pgStore, readyVideo, type Harness } from './helpers.js'

interface Seen {
  event: string
  body: Record<string, any>
  headers: Record<string, string>
}

/** Verifies `t=<unix>,v1=<hex>` = HMAC-SHA256(secret, "<t>." + raw body), within ±300 s, in constant time. */
function verify(secret: string, raw: string, header: string, nowSec: number) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(nowSec - t) > 300) return false
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest()
  const got = Buffer.from(m[2] ?? '', 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

function receiver(
  h: Harness,
  secret: () => string,
  answer: (s: Seen) => { status: number; body?: unknown; retryAfter?: string } | Error,
) {
  const seen: Seen[] = []
  h.deps.http.receiver = ({ body, headers }) => {
    const nowSec = Math.floor(h.deps.clock.now().getTime() / 1000)
    if (!verify(secret(), body, headers['x-video-agent-signature'] ?? '', nowSec))
      return { status: 401, body: '{}' }
    const s = { event: headers['x-video-agent-event'] ?? '', body: JSON.parse(body), headers }
    seen.push(s)
    const a = answer(s)
    if (a instanceof Error) return a
    return {
      status: a.status,
      body: a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body),
      headers: { contentType: 'application/json', retryAfter: a.retryAfter ?? null },
    }
  }
  return seen
}

async function setup(h: Harness, over: object = {}) {
  const res = await h.call('POST', '/api/v1/admin/destinations', {
    as: h.admin,
    body: {
      name: 'Example receiver',
      url: 'https://receiver.example.com/hook',
      optionsSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 40 } } },
      ...over,
    },
  })
  expect(res.status).toBe(201)
  return h.json(res)
}

const publish = (h: Harness, as: string, id: string, body: object) =>
  h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, { as, body })

async function scenario(h: Harness) {
  const id = await readyVideo(h)
  const dest = await setup(h)
  expect(dest.secret).toMatch(/^dsec_/)
  let secret = dest.secret as string
  // Admin only; the secret is never listed again.
  expect((await h.call('GET', '/api/v1/admin/destinations', { as: h.member })).status).toBe(403)
  const listed = await h.json(await h.call('GET', '/api/v1/admin/destinations', { as: h.admin }))
  expect(JSON.stringify(listed)).not.toContain(secret)
  // Bad URLs are refused.
  for (const url of ['http://receiver.example.com', 'https://u:p@receiver.example.com', 'nope'])
    expect(
      (await h.call('POST', '/api/v1/admin/destinations', { as: h.admin, body: { name: 'x', url } })).status,
    ).toBe(400)
  // A bad options form names the path.
  const bad = await h.call('POST', '/api/v1/admin/destinations', {
    as: h.admin,
    body: {
      name: 'x',
      url: 'https://r.example.com',
      optionsSchema: { type: 'object', properties: { a: { type: 'integer' } } },
    },
  })
  expect((await h.json(bad)).error.message).toContain('properties.a.type')

  // Ping: capabilities stored, invalid fields dropped.
  let seen = receiver(
    h,
    () => secret,
    (s) =>
      s.event === 'ping'
        ? {
            status: 200,
            body: {
              capabilities: {
                targets: true,
                targetNoun: 'site',
                instructions: true,
                instructionsHint: 'x'.repeat(201),
                junk: 1,
              },
            },
          }
        : { status: 500 },
  )
  const tested = await h.json(
    await h.call('POST', `/api/v1/admin/destinations/${dest.id}/test`, { as: h.admin }),
  )
  expect(tested).toMatchObject({
    ok: true,
    status: 200,
    capabilities: { targets: true, targetNoun: 'site', instructions: true },
  })
  expect(tested.capabilities.instructionsHint).toBeUndefined()
  expect(seen[0]?.body).toMatchObject({
    contract: 1,
    event: 'ping',
    destination: { id: dest.id, name: 'Example receiver' },
    publisher: null,
  })

  // Targets: generic, validated, the receiver's order.
  seen = receiver(
    h,
    () => secret,
    (s) =>
      s.event === 'targets'
        ? {
            status: 200,
            body: {
              targets: [
                {
                  id: 'site-b',
                  name: 'Beta',
                  description: '2 videos',
                  url: 'https://beta.example.com',
                  metadata: { videos: 2 },
                },
                { id: '', name: 'broken' },
                { id: 'site-a', name: 'Alpha', description: null, url: null, metadata: null },
              ],
            },
          }
        : { status: 500 },
  )
  const targets = await h.json(
    await h.call('GET', `/api/v1/destinations/${dest.id}/targets?videoId=${id}`, { as: h.member }),
  )
  expect(targets).toMatchObject({ dropped: 1, noun: 'site', error: null })
  expect(targets.targets.map((t: { id: string }) => t.id)).toEqual(['site-b', 'site-a'])
  // Only the publisher's id goes out unless an admin turns contact sharing on.
  expect(seen[0]?.body.publisher).toEqual({ id: 'u_member' })
  expect(seen[0]?.body.video).toEqual({ id, title: expect.any(String) })

  // Publish: 200 live, signed, the minimal manifest with working links, the target back verbatim.
  seen = receiver(
    h,
    () => secret,
    (s) =>
      s.event === 'publish'
        ? {
            status: 200,
            body: {
              status: 'live',
              url: 'https://beta.example.com/#v',
              externalId: 'v-1',
              warnings: ['Placed at the end'],
            },
          }
        : { status: 404 },
  )
  const dp = await h.json(
    await publish(h, h.member, id, {
      destination: dest.id,
      options: { name: 'beta' },
      target: targets.targets[0],
      instructions: 'Put it in the hero.',
    }),
  )
  await runPublication(h.deps, dp.id)
  const got = seen.find((s) => s.event === 'publish')?.body ?? {}
  expect(got).toMatchObject({
    contract: 1,
    event: 'publish',
    publication: dp.id,
    operation: `${dp.id}:publish:1`,
    options: { name: 'beta' },
    target: targets.targets[0],
    instructions: 'Put it in the hero.',
    publisher: { id: 'u_member' },
  })
  expect(seen[0]?.headers['x-video-agent-delivery']).toBe(`${dp.id}:publish:1`)
  expect(got.manifest.files.map((f: { kind: string }) => f.kind)).toEqual(['mp4', 'poster', 'captions'])
  expect(got.manifest.files[0].url).toMatch(
    /^https:\/\/video\.example\.com\/files\/vid_\w+\/v1\/video\.mp4\?exp=\d+&sig=/,
  )
  expect(got.manifest.files[0]).toMatchObject({
    contentType: 'video/mp4',
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  expect(JSON.stringify(got)).not.toContain('mia@acme.com')
  expect(got.callback.url).toBe(`https://video.example.com/api/v1/destination-callbacks/${dp.id}`)
  const live = await h.deps.store.getDestinationPublication(dp.id)
  expect(live).toMatchObject({
    status: 'live',
    url: 'https://beta.example.com/#v',
    externalId: 'v-1',
    warnings: ['Placed at the end'],
  })

  // Contact sharing on: name and email go out.
  await h.call('PATCH', `/api/v1/admin/destinations/${dest.id}`, {
    as: h.admin,
    body: { sharePublisherContact: true },
  })
  seen = receiver(
    h,
    () => secret,
    () => ({ status: 200, body: { targets: [] } }),
  )
  await h.call('GET', `/api/v1/destinations/${dest.id}/targets?videoId=${id}`, { as: h.member })
  expect(seen[0]?.body.publisher).toEqual({ id: 'u_member', name: 'Mia Member', email: 'mia@acme.com' })

  // The response table (§3.2), one publication per row.
  const cases: [string, ReturnType<Parameters<typeof receiver>[2]>, string, object?][] = [
    [
      'accepted',
      { status: 202, body: { status: 'accepted', externalId: 'e', message: 'Building it' } },
      'waiting',
      { message: 'Building it', externalId: 'e' },
    ],
    ['429', { status: 429, retryAfter: '20' }, 'running', { error: { code: 'http_429' } }],
    [
      '503',
      { status: 503, body: { error: { message: 'Down for maintenance' } } },
      'running',
      { error: { code: 'http_503', message: 'Down for maintenance' } },
    ],
    [
      '400',
      { status: 400, body: { error: { message: 'Name taken' } } },
      'failed',
      { error: { code: 'http_400', message: 'Name taken' } },
    ],
    ['bad 2xx', { status: 200, body: 'not json' }, 'failed', { error: { code: 'bad_response' } }],
    [
      'http url',
      { status: 200, body: { status: 'live', url: 'http://insecure.example.com' } },
      'failed',
      { error: { code: 'bad_response' } },
    ],
    [
      'redirect',
      new Error('redirects are not followed (HTTP 302)'),
      'failed',
      { error: { code: 'http_3xx' } },
    ],
    ['network', new Error('ECONNRESET'), 'running', { error: { code: 'network' } }],
  ]
  for (const [label, ans, status, extra] of cases) {
    receiver(
      h,
      () => secret,
      () => ans,
    )
    const p = await h.json(
      await publish(h, h.member, id, {
        destination: dest.id,
        target: { id: `t-${label}`, name: label, description: null, url: null, metadata: null },
      }),
    )
    await runPublication(h.deps, p.id)
    expect(await h.deps.store.getDestinationPublication(p.id), label).toMatchObject({ status, ...extra })
  }
  // Retry-After is honoured (capped at an hour) and the retry re-signs with a new t, same operation id.
  const retrying = (await h.deps.store.listDestinationPublications(id)).find((p) => p.target?.id === 't-429')
  expect(Date.parse(retrying?.nextRunAt ?? '') - h.deps.clock.now().getTime()).toBe(20_000)
  h.deps.clock.advance(21_000)
  seen = receiver(
    h,
    () => secret,
    () => ({ status: 200, body: { status: 'live' } }),
  )
  await runPublication(h.deps, retrying?.id ?? '')
  expect(seen[0]?.headers['x-video-agent-delivery']).toBe(`${retrying?.id}:publish:1`)
  expect((await h.deps.store.getDestinationPublication(retrying?.id ?? ''))?.status).toBe('live')

  // Callbacks (§3.3): the accepted one finishes through its callback, with a one-time secret.
  const waiting = (await h.deps.store.listDestinationPublications(id)).find(
    (p) => p.target?.id === 't-accepted',
  )
  const wid = waiting?.id ?? ''
  // Recover the token the way a receiver would: from the request it got.
  seen = receiver(
    h,
    () => secret,
    () => ({ status: 202, body: { status: 'accepted' } }),
  )
  await h.deps.store.updateDestinationPublication(wid, { status: 'queued', leaseUntil: null })
  await runPublication(h.deps, wid)
  const cb = seen[0]?.body.callback as { url: string; token: string }
  const callback = (body: object, tok = cb.token) =>
    h.call('POST', `/api/v1/destination-callbacks/${wid}`, {
      origin: null,
      headers: { authorization: `Bearer ${tok}` },
      body,
    })
  expect((await callback({ operation: `${wid}:publish:1`, status: 'live' }, 'dpc_wrong')).status).toBe(401)
  expect((await callback({ operation: `${wid}:publish:1`, status: 'removed' })).status).toBe(409)
  expect(
    (await callback({ operation: `${wid}:publish:1`, status: 'working', message: 'Copying the video' }))
      .status,
  ).toBe(204)
  expect((await h.deps.store.getDestinationPublication(wid))?.message).toBe('Copying the video')
  // Fresh links while it's active.
  const fresh = await h.call('POST', `/api/v1/destination-callbacks/${wid}/files`, {
    origin: null,
    headers: { authorization: `Bearer ${cb.token}` },
    body: { operation: `${wid}:publish:1` },
  })
  expect(fresh.status).toBe(200)
  expect((await h.json(fresh)).files[0].url).toContain('/files/')
  const done = await callback({
    operation: `${wid}:publish:1`,
    status: 'live',
    url: 'https://site.example.com',
    secretOnce: { label: 'Site password', value: 'hunter2-hunter2' },
  })
  expect(done.status).toBe(204)
  // A duplicate changes nothing.
  expect(
    (await callback({ operation: `${wid}:publish:1`, status: 'live', url: 'https://other.example.com' }))
      .status,
  ).toBe(204)
  const after = await h.deps.store.getDestinationPublication(wid)
  expect(after).toMatchObject({ status: 'live', url: 'https://site.example.com' })
  // The secret: never in the DTO, revealed once, to the publisher only.
  const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
  const entry = v.versions[0].destinations.find((d: { id: string }) => d.id === wid)
  expect(entry).toMatchObject({ hasSecret: true, secretLabel: 'Site password' })
  expect(JSON.stringify(v)).not.toContain('hunter2')
  expect(h.deps.logs.join('\n')).not.toContain('hunter2')
  expect(h.deps.logs.join('\n')).not.toContain(cb.token)
  expect(
    (await h.call('POST', `/api/v1/destination-publications/${wid}/secret`, { as: h.admin })).status,
  ).toBe(404)
  const [r1, r2] = await Promise.all([
    h.call('POST', `/api/v1/destination-publications/${wid}/secret`, { as: h.member }),
    h.call('POST', `/api/v1/destination-publications/${wid}/secret`, { as: h.member }),
  ])
  const statuses = [r1.status, r2.status].sort()
  expect(statuses).toEqual([200, 410])
  const shown = await h.json(r1.status === 200 ? r1 : r2)
  expect(shown).toEqual({ label: 'Site password', value: 'hunter2-hunter2' })
  expect((r1.status === 200 ? r1 : r2).headers.get('cache-control')).toBe('no-store')
  // A replayed callback can't bring it back.
  await callback({
    operation: `${wid}:publish:1`,
    status: 'live',
    secretOnce: { label: 'x', value: 'again-again' },
  })
  expect((await h.deps.store.getDestinationPublication(wid))?.secretOnceEnc).toBeNull()

  // Removal through the receiver: 202 then a removed callback; an old operation's callback is ignored.
  seen = receiver(
    h,
    () => secret,
    (s) => (s.event === 'remove' ? { status: 202, body: { status: 'accepted' } } : { status: 500 }),
  )
  await h.call('DELETE', `/api/v1/destination-publications/${wid}`, { as: h.member })
  await runPublication(h.deps, wid)
  const rem = seen.find((s) => s.event === 'remove')?.body ?? {}
  expect(rem).toMatchObject({
    event: 'remove',
    operation: `${wid}:remove:2`,
    externalId: 'e',
    url: 'https://site.example.com',
  })
  expect(rem.manifest).toBeUndefined()
  expect((await callback({ operation: `${wid}:publish:1`, status: 'failed' })).status).toBe(204) // old: ignored
  expect((await h.deps.store.getDestinationPublication(wid))?.status).toBe('removing')
  const remCb = rem.callback as { token: string }
  expect((await callback({ operation: `${wid}:remove:2`, status: 'removed' }, remCb.token)).status).toBe(204)
  expect((await h.deps.store.getDestinationPublication(wid))?.status).toBe('removed')
  expect((await callback({ operation: `${wid}:remove:2`, status: 'failed' }, remCb.token)).status).toBe(410)
  // Fresh links are refused once it's no longer an active publish.
  expect(
    (
      await h.call('POST', `/api/v1/destination-callbacks/${wid}/files`, {
        origin: null,
        headers: { authorization: `Bearer ${remCb.token}` },
        body: { operation: `${wid}:remove:2` },
      })
    ).status,
  ).toBe(409)

  // A callback that arrives before the worker saved the 202 still wins.
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  let early: { url: string; token: string } | null = null
  h.deps.http.receiver = async ({ body }) => {
    early = JSON.parse(body).callback
    await gate
    return { status: 202, body: JSON.stringify({ status: 'accepted' }) }
  }
  const fast = await h.json(
    await publish(h, h.member, id, {
      destination: dest.id,
      target: { id: 't-fast', name: 'fast', description: null, url: null, metadata: null },
    }),
  )
  const worker = runPublication(h.deps, fast.id)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the receiver above
  while (!early) await new Promise((r) => setTimeout(r, 1))
  const e = early as { token: string }
  expect(
    (
      await h.call('POST', `/api/v1/destination-callbacks/${fast.id}`, {
        origin: null,
        headers: { authorization: `Bearer ${e.token}` },
        body: { operation: `${fast.id}:publish:1`, status: 'live', url: 'https://fast.example.com' },
      })
    ).status,
  ).toBe(204)
  release()
  expect(await worker).toBe('lost_fence')
  expect(await h.deps.store.getDestinationPublication(fast.id)).toMatchObject({
    status: 'live',
    url: 'https://fast.example.com',
  })

  // Rotating the secret: the next request is signed with the new one.
  const rotated = await h.json(
    await h.call('POST', `/api/v1/admin/destinations/${dest.id}/rotate`, { as: h.admin }),
  )
  expect(rotated.secret).not.toBe(secret)
  secret = rotated.secret
  receiver(
    h,
    () => secret,
    () => ({ status: 200, body: {} }),
  )
  expect(
    (await h.json(await h.call('POST', `/api/v1/admin/destinations/${dest.id}/test`, { as: h.admin }))).ok,
  ).toBe(true)

  // A reviewer can't publish; a private video can't go out.
  const reviewer = await person(h, 'u_rev', 'reviewer')
  expect((await publish(h, reviewer, id, { destination: dest.id })).status).toBe(403)
  // Disable hides it; delete is refused while publications are active; remove-everywhere clears them.
  await h.call('PATCH', `/api/v1/admin/destinations/${dest.id}`, { as: h.admin, body: { enabled: false } })
  expect(
    (await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))).items.map(
      (d: { id: string }) => d.id,
    ),
  ).toEqual(['share_page'])
  expect((await h.call('DELETE', `/api/v1/admin/destinations/${dest.id}`, { as: h.admin })).status).toBe(409)
  const removing = await h.json(
    await h.call('POST', `/api/v1/admin/destinations/${dest.id}/remove-all`, { as: h.admin }),
  )
  expect(removing.removing).toBeGreaterThan(0)
}

describe('HTTP destinations: contract v1', () => {
  it('memory', async () => {
    await scenario(harness())
  })
  it('Postgres', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
  it('a slow or failing targets call still lets you publish to a new one', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const dest = await setup(h)
    h.deps.http.receiver = () => new Error('timeout')
    await h.deps.store.updateDestination(dest.id, { capabilities: { targets: true } })
    const t = await h.json(
      await h.call('GET', `/api/v1/destinations/${dest.id}/targets?videoId=${id}`, { as: h.member }),
    )
    expect(t).toMatchObject({ targets: [], error: 'Could not reach the destination.' })
    expect((await publish(h, h.member, id, { destination: dest.id })).status).toBe(200)
  })
})
