// The action on a server with the phase 3 additions (bead va-mg4i.4.5): the PR's text travels as `context` beside a
// short prompt, the video carries externalRef and its link, lookups use externalRef first (the reference line still
// finds older videos), private is set on create, and an older server gets none of these fields.
import { describe, expect, it } from 'vitest'
import { events, expectLog, makeEnv, PHASE3_FEATURES, runAction, type TestEnv } from './harness/index.js'

const pr = (env: TestEnv) =>
  env.gh.pull({
    number: 123,
    title: 'Webhooks: retry failed deliveries',
    body: 'Adds a Retry button to each failed delivery.\n\nFailed deliveries used to need a support ticket.',
    user: { login: 'dana' },
    commits: [{ sha: 'c1', message: 'feat: retry button' }],
    headSha: 'c1',
    files: ['app/routes/webhooks.tsx'],
  })
const video = async (env: TestEnv, id: string) =>
  env.h.json(await env.h.call('GET', `/api/v1/videos/${id}`, { key: env.key }))

describe('with context and external_ref', () => {
  it('sends the PR as context with a short prompt, sets externalRef and its link, and finds it by externalRef', async () => {
    const env = await makeEnv()
    pr(env)
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(r.status).toBe('ready')
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v).toMatchObject({
      externalRef: 'github:acme/web#pr-123',
      externalUrl: 'https://github.com/acme/web/pull/123',
    })
    const v1 = v.versions[0]
    expect(v1.context).toMatchObject({
      source: 'github_pr',
      label: 'GitHub PR #123',
      url: 'https://github.com/acme/web/pull/123',
    })
    expect(v1.context.text).toContain('Failed deliveries used to need a support ticket.')
    // The prompt stays what a person would read; the reference line is still last for older lookups.
    expect(v1.prompt).not.toContain('support ticket')
    expect(v1.prompt.trimEnd().endsWith('[va-ref github:acme/web#pr-123]')).toBe(true)
    env.gh.state.comments = []
    const again = await runAction(env, { event: events.labeled(env.gh, 123), runId: '2' })
    expect(again.outputs['video-id']).toBe(v.id)
    expectLog(again.logs, { lookup: 'externalRef', video: v.id })
  })

  it('finds a video made before phase 3 by its reference line', async () => {
    const older = await makeEnv({ hide: PHASE3_FEATURES })
    pr(older)
    const first = await runAction(older, { event: events.labeled(older.gh, 123) })
    expect((await video(older, first.outputs['video-id'] ?? '')).externalRef).toBeNull()
    // The same deployment after the upgrade: features on, no marker.
    older.hide = []
    older.gh.state.comments = []
    const r = await runAction(older, { event: events.labeled(older.gh, 123), runId: '2' })
    expect(r.outputs['video-id']).toBe(first.outputs['video-id'])
    expectLog(r.logs, { lookup: 'reference', candidates: 1 })
  })

  it('private is set on create: no PATCH', async () => {
    const env = await makeEnv()
    pr(env)
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { private: 'true' } })
    expect((await video(env, r.outputs['video-id'] ?? '')).private).toBe(true)
    expect(r.logs.some((l) => /api=PATCH path=\/api\/v1\/videos\//.test(l))).toBe(false)
  })

  it('revisions carry the PR context too', async () => {
    const env = await makeEnv()
    pr(env)
    const first = await runAction(env, { event: events.labeled(env.gh, 123) })
    await runAction(env, { event: events.comment(env.gh, 123, '/video revise make it orange'), runId: '2' })
    const v2 = (await video(env, first.outputs['video-id'] ?? '')).versions.find(
      (x: { n: number }) => x.n === 2,
    )
    expect(v2.context).toMatchObject({ label: 'GitHub PR #123' })
  })

  it('a release sends its notes as context', async () => {
    const env = await makeEnv()
    env.gh.release({ tag_name: 'v2.4.0', body: '- Retry failed deliveries' })
    const r = await runAction(env, { event: events.release(env.gh, 'v2.4.0') })
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.externalRef).toBe('github:acme/web@v2.4.0')
    expect(v.versions[0].context).toMatchObject({ source: 'github_release', label: 'GitHub release v2.4.0' })
    expect(v.versions[0].context.text).toContain('- Retry failed deliveries')
  })

  it('the race check still leaves one video when both racers set externalRef', async () => {
    const env = await makeEnv()
    pr(env)
    events.labeled(env.gh, 123)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const atLookup = new Promise<void>((r) => (reached = r))
    const label = runAction(env, {
      event: events.labeled(env.gh, 123),
      runId: '1',
      deps: {
        hook: async (point) => {
          if (point !== 'after-lookup') return
          reached()
          await held
        },
      },
    })
    await atLookup
    const command = await runAction(env, { event: events.comment(env.gh, 123, '/video'), runId: '2' })
    release()
    const l = await label
    const list = await env.h.json(
      await env.h.call('GET', '/api/v1/videos?owner=me&externalRef=github%3Aacme%2Fweb%23pr-123', {
        key: env.key,
      }),
    )
    expect(list.items.map((v: { id: string }) => v.id)).toEqual([command.outputs['video-id']])
    expect(l.outputs['video-id']).toBe(command.outputs['video-id'])
  })
})

describe('on an older server', () => {
  it('sends none of the phase 3 fields', async () => {
    const env = await makeEnv({ hide: PHASE3_FEATURES })
    pr(env)
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { private: 'true' } })
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.externalRef).toBeNull()
    expect(v.versions[0].context).toBeNull()
    expect(v.versions[0].prompt).toContain('support ticket')
    expect(v.private).toBe(true) // through the PATCH
    expect(r.logs.some((l) => /api=PATCH path=\/api\/v1\/videos\//.test(l))).toBe(true)
  })
})
