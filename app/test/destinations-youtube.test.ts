// The YouTube destination (docs/plans/2026-11-04-publish-destinations.md §4) against a fake Google: connecting a
// channel (PKCE, state bound to the browser and the person), the resumable upload with an interrupted chunk and an
// expired session, processing, captions without duplicates, the thumbnail 403 as a warning, quota waits, removal
// through the pinned connection, and reconnecting after invalid_grant.
import { describe, expect, it } from 'vitest'
import { runPublication } from '../server/domain/destinations/run.js'
import { YOUTUBE_SCOPE } from '../server/domain/destinations/google.js'
import { harness, readyVideo, type Harness } from './helpers.js'

const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' }
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=up1'

function fakeGoogle(h: Harness) {
  const g = {
    revoked: false,
    received: 0,
    total: 0,
    dropFirstChunk: false,
    expireSession: false,
    processing: ['processing', 'succeeded'] as string[],
    captions: [] as { name: string }[],
    thumbnail: 403,
    quota: false,
    privacy: [] as string[],
    created: 0,
    meta: null as Record<string, any> | null,
    tokenBodies: [] as string[],
  }
  h.deps.outbound.handler = async (u, init) => {
    const method = init.method ?? 'GET'
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const body = (init.body as string)
      g.tokenBodies.push(body)
      if (body.includes('grant_type=authorization_code'))
        return json({
          access_token: 'at1',
          refresh_token: 'rt-secret-123',
          scope: YOUTUBE_SCOPE,
          expires_in: 3600,
        })
      return g.revoked
        ? json({ error: 'invalid_grant' }, 400)
        : json({ access_token: 'at2', expires_in: 3600 })
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json({})
    if (u.pathname === '/youtube/v3/channels')
      return json({ items: [{ id: 'UC123', snippet: { title: 'Mia’s channel' } }] })
    if (u.pathname === '/upload/youtube/v3/videos' && method === 'POST') {
      if (g.quota) return json({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'Quota' } }, 403)
      g.created++
      g.meta = JSON.parse((init.body as string))
      g.total = Number(new Headers(init.headers).get('x-upload-content-length'))
      g.received = 0
      return new Response('', { status: 200, headers: { location: SESSION } })
    }
    if (u.href === SESSION && method === 'PUT') {
      const range = new Headers(init.headers).get('content-range') ?? ''
      if (range.startsWith('bytes */')) {
        if (g.expireSession) {
          g.expireSession = false
          return new Response('', { status: 404 })
        }
        return new Response('', {
          status: 308,
          ...(g.received ? { headers: { range: `bytes=0-${g.received - 1}` } } : {}),
        })
      }
      if (g.dropFirstChunk) {
        g.dropFirstChunk = false
        throw new Error('socket hang up')
      }
      const len = (init.body as Uint8Array).byteLength
      g.received += len
      return g.received >= g.total
        ? json({ id: 'yt-vid-1' }, 201)
        : new Response('', { status: 308, headers: { range: `bytes=0-${g.received - 1}` } })
    }
    if (u.pathname === '/youtube/v3/videos' && method === 'GET') {
      const st = g.processing.shift() ?? 'succeeded'
      return json({
        items: [
          {
            processingDetails: { processingStatus: st },
            status: { uploadStatus: st === 'succeeded' ? 'processed' : 'uploaded' },
          },
        ],
      })
    }
    if (u.pathname === '/youtube/v3/videos' && method === 'PUT') {
      g.privacy.push(JSON.parse((init.body as string)).status.privacyStatus)
      return json({})
    }
    if (u.pathname === '/youtube/v3/captions') return json({ items: g.captions.map((c) => ({ snippet: c })) })
    if (u.pathname === '/upload/youtube/v3/captions') {
      g.captions.push({ name: 'Video Agent' })
      return json({ id: 'cap1' })
    }
    if (u.pathname === '/upload/youtube/v3/thumbnails/set') return json({}, g.thumbnail)
    return new Response('', { status: 404 })
  }
  return g
}

