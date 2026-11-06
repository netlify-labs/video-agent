// The look input (bead va-mg4i.3.8): sent on create, revise and remix when the server lists looks; ignored with a
// warning when it doesn't; an unknown look fails the step with the API's message.
import { describe, expect, it } from 'vitest'
import { events, makeEnv, runAction, type TestEnv } from './harness/index.js'

const pr = (env: TestEnv) =>
  env.gh.pull({ number: 123, title: 'Webhooks: retry', user: { login: 'dana' }, files: ['app/a.tsx'] })
const video = async (env: TestEnv, id: string) =>
  env.h.json(await env.h.call('GET', `/api/v1/videos/${id}`, { key: env.key }))

describe('look', () => {
  it('is sent on create and on a revision when the server lists looks', async () => {
    const env = await makeEnv()
    pr(env)
    const look = env.h.deps.looks.catalog()[0]?.id ?? 'clean'
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { look } })
    expect(r.failed).toBeNull()
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.versions[0].look?.id).toBe(look)
    expect(r.logs.join('\n')).toContain('looks')
  })

  it('an unknown look fails the step with the server’s message', async () => {
    const env = await makeEnv()
    pr(env)
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { look: 'no-such-look' } })
    expect(r.status).toBe('error')
    expect(r.failed).toMatch(/unknown_look/)
  })

  it('is ignored with a warning when the server has no looks', async () => {
    const env = await makeEnv({ hide: ['looks'] })
    pr(env)
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { look: 'clean' } })
    expect(r.failed).toBeNull()
    expect(r.warnings.join('\n')).toContain('this server has no looks; look ignored')
    expect((await video(env, r.outputs['video-id'] ?? '')).versions[0].look).toBeNull()
  })
})
