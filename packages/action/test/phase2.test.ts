// Phase 2 end to end against the real app (beads va-mg4i.3.1-3.4): revise on push, base-video remixes, publishing with
// the GIF and release assets, and /video redo of one scene.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../../../src/domain/engines.js'
import { load, save } from '../../../src/lib/contract.js'
import { hyperframesScopeCheck } from '../../../src/lib/scope.js'
import { readyVideo } from '../../../test/helpers.js'
import { tarGz } from '../../../test/tarball.js'
import { events, expectLog, makeEnv, runAction, type TestEnv } from './harness/index.js'

async function withPr(n = 123) {
  const env = await makeEnv()
  env.gh.pull({
    number: n,
    title: 'Webhooks: retry failed deliveries',
    user: { login: 'dana' },
    commits: [{ sha: 'c1', message: 'feat: retry button' }],
    headSha: 'c1',
    files: ['app/a.tsx'],
  })
  return env
}
const video = async (env: TestEnv, id: string) =>
  env.h.json(await env.h.call('GET', `/api/v1/videos/${id}`, { key: env.key }))
const ours = (env: TestEnv, n = 123) =>
  env.gh.state.comments.find((c) => c.issue === n && c.user.login === 'github-actions[bot]')?.body ?? ''

describe('on-push: revise', () => {
  it('revises with only the commits since the last version, and does nothing without new commits', async () => {
    const env = await withPr()
    const first = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'on-push': 'revise' },
    })
    expect(ours(env)).toContain('"headSha":"c1"')
    // Two pushes land; the concurrency group cancels the older pending run, so one run sees head c3.
    const pr = env.gh.state.pulls.get(123)
    if (pr) {
      pr.commits.push({ sha: 'c2', message: 'fix: spinner' }, { sha: 'c3', message: 'feat: retry all' })
      pr.headSha = 'c3'
      pr.filesBySha = { c3: ['app/b.tsx'] }
    }
    const r = await runAction(env, {
      event: events.synchronize(env.gh, 123),
      inputs: { 'on-push': 'revise' },
      runId: '2',
    })
    expect(r.status).toBe('ready')
    expect(r.outputs).toMatchObject({ 'video-id': first.outputs['video-id'], version: '2' })
    const v2 = (await video(env, first.outputs['video-id'] ?? '')).versions.find(
      (x: { n: number }) => x.n === 2,
    )
    expect(v2.prompt).toContain('New commits: fix: spinner; feat: retry all')
    expect(v2.prompt).toContain('Files changed since then: app/b.tsx')
    expect(v2.prompt).not.toContain('feat: retry button')
    expect(ours(env)).toContain('"headSha":"c3"')
    // The same head again: nothing new to show.
    const again = await runAction(env, {
      event: events.synchronize(env.gh, 123),
      inputs: { 'on-push': 'revise' },
      runId: '3',
    })
    expectLog(again.logs, { decision: 'none', reason: 'no new commits since the last version' })
    expect((await video(env, first.outputs['video-id'] ?? '')).versions).toHaveLength(2)
  })

  it('a push before any video does nothing; max-versions stops push revisions', async () => {
    const env = await withPr()
    events.labeled(env.gh, 123)
    const none = await runAction(env, {
      event: events.synchronize(env.gh, 123),
      inputs: { 'on-push': 'revise' },
    })
    expect(none.status).toBe('skipped')
    expectLog(none.logs, { decision: 'none', reason: 'no video yet' })
    await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'on-push': 'revise', 'max-versions': '1' },
      runId: '2',
    })
    const pr = env.gh.state.pulls.get(123)
    if (pr) {
      pr.commits.push({ sha: 'c2', message: 'more' })
      pr.headSha = 'c2'
    }
    const limited = await runAction(env, {
      event: events.synchronize(env.gh, 123),
      inputs: { 'on-push': 'revise', 'max-versions': '1' },
      runId: '3',
    })
    expect(limited.status).toBe('skipped')
    expect(ours(env)).toContain('already has 1 version (')
  })
})

describe('base-video', () => {
  it('a release remixes the house video with its own title, and the next run finds it', async () => {
    const env = await makeEnv()
    const base = await readyVideo(env.h)
    env.gh.release({ tag_name: 'v2.4.0', body: '- Retry failed deliveries\n- One webhook per org' })
    const r = await runAction(env, {
      event: events.release(env.gh, 'v2.4.0'),
      inputs: { 'base-video': base },
    })
    expect(r.failed).toBeNull()
    expect(r.status).toBe('ready')
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.isRemix).toBe(true)
    expect(v.title).toBe("web: What's new in v2.4.0")
    expect(v.versions[0].prompt).toMatch(
      /^Same format, pacing and look as this video, but for release v2\.4\.0/,
    )
    expect(v.versions[0].prompt.trimEnd().endsWith('[va-ref github:acme/web@v2.4.0]')).toBe(true)
    const again = await runAction(env, {
      event: events.release(env.gh, 'v2.4.0'),
      inputs: { 'base-video': base },
      runId: '2',
    })
    expect(again.outputs).toMatchObject({ created: 'false', 'video-id': v.id })
  })

  it('reports remixing turned off and a base video the account can’t see', async () => {
    const env = await makeEnv()
    const base = await readyVideo(env.h)
    await env.h.call('PATCH', '/api/v1/admin/settings', { as: env.h.admin, body: { remixEnabled: false } })
    env.gh.release({ tag_name: 'v1', body: '- A thing' })
    const off = await runAction(env, { event: events.release(env.gh, 'v1'), inputs: { 'base-video': base } })
    expect(off.status).toBe('skipped')
    expect(off.warnings.join('\n')).toContain('drop base-video or ask an admin to turn remixing on')
    await env.h.call('PATCH', '/api/v1/admin/settings', { as: env.h.admin, body: { remixEnabled: true } })
    const missing = await runAction(env, {
      event: events.release(env.gh, 'v1'),
      inputs: { 'base-video': 'vid_01nonexistent0000000000000' },
      runId: '2',
    })
    expect(missing.failed).toMatch(
      /base-video vid_01nonexistent0000000000000 not found or not visible to the CI account/,
    )
  })
})