async function connect(h: Harness) {
  const start = await h.call('GET', '/auth/google/start', { as: h.member })
  expect(start.status).toBe(302)
  const to = new URL(start.headers.get('location') ?? '')
  expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(to.searchParams.get('scope')).toBe(YOUTUBE_SCOPE)
  expect(to.searchParams.get('code_challenge_method')).toBe('S256')
  expect(to.searchParams.get('access_type')).toBe('offline')
  const cookie = /va_google_oauth=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1] ?? ''
  const state = to.searchParams.get('state') ?? ''
  return { cookie, state }
}

async function setup() {
  const h = harness(ENV)
  const g = fakeGoogle(h)
  const id = await readyVideo(h)
  // Not offered until an admin turns it on.
  expect(
    (await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))).items.map(
      (d: { id: string }) => d.id,
    ),
  ).toEqual(['share_page'])
  await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { youtubeEnabled: true } })
  const listed = await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))
  expect(listed.items[1]).toMatchObject({
    id: 'youtube',
    ready: false,
    reason: expect.stringContaining('Connect YouTube'),
  })
  const { cookie, state } = await connect(h)
  const cb = await h.call('GET', `/auth/google/callback?state=${state}&code=c1`, {
    as: `${h.member}; va_google_oauth=${cookie}`,
  })
  expect(cb.status).toBe(302)
  expect(cb.headers.get('location')).toContain('youtube=connected')
  expect(g.tokenBodies[0]).toContain('code_verifier=')
  return { h, g, id }
}

const publish = (h: Harness, id: string, options: object = { title: 'Launch' }) =>
  h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, {
    as: h.member,
    body: { destination: 'youtube', options },
  })

async function drive(h: Harness, pubId: string, n = 12) {
  for (let i = 0; i < n; i++) {
    const p = await h.deps.store.getDestinationPublication(pubId)
    if (!p || ['live', 'failed', 'removed'].includes(p.status)) return p
    await h.deps.store.updateDestinationPublication(pubId, { nextRunAt: h.deps.clock.now().toISOString() })
    await runPublication(h.deps, pubId)
  }
  return h.deps.store.getDestinationPublication(pubId)
}

