// Turning on Netlify Identity for a new project: the setup script and the production build.
import { describe, expect, it } from 'vitest'
import { ensureIdentity, ensureIdentityAtBuild } from '../../scripts/lib/identity-setup.js'

const TOKEN = 'nfp_secret_token'

/** A fake Netlify API for one project's Identity, recording every call. */
function fakeApi(o: { read: number; create?: number; throws?: Error }) {
  const calls: { url: string; method: string; auth: string | null }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method,
      auth: new Headers(init?.headers).get('authorization'),
    })
    if (o.throws) throw o.throws
    const status = method === 'GET' ? o.read : (o.create ?? 201)
    return new Response(status === 404 ? '{"code":404,"message":"Not Found"}' : '{}', { status })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const build = { CONTEXT: 'production', RUNNER_API_TOKEN: TOKEN, SITE_ID: 'site_1' }

describe('ensureIdentity', () => {
  it('enables Identity when the project has none', async () => {
    const { calls, fetchImpl } = fakeApi({ read: 404 })
    expect(await ensureIdentity(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'enabled' })
    expect(calls).toEqual([
      { url: 'https://api.netlify.com/api/v1/sites/site_1/identity', method: 'GET', auth: `Bearer ${TOKEN}` },
      {
        url: 'https://api.netlify.com/api/v1/sites/site_1/identity',
        method: 'POST',
        auth: `Bearer ${TOKEN}`,
      },
    ])
  })

  it('changes nothing when Identity is already on', async () => {
    const { calls, fetchImpl } = fakeApi({ read: 200 })
    expect(await ensureIdentity(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'already' })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it("doesn't try to enable it when the token can't read the project", async () => {
    const { calls, fetchImpl } = fakeApi({ read: 401 })
    expect(await ensureIdentity(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'failed', status: 401 })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('reports a refused enable', async () => {
    const { fetchImpl } = fakeApi({ read: 404, create: 403 })
    expect(await ensureIdentity(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'failed', status: 403 })
  })
})

describe('ensureIdentityAtBuild', () => {
  it('enables Identity on a production build with the token', async () => {
    const { fetchImpl } = fakeApi({ read: 404 })
    expect(await ensureIdentityAtBuild(build, fetchImpl)).toEqual({ state: 'enabled' })
  })

  it.each([
    ['a deploy preview', { ...build, CONTEXT: 'deploy-preview' }, 'not_production'],
    ['a local build', { ...build, CONTEXT: undefined }, 'not_production'],
    ['an agent run', { ...build, NETLIFY_AGENT_RUNNER_ID: 'r1' }, 'agent_run'],
    ['Sign in with Netlify', { ...build, AUTH_PROVIDER: ' Netlify ' }, 'other_sign_in'],
    ['no token', { ...build, RUNNER_API_TOKEN: '' }, 'no_token'],
    ['no project id', { ...build, SITE_ID: undefined }, 'no_site'],
  ])('skips %s without calling the API', async (_name, env, reason) => {
    const { calls, fetchImpl } = fakeApi({ read: 404 })
    expect(await ensureIdentityAtBuild(env, fetchImpl)).toEqual({ state: 'skipped', reason })
    expect(calls).toEqual([])
  })

  it('never throws, and never puts the token in its result', async () => {
    const { fetchImpl } = fakeApi({ read: 404, throws: new TypeError(`fetch failed for Bearer ${TOKEN}`) })
    const result = await ensureIdentityAtBuild(build, fetchImpl)
    expect(result).toEqual({ state: 'failed', status: null, error: 'TypeError' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})
