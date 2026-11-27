// Marking RUNNER_API_TOKEN as a secret from the production build (the deploy button saves it as a plain variable).
import { describe, expect, it } from 'vitest'
import { ensureTokenSecret, ensureTokenSecretAtBuild } from '../../scripts/lib/token-secret.js'

const TOKEN = 'nfp_secret_token'
const VAR = 'https://api.netlify.com/api/v1/accounts/acct_1/env/RUNNER_API_TOKEN?site_id=site_1'

/** A fake Netlify API: the project, its RUNNER_API_TOKEN variable and the update, recording every call. */
function fakeApi(o: { site?: number; read: number; secret?: boolean; put?: number; throws?: Error }) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    })
    if (o.throws) throw o.throws
    if (url.endsWith('/sites/site_1'))
      return new Response(JSON.stringify({ account_id: 'acct_1' }), { status: o.site ?? 200 })
    if (method === 'PUT') return new Response('{}', { status: o.put ?? 200 })
    return new Response(
      JSON.stringify({
        key: 'RUNNER_API_TOKEN',
        is_secret: o.secret ?? false,
        scopes: ['builds', 'functions'],
      }),
      { status: o.read },
    )
  }) as typeof fetch
  return { calls, fetchImpl }
}

const build = { CONTEXT: 'production', RUNNER_API_TOKEN: TOKEN, SITE_ID: 'site_1' }

describe('ensureTokenSecret', () => {
  it('replaces a plain token with a secret one that keeps its value', async () => {
    const { calls, fetchImpl } = fakeApi({ read: 200 })
    expect(await ensureTokenSecret(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'marked' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.netlify.com/api/v1/sites/site_1',
      `GET ${VAR}`,
      `PUT ${VAR}`,
    ])
    expect(calls[2]?.body).toEqual({
      key: 'RUNNER_API_TOKEN',
      scopes: ['builds', 'functions'],
      is_secret: true,
      values: ['production', 'deploy-preview', 'branch-deploy'].map((context) => ({ value: TOKEN, context })),
    })
  })

  it('changes nothing when the token is already a secret', async () => {
    const { calls, fetchImpl } = fakeApi({ read: 200, secret: true })
    expect(await ensureTokenSecret(TOKEN, 'site_1', fetchImpl)).toEqual({ state: 'already' })
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it("leaves a token that isn't the project's own variable", async () => {
    const { calls, fetchImpl } = fakeApi({ read: 404 })
    expect(await ensureTokenSecret(TOKEN, 'site_1', fetchImpl)).toEqual({
      state: 'skipped',
      reason: 'not_project_variable',
    })
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it('reports what the API refused', async () => {
    expect(await ensureTokenSecret(TOKEN, 'site_1', fakeApi({ site: 401, read: 200 }).fetchImpl)).toEqual({
      state: 'failed',
      status: 401,
    })
    expect(await ensureTokenSecret(TOKEN, 'site_1', fakeApi({ read: 200, put: 403 }).fetchImpl)).toEqual({
      state: 'failed',
      status: 403,
    })
  })
})

describe('ensureTokenSecretAtBuild', () => {
  it('marks the token on a production build', async () => {
    expect(await ensureTokenSecretAtBuild(build, fakeApi({ read: 200 }).fetchImpl)).toEqual({
      state: 'marked',
    })
  })

  it.each([
    ['a deploy preview', { ...build, CONTEXT: 'deploy-preview' }, 'not_production'],
    ['an agent run', { ...build, NETLIFY_AGENT_RUNNER_ID: 'r1' }, 'agent_run'],
    ['no token', { ...build, RUNNER_API_TOKEN: '' }, 'no_token'],
    ['no project id', { ...build, SITE_ID: undefined }, 'no_site'],
  ])('skips %s without calling the API', async (_name, env, reason) => {
    const { calls, fetchImpl } = fakeApi({ read: 200 })
    expect(await ensureTokenSecretAtBuild(env, fetchImpl)).toEqual({ state: 'skipped', reason })
    expect(calls).toEqual([])
  })

  it('never throws, and never puts the token in its result', async () => {
    const { fetchImpl } = fakeApi({ read: 200, throws: new TypeError(`fetch failed for ${TOKEN}`) })
    const result = await ensureTokenSecretAtBuild(build, fetchImpl)
    expect(result).toEqual({ state: 'failed', status: null, error: 'TypeError' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})