describe('YouTube destination', () => {
  it('connects a channel: tokens encrypted, the state bound to the browser and the person', async () => {
    const { h } = await setup()
    const conns = await h.json(await h.call('GET', '/api/v1/me/connections', { as: h.member }))
    expect(conns.items).toEqual([
      expect.objectContaining({
        kind: 'youtube',
        account: 'Mia’s channel',
        accountId: 'UC123',
        status: 'ok',
      }),
    ])
    const row = await h.deps.store.getUserConnection('u_member', 'youtube')
    expect(row?.tokenEnc).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain('rt-secret-123')
    expect(h.deps.logs.join('\n')).not.toContain('rt-secret-123')
    // A replayed or foreign callback fails: no cookie, a wrong state, or another person's session.
    const { cookie, state } = await connect(h)
    expect(
      (await h.call('GET', `/auth/google/callback?state=${state}&code=c2`, { as: h.member })).headers.get(
        'location',
      ),
    ).toContain('youtube=expired')
    expect(
      (
        await h.call('GET', `/auth/google/callback?state=nope&code=c2`, {
          as: `${h.member}; va_google_oauth=${cookie}`,
        })
      ).headers.get('location'),
    ).toContain('youtube=expired')
    expect(
      (
        await h.call('GET', `/auth/google/callback?state=${state}&code=c2`, {
          as: `${h.admin}; va_google_oauth=${cookie}`,
        })
      ).headers.get('location'),
    ).toContain('youtube=expired')
  })

  it('publishes: resumable upload (interrupted, probed, resumed), processing, captions once, thumbnail warning, live', async () => {
    const { h, g, id } = await setup()
    g.dropFirstChunk = true
    const dp = await h.json(
      await publish(h, id, { title: 'Ship faster', description: 'The launch.', privacy: 'unlisted' }),
    )
    expect(dp).toMatchObject({ kind: 'youtube', status: 'queued' })
    const done = await drive(h, dp.id)
    expect(done).toMatchObject({ status: 'live', url: 'https://youtu.be/yt-vid-1', externalId: 'yt-vid-1' })
    expect(done?.warnings).toEqual([expect.stringContaining('verified YouTube channel')])
    expect(g.meta).toMatchObject({
      snippet: { title: 'Ship faster' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    })
    expect(g.meta?.snippet.description.startsWith('The launch.')).toBe(true)
    expect(g.created).toBe(1)
    expect(g.captions).toHaveLength(1)
    // The session URL is never logged.
    expect(h.deps.logs.join('\n')).not.toContain('upload_id=up1')
  })

  it('an expired session with no video starts over; options are checked before anything starts', async () => {
    const { h, g, id } = await setup()
    expect((await publish(h, id, { title: 'Bad <title>' })).status).toBe(400)
    expect((await publish(h, id, { title: 'x', description: 'é'.repeat(2600) })).status).toBe(400)
    g.dropFirstChunk = true
    g.expireSession = true
    const dp = await h.json(await publish(h, id))
    const done = await drive(h, dp.id)
    expect(done?.status).toBe('live')
    expect(g.created).toBe(2)
  })

  it('quota: waits for the reset (past the usual cap, deadline moved), then continues', async () => {
    const { h, g, id } = await setup()
    g.quota = true
    const dp = await h.json(await publish(h, id))
    await runPublication(h.deps, dp.id)
    const p = await h.deps.store.getDestinationPublication(dp.id)
    expect(p).toMatchObject({ status: 'running', error: { code: 'quota' } })
    const wait = Date.parse(p?.nextRunAt ?? '') - h.deps.clock.now().getTime()
    expect(wait).toBeGreaterThan(60_000)
    expect(Date.parse(p?.deadlineAt ?? '')).toBeGreaterThan(Date.parse(p?.nextRunAt ?? ''))
    g.quota = false
    expect((await drive(h, dp.id))?.status).toBe('live')
  })

  it('processing rejected → failed with the reason', async () => {
    const { h, g, id } = await setup()
    g.processing = ['failed']
    const dp = await h.json(await publish(h, id))
    expect(await drive(h, dp.id)).toMatchObject({ status: 'failed', error: { code: 'youtube_rejected' } })
  })

  it('removal makes it private through the pinned connection; a revoked grant asks to reconnect', async () => {
    const { h, g, id } = await setup()
    const dp = await h.json(await publish(h, id))
    await drive(h, dp.id)
    await h.call('DELETE', `/api/v1/destination-publications/${dp.id}`, { as: h.admin })
    expect((await drive(h, dp.id))?.status).toBe('removed')
    expect(g.privacy).toEqual(['private'])

    const dp2 = await h.json(await publish(h, id, { title: 'Again' }))
    await drive(h, dp2.id)
    g.revoked = true
    await h.call('DELETE', `/api/v1/destination-publications/${dp2.id}`, { as: h.member })
    await runPublication(h.deps, dp2.id)
    expect(await h.deps.store.getDestinationPublication(dp2.id)).toMatchObject({
      status: 'removing',
      message: 'Reconnect YouTube to finish removing it.',
    })
    expect((await h.deps.store.getUserConnection('u_member', 'youtube'))?.status).toBe('reconnect')
    const listed = await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))
    expect(listed.items.find((d: { id: string }) => d.id === 'youtube')).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Reconnect'),
    })
    // Reconnecting the same channel keeps the connection, so the removal finishes.
    g.revoked = false
    const { cookie, state } = await connect(h)
    await h.call('GET', `/auth/google/callback?state=${state}&code=c3`, {
      as: `${h.member}; va_google_oauth=${cookie}`,
    })
    expect((await drive(h, dp2.id))?.status).toBe('removed')
    // Disconnect revokes at Google.
    const conns = await h.json(await h.call('GET', '/api/v1/me/connections', { as: h.member }))
    expect(
      (await h.call('DELETE', `/api/v1/me/connections/${conns.items[0].id}`, { as: h.member })).status,
    ).toBe(204)
    expect(h.deps.outbound.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(
      true,
    )
  })

  it('without the Google env, there is no YouTube and no connect route', async () => {
    const h = harness()
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { youtubeEnabled: true } })
    expect(
      (await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))).items.map(
        (d: { id: string }) => d.id,
      ),
    ).toEqual(['share_page'])
    expect((await h.call('GET', '/auth/google/start', { as: h.member })).status).toBe(404)
  })
})