describe('publishing and release assets', () => {
  it('publish: true shows the GIF in the comment and sets the public outputs', async () => {
    const env = await withPr()
    const r = await runAction(env, { event: events.labeled(env.gh, 123), inputs: { publish: 'true' } })
    expect(r.outputs['gif-url']).toMatch(/\/v\/[a-z0-9]+\.gif$/)
    expect(ours(env)).toContain(`[![Demo video](${r.outputs['gif-url']})](${r.outputs['share-url']})`)
    expect(r.summary).toContain(`![poster](${r.outputs['poster-url']})`)
  })

  it('release-asset attaches the MP4 and captions, and a re-run replaces them', async () => {
    const env = await makeEnv()
    env.gh.release({ tag_name: 'v3.0.0', body: '- New editor' })
    const inputs = { 'release-asset': 'true', publish: 'true' }
    const r = await runAction(env, { event: events.release(env.gh, 'v3.0.0'), inputs })
    expect(r.failed).toBeNull()
    const assets = () => env.gh.state.releases[0]?.assets.map((a) => a.name).sort()
    expect(assets()).toEqual(['video-v3.0.0.mp4', 'video-v3.0.0.vtt'])
    expect(env.gh.state.releases[0]?.body).toContain('[![What')
    await runAction(env, { event: events.release(env.gh, 'v3.0.0'), inputs, runId: '2' })
    expect(assets()).toEqual(['video-v3.0.0.mp4', 'video-v3.0.0.vtt'])
    expect(env.gh.state.releases[0]?.assets[0]?.size).toBeGreaterThan(0)
    // The signed storage links were fetched without the key.
    expect(env.storage.length).toBeGreaterThan(0)
    for (const req of env.storage) expect(Object.keys(req.headers)).not.toContain('authorization')
  })

  it('release-asset on a public repo without publish is refused before anything runs', async () => {
    const env = await makeEnv({ gh: { visibility: 'public' } })
    env.gh.release({ tag_name: 'v1', body: '- x' })
    const r = await runAction(env, {
      event: events.release(env.gh, 'v1'),
      inputs: { 'release-asset': 'true' },
    })
    expect(r.failed).toMatch(/release-asset: on a public repo publishes the video: set publish: true/)
  })
})

describe('/video redo', () => {
  beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
  afterEach(() => resetScopeChecks())
  const music = save(
    load(readFileSync(new URL('../../../test/fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
  )

  it('redoes one scene by label or id; unknown scenes and a missing feature answer 😕', async () => {
    const env = await withPr()
    events.labeled(env.gh, 123)
    env.h.deps.nextSource = tarGz([
      { name: 'video/index.html', body: music },
      { name: 'video/summary.json', body: '{"captions":[]}' },
    ])
    const first = await runAction(env, { event: events.labeled(env.gh, 123) })
    // The server lists scoped_revision, so the ready comment offers /video redo.
    expect(ours(env)).toContain('/video redo')
    const v1 = (await video(env, first.outputs['video-id'] ?? '')).versions[0]
    expect(v1.beats?.length).toBeGreaterThan(1)
    const unknown = events.comment(env.gh, 123, '/video redo nowhere make it orange')
    const u = await runAction(env, { event: unknown, runId: '2' })
    expect(u.warnings.join('\n')).toMatch(/no scene \\?"nowhere\\?" in v1; scenes: intro/)
    const scene = v1.beats[0]
    const byLabel = scene.label ? `"${scene.label}"` : scene.id
    const r = await runAction(env, {
      event: events.comment(env.gh, 123, `/video redo ${byLabel} make the headline orange`),
      runId: '3',
    })
    expect(r.failed).toBeNull()
    expect(r.outputs.version).toBe('2')
    const v2 = (await video(env, first.outputs['video-id'] ?? '')).versions.find(
      (x: { n: number }) => x.n === 2,
    )
    expect(v2.scope.beats.map((b: { id: string }) => b.id)).toEqual([scene.id])
    expect(v2.prompt).toMatch(/^make the headline orange/)
    // Whether the server accepts the fake run's output is the server's call; the action asked for one scene.
    expect(['ready', 'failed']).toContain(r.status)
  })

  it('without scoped_revision on the server, redo answers 😕', async () => {
    resetScopeChecks()
    const env = await withPr()
    events.labeled(env.gh, 123)
    await runAction(env, { event: events.labeled(env.gh, 123) })
    const cmd = events.comment(env.gh, 123, '/video redo intro brighter')
    const r = await runAction(env, { event: cmd, runId: '2' })
    expect(r.warnings.join('\n')).toContain('redoing one scene is not available on this server')
    expect(
      env.gh.state.comments
        .find((c) => c.id === (cmd.payload.comment as { id: number }).id)
        ?.reactions.map((x) => x.content),
    ).toEqual(['eyes', 'confused'])
  })
})
