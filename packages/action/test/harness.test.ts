// The test harness itself (bead va-mg4i.2.2): the fake GitHub behaves like the routes the action calls, the image host
// records headers, and the fake clock drives a real run from queued to ready without waiting.
import { describe, expect, it } from 'vitest'
import { VideoAgent } from '../../sdk/src/index.js'
import { createGitHub } from '../src/github.js'
import { createLog } from '../src/log.js'
import type { Core } from '../src/core.js'
import { appFetch, events, expectLog, makeEnv, outcomes, runAction, SITE } from './harness/index.js'

const quietCore = (lines: string[] = []): Core => ({
  getInput: () => '',
  setOutput: () => undefined,
  setSecret: () => undefined,
  info: (m) => lines.push(m),
  warning: (m) => lines.push(m),
  setFailed: () => undefined,
  startGroup: () => undefined,
  endGroup: () => undefined,
  summary: () => undefined,
})

describe('fake GitHub', () => {
  it('pages lists with Link headers, newest-first iteration is the caller’s job', async () => {
    const env = await makeEnv({ gh: { pageSize: 2 } })
    env.gh.pull({ number: 7 })
    for (let i = 0; i < 5; i++) env.gh.comment(7, `c${i}`)
    const lines: string[] = []
    const gh = createGitHub({
      token: 't',
      repository: 'acme/web',
      fetch: env.gh.fetch,
      log: createLog(quietCore(lines)),
    })
    const bodies: string[] = []
    for await (const c of gh.paginate<{ body: string }>(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        path: { issue_number: 7 },
      },
    ))
      bodies.push(c.body)
    expect(bodies).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(env.gh.count('GET /repos/{o}/{r}/issues/{n}/comments')).toBe(3)
    // Every call is logged with the rate limit left, which falls.
    const remaining = lines.map((l) => Number(/remaining=(\d+)/.exec(l)?.[1]))
    expect(remaining).toEqual([999, 998, 997])
  })

  it('answers permissions per login (404 for strangers), 403 on GET /user, and injected failures', async () => {
    const env = await makeEnv({ gh: { permissions: { dana: 'write', rita: 'read' } } })
    const gh = createGitHub({
      token: 't',
      repository: 'acme/web',
      fetch: env.gh.fetch,
      log: createLog(quietCore()),
    })
    const perm = (login: string) =>
      gh.request<{ permission: string }>('GET /repos/{owner}/{repo}/collaborators/{login}/permission', {
        path: { login },
      })
    expect((await perm('dana')).data.permission).toBe('write')
    expect((await perm('rita')).data.permission).toBe('read')
    await expect(perm('eve')).rejects.toMatchObject({ status: 404 })
    await expect(gh.request('GET /user')).rejects.toMatchObject({ status: 403 })
    env.gh.fail('GET /repos/{o}/{r}', 502)
    await expect(gh.request('GET /repos/{owner}/{repo}')).rejects.toMatchObject({ status: 502 })
    expect((await gh.request<{ private: boolean }>('GET /repos/{owner}/{repo}')).data.private).toBe(true)
  })

  it('makes comments as github-actions[bot] and keeps reactions', async () => {
    const env = await makeEnv()
    env.gh.pull({ number: 3 })
    const gh = createGitHub({
      token: 't',
      repository: 'acme/web',
      fetch: env.gh.fetch,
      log: createLog(quietCore()),
    })
    const made = await gh.request<{ id: number; user: { login: string } }>(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { path: { issue_number: 3 }, body: { body: 'hello' } },
    )
    expect(made.data.user.login).toBe('github-actions[bot]')
    await gh.request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
      path: { comment_id: made.data.id },
      body: { content: 'eyes' },
    })
    expect(env.gh.commentsOn(3)[0]?.reactions.map((r) => r.content)).toEqual(['eyes'])
  })
})

describe('image host', () => {
  it('serves fixtures and records the headers each request carried', async () => {
    const env = await makeEnv()
    env.images.files.set('https://img.example.com/a.png', {
      bytes: new Uint8Array([1, 2]),
      type: 'image/png',
    })
    const res = await env.images.fetch('https://img.example.com/a.png', { headers: { 'user-agent': 'x' } })
    expect(res.status).toBe(200)
    expect(env.images.requests[0]?.headers).toEqual({ 'user-agent': 'x' })
    expect((await env.images.fetch('https://img.example.com/missing.png')).status).toBe(404)
  })
})

describe.each(['memory', 'pglite'] as const)('the app and the clock (%s)', (store) => {
  it('runs the action against the app: a push with no target does nothing', async () => {
    const env = await makeEnv({ store })
    const r = await runAction(env, { event: events.push(env.gh) })
    expect(r.status).toBe('none')
    expect(r.failed).toBeNull()
    expectLog(r.logs, { decision: 'none', reason: 'nothing to do for event push' })
  })

  it('drives a run from queued to ready with the fake clock, and a 30-minute wait passes in moments', async () => {
    const env = await makeEnv({ store })
    const va = new VideoAgent({ url: SITE, apiKey: env.key, fetch: appFetch(env.h) })
    const video = await va.videos.create({ prompt: 'A short launch video for webhooks.' })
    const started = Date.now()
    const clock = () => env.h.deps.clock.now().getTime()
    const begin = clock()
    let status = video.status
    // The same loop the action's wait will use: poll, then sleep (advance the clock and tick the reconciler).
    const r = await runAction(env, { event: events.push(env.gh), deps: {} })
    expect(r.status).toBe('none')
    for (let i = 0; i < 20 && status !== 'ready'; i++) {
      env.h.deps.clock.advance(15_000)
      await env.h.drive(1)
      status = (await va.videos.get(video.id)).status
    }
    expect(status).toBe('ready')

    // A run that never finishes: half an hour of 15-second polls on the fake clock.
    env.outcome(outcomes.stillRunning())
    const slow = await va.videos.create({ prompt: 'A run that keeps running for a long time.' })
    const t0 = clock()
    while (clock() - t0 < 30 * 60_000) {
      env.h.deps.clock.advance(15_000)
      await env.h.drive(1)
    }
    expect(['running', 'queued', 'timed_out', 'finishing']).toContain((await va.videos.get(slow.id)).status)
    expect(clock() - begin).toBeGreaterThan(30 * 60_000)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
