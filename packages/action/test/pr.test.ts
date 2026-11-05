// The PR flows end to end against the real app (beads va-mg4i.2.7-2.10, 2.14, 2.15): a label makes one video and one
// comment, re-runs and new runs find it, failures and timeouts say so, budgets stop before spending.
import { describe, expect, it } from 'vitest'
import { events, expectLog, makeEnv, outcomes, runAction, type TestEnv } from './harness/index.js'

const VIDEOS = 'POST /api/v1/videos'

async function setup(store: 'memory' | 'pglite' = 'memory') {
  const env = await makeEnv({ store })
  env.gh.pull({
    number: 123,
    title: 'Webhooks: retry failed deliveries from the list',
    body: '<!-- template -->\nAdds a **Retry** button to each failed delivery.\n\nFailed deliveries used to need a support ticket.',
    user: { login: 'dana' },
    commits: [{ sha: 'a1', message: 'feat(webhooks): retry button' }],
    files: ['app/routes/webhooks.tsx', 'app/components/WebhookList.tsx', 'package-lock.json'],
  })
  return env
}

/** How many videos the CI account has. */
const videoCount = async (env: TestEnv) =>
  (await env.h.json(await env.h.call('GET', '/api/v1/videos?owner=me&limit=50', { key: env.key }))).items
    .length as number

describe.each(['memory', 'pglite'] as const)('a labelled PR (%s)', (store) => {
  it('makes one video, follows it to ready and edits one comment', async () => {
    const env = await setup(store)
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(r.failed).toBeNull()
    expect(r.status).toBe('ready')
    expect(r.outputs).toMatchObject({ status: 'ready', created: 'true', version: '1', credits: '42' })
    expect(r.outputs['video-id']).toMatch(/^vid_/)
    expect(r.outputs['web-url']).toBe(`https://video.example.com/videos/${r.outputs['video-id']}`)
    expect(r.outputs.prompt).toContain('[va-ref github:acme/web#pr-123]')
    expect(r.outputs.prompt).not.toContain('template')
    const comments = env.gh.commentsOn(123)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toMatch(
      /^<!-- video-agent:v1 \{"videoId":"vid_[^"]+","headSha":"[^"]+","made":1\} -->\n\*\*Ready:\*\*/,
    )
    expect(r.outputs['comment-id']).toBe(String(comments[0]?.id))
    // One create, then an edit for running and one for ready: state changes only.
    expect(env.gh.count('POST /repos/{o}/{r}/issues/{n}/comments')).toBe(1)
    expect(env.gh.count('PATCH /repos/{o}/{r}/issues/comments/{id}')).toBeLessThanOrEqual(2)
    expectLog(r.logs, { decision: 'create', reason: 'label', pr: 123 })
    expectLog(r.logs, { lookup: 'none', candidates: 0 })
    expectLog(r.logs, { host: 'video.example.com', event: 'pull_request' })
    expect(r.logs.join('\n')).not.toContain(env.key)
    expect(r.masked).toContain(env.key)
    expect(r.summary).toContain('### Video Agent: ready')
    expect(await videoCount(env)).toBe(1)
  })

  it('a re-run of the same workflow run makes no second video', async () => {
    const env = await setup(store)
    const first = await runAction(env, { event: events.labeled(env.gh, 123), runId: '42' })
    env.gh.state.comments = [] // even with the comment gone
    const again = await runAction(env, { event: events.labeled(env.gh, 123), runId: '42' })
    expect(again.outputs['video-id']).toBe(first.outputs['video-id'])
    expect(again.outputs.created).toBe('false')
    expect(await videoCount(env)).toBe(1)
  })
})

describe('finding the PR’s video', () => {
  it('a new run after the description changed finds it (marker), with no 409 and no spend', async () => {
    const env = await setup()
    const first = await runAction(env, { event: events.labeled(env.gh, 123), runId: '1' })
    ;(env.gh.state.pulls.get(123) as { body: string }).body = 'A completely different description now.'
    const second = await runAction(env, { event: events.labeled(env.gh, 123), runId: '2' })
    expect(second.failed).toBeNull()
    expect(second.outputs).toMatchObject({
      'video-id': first.outputs['video-id'],
      created: 'false',
      status: 'ready',
    })
    expectLog(second.logs, { lookup: 'marker', video: first.outputs['video-id'] ?? '' })
    expect(env.gh.commentsOn(123)).toHaveLength(1)
    expect(await videoCount(env)).toBe(1)
  })

  it('with the comment deleted it finds the video by its reference line', async () => {
    const env = await setup()
    const first = await runAction(env, { event: events.labeled(env.gh, 123), runId: '1' })
    env.gh.state.comments = []
    const second = await runAction(env, { event: events.labeled(env.gh, 123), runId: '2' })
    expect(second.outputs['video-id']).toBe(first.outputs['video-id'])
    expectLog(second.logs, { lookup: 'reference', candidates: 1 })
  })

  it('PR 12 never takes PR 123’s video, and a prompt merely quoting a reference line is not a match', async () => {
    const env = await setup()
    const pr123 = await runAction(env, { event: events.labeled(env.gh, 123), runId: '1' })
    env.gh.pull({ number: 12, title: 'Another change', user: { login: 'dana' } })
    const pr12 = await runAction(env, { event: events.labeled(env.gh, 12), runId: '2' })
    expect(pr12.outputs['video-id']).not.toBe(pr123.outputs['video-id'])
    // Someone pastes PR 123's line into PR 77's description: the brief scrubs it, and the lookup checks the last line.
    env.gh.pull({
      number: 77,
      title: 'Quoting',
      body: 'see [va-ref github:acme/web#pr-123]',
      user: { login: 'dana' },
    })
    const pr77 = await runAction(env, { event: events.labeled(env.gh, 77), runId: '3' })
    expect(pr77.outputs['video-id']).not.toBe(pr123.outputs['video-id'])
    const again123 = await runAction(env, { event: events.labeled(env.gh, 123), runId: '4' })
    expect(again123.outputs['video-id']).toBe(pr123.outputs['video-id'])
  })

  it('a deleted video is made again', async () => {
    const env = await setup()
    const first = await runAction(env, { event: events.labeled(env.gh, 123), runId: '1' })
    await env.h.call('DELETE', `/api/v1/videos/${first.outputs['video-id']}`, { key: env.key })
    const second = await runAction(env, { event: events.labeled(env.gh, 123), runId: '2' })
    expect(second.outputs.created).toBe('true')
    expect(second.outputs['video-id']).not.toBe(first.outputs['video-id'])
    expect(env.gh.commentsOn(123)).toHaveLength(1)
  })
})

