// npm run setup:openverse: registering an Openverse app and storing its credentials on the site.
import { describe, expect, it } from 'vitest'
import type { Site } from '../scripts/lib/netlify-setup.js'
import { defaultAppName, OPENVERSE_REGISTER, registerOpenverse } from '../scripts/lib/openverse-setup.js'

const site: Site = {
  id: 'site_1',
  name: 'my-video-agent',
  account_id: 'acct_1',
  account_slug: 'acme',
  ssl_url: 'https://my-video-agent.netlify.app',
  admin_url: 'https://app.netlify.com/sites/my-video-agent',
}

/** A fake Openverse register endpoint and Netlify env API that record every call. */
function fakes(register: { status: number; body: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    calls.push({ url, method: init?.method ?? 'GET', body })
    if (url === OPENVERSE_REGISTER)
      return new Response(JSON.stringify(register.body), { status: register.status })
    return init?.method === 'POST' ? new Response('[]', { status: 201 }) : new Response(null, { status: 204 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('setup:openverse', () => {
  it('registers the app and sets the client id and the secret (marked secret) on the site', async () => {
    const { calls, fetchImpl } = fakes({
      status: 201,
      body: {
        client_id: 'cid_123',
        client_secret: 'shh_456',
        name: 'Video Agent (my-video-agent.netlify.app)',
        msg: 'ok',
      },
    })
    const out = await registerOpenverse({
      netlifyToken: 'nf',
      site,
      name: defaultAppName(site),
      description: 'd',
      email: 'me@acme.com',
      fetchImpl,
    })
    expect(out.name).toBe('Video Agent (my-video-agent.netlify.app)')
    expect(calls[0]).toMatchObject({
      url: OPENVERSE_REGISTER,
      method: 'POST',
      body: { name: 'Video Agent (my-video-agent.netlify.app)', description: 'd', email: 'me@acme.com' },
    })
    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/env?site_id=site_1'))
    expect(posts.map((c) => (c.body as { key: string }[])[0])).toEqual([
      { key: 'OPENVERSE_CLIENT_ID', scopes: ['functions'], values: [{ value: 'cid_123', context: 'all' }] },
      {
        key: 'OPENVERSE_CLIENT_SECRET',
        scopes: ['functions'],
        is_secret: true,
        values: ['production', 'deploy-preview', 'branch-deploy'].map((context) => ({
          value: 'shh_456',
          context,
        })),
      },
    ])
    // Site-scoped, never team-wide.
    expect(calls.filter((c) => c.url.includes('/env')).every((c) => c.url.includes('site_id=site_1'))).toBe(
      true,
    )
  })

  it('names the deployment in the app name, since names are unique across Openverse', () => {
    expect(defaultAppName(site)).toBe('Video Agent (my-video-agent.netlify.app)')
  })

  it('explains a taken name and other refusals, and sets nothing', async () => {
    const taken = fakes({ status: 400, body: { name: ['application with this name already exists.'] } })
    await expect(
      registerOpenverse({
        netlifyToken: 'nf',
        site,
        name: 'Taken',
        description: 'd',
        email: 'me@acme.com',
        fetchImpl: taken.fetchImpl,
      }),
    ).rejects.toThrow(/already exists\. Pass --name/)
    expect(taken.calls.some((c) => c.url.includes('/env'))).toBe(false)

    const busy = fakes({ status: 429, body: { detail: 'slow down' } })
    await expect(
      registerOpenverse({
        netlifyToken: 'nf',
        site,
        name: 'X',
        description: 'd',
        email: 'me@acme.com',
        fetchImpl: busy.fetchImpl,
      }),
    ).rejects.toThrow(/rate limiting/)
  })

  it('refuses an invalid email before calling Openverse', async () => {
    const f = fakes({ status: 201, body: {} })
    await expect(
      registerOpenverse({
        netlifyToken: 'nf',
        site,
        name: 'X',
        description: 'd',
        email: 'nope',
        fetchImpl: f.fetchImpl,
      }),
    ).rejects.toThrow(/valid email/)
    expect(f.calls).toEqual([])
  })
})