describe('outcomes', () => {
  it('a failed run says so with "at least N credits" and offers a retry', async () => {
    const env = await setup()
    env.outcome(outcomes.failed())
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(r.failed).toBeNull()
    expect(r.status).toBe('failed')
    const body = env.gh.commentsOn(123)[0]?.body ?? ''
    expect(body).toContain("**The video couldn't be made**")
    expect(body).toContain('at least 5 credits')
    expect(body).toContain('/video retry')
  })

  it('stops waiting at timeout-minutes with "Still making it" in moments of test time', async () => {
    const env = await setup()
    env.outcome(outcomes.stillRunning())
    const started = Date.now()
    const r = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'timeout-minutes': '20' },
    })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(r.status).toBe('still-making')
    expect(env.gh.commentsOn(123)[0]?.body).toContain('**Still making it** after 20 minutes')
    expectLog(r.logs, { progress: 'running', step: 'Writing the composition' })
  })

  it('timeout-minutes 0 returns right after queueing', async () => {
    const env = await setup()
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { 'timeout-minutes': '0' } })
    expect(r.status).toBe('queued')
    expect(r.outputs['video-id']).toMatch(/^vid_/)
    expect(env.gh.commentsOn(123)[0]?.body).toContain('Making a demo video of this PR')
  })

  it('private makes the video private right after it is created', async () => {
    const env = await setup()
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { private: 'true' } })
    const v = await env.h.json(
      await env.h.call('GET', `/api/v1/videos/${r.outputs['video-id']}`, { key: env.key }),
    )
    expect(v.private).toBe(true)
    expect(v.title).toBe('PR #123: Webhooks: retry failed deliveries from the list')
  })
})

describe('budgets', () => {
  it('max-runs-per-day counts every run on the account and stops before spending', async () => {
    const env = await setup()
    env.gh.pull({ number: 1, title: 'one' })
    env.gh.pull({ number: 2, title: 'two' })
    await runAction(env, { event: events.labeled(env.gh, 1), runId: '1' })
    const r = await runAction(env, {
      event: events.labeled(env.gh, 2),
      runId: '2',
      inputs: { 'max-runs-per-day': '1' },
    })
    expect(r.status).toBe('skipped')
    expect(env.gh.commentsOn(2)).toHaveLength(0)
    expectLog(r.logs, { decision: 'stopped', cap: 'max-runs-per-day', used: 1, limit: 1 })
    expect(await videoCount(env)).toBe(1)
  })

  it('max-credits-per-month reads the month’s run credits', async () => {
    const env = await setup()
    env.gh.pull({ number: 1, title: 'one' })
    await runAction(env, { event: events.labeled(env.gh, 1), runId: '1' })
    const r = await runAction(env, {
      event: events.labeled(env.gh, 123),
      runId: '2',
      inputs: { 'max-credits-per-month': '40' },
    })
    expect(r.status).toBe('skipped')
    expectLog(r.logs, { decision: 'stopped', cap: 'max-credits-per-month', limit: 40 })
  })
})

describe('setup errors and skips', () => {
  it('a fork PR with no secrets skips before url and api-key are checked', async () => {
    const env = await setup()
    env.gh.pull({ number: 9, title: 'From a fork', headRepo: 'eve/web' })
    const r = await runAction(env, { event: events.labeled(env.gh, 9), inputs: { url: '', 'api-key': '' } })
    expect(r.failed).toBeNull()
    expect(r.status).toBe('skipped')
    expectLog(r.logs, { decision: 'skipped', reason: 'Videos for fork PRs are off' })
  })

  it('an untrusted sender is refused before anything is spent', async () => {
    const env = await setup()
    const r = await runAction(env, { event: events.labeled(env.gh, 123, 'video', { login: 'eve' }) })
    expect(r.status).toBe('refused')
    expect(await videoCount(env)).toBe(0)
  })

  it('a bad key fails the step with what to fix', async () => {
    const env = await setup()
    const r = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'api-key': 'nva_nope_nope' },
    })
    expect(r.status).toBe('error')
    expect(r.failed).toMatch(/the CI account needs the Creator role/)
    expect(r.failed).not.toContain('nva_nope_nope')
  })

  it('dry-run prints the brief and the calls, and spends and changes nothing', async () => {
    const env = await setup()
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { 'dry-run': 'true' } })
    expect(r.status).toBe('dry-run')
    expect(r.outputs.prompt).toContain('[va-ref github:acme/web#pr-123]')
    expect(r.logs.join('\n')).toContain(`would-call="${VIDEOS} (prompt`)
    expect(await videoCount(env)).toBe(0)
    expect(env.gh.commentsOn(123)).toHaveLength(0)
    expect(r.logs.join('\n')).not.toMatch(/authorization/i)
  })
})
