// /video commands, the post-create race check, screenshots, releases and one-off videos, end to end against the real
// app (beads va-mg4i.2.8, 2.11, 2.12, 2.13, 2.10 dispatch).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { png, upload } from '../../../app/test/helpers.js'
import {
  events,
  expectLog,
  makeEnv,
  outcomes,
  runAction,
  type TestEnv,
  PHASE3_FEATURES,
} from './harness/index.js'

const PNG = new Uint8Array(png())
/** Starts like a PNG but isn't one: the server refuses it. */
const BROKEN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

async function setup() {
  const env = await makeEnv({ hide: PHASE3_FEATURES })
  env.gh.pull({
    number: 123,
    title: 'Webhooks: retry failed deliveries',
    user: { login: 'dana' },
    files: ['app/a.tsx'],
  })
  return env
}
const video = async (env: TestEnv, id: string) =>
  env.h.json(await env.h.call('GET', `/api/v1/videos/${id}`, { key: env.key }))
const reactions = (env: TestEnv, commentId: number) =>
  env.gh.state.comments.find((c) => c.id === commentId)?.reactions.map((r) => r.content) ?? []
const lastCommentId = (env: TestEnv) => env.gh.state.comments.at(-1)?.id ?? 0
const library = async (env: TestEnv) =>
  (await env.h.json(await env.h.call('GET', '/api/v1/media?limit=50', { key: env.key }))).items as {
    id: string
  }[]

describe('/video commands', () => {
  it('/video makes the video when there is none, then reports status; reactions say how it went', async () => {
    const env = await setup()
    events.labeled(env.gh, 123) // adds the label
    const cmd = events.comment(env.gh, 123, '/video')
    const r = await runAction(env, { event: cmd })
    expect(r.status).toBe('ready')
    expect(reactions(env, lastCommentId(env) - 1)).toEqual([])
    const id = (cmd.payload.comment as { id: number }).id
    expect(reactions(env, id)).toEqual(['eyes', '+1'])
    const status = events.comment(env.gh, 123, '/video status')
    const s = await runAction(env, { event: status, runId: '2' })
    expect(s.outputs).toMatchObject({ status: 'ready', created: 'false', 'video-id': r.outputs['video-id'] })
  })

  it('/video revise makes v2 in the same comment; an empty change is refused', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    const first = await runAction(env, { event: events.labeled(env.gh, 123) })
    const empty = events.comment(env.gh, 123, '/video revise   ')
    const e = await runAction(env, { event: empty, runId: '2' })
    expect(reactions(env, (empty.payload.comment as { id: number }).id)).toEqual(['eyes', 'confused'])
    expect(e.warnings.join('\n')).toContain('say what to change')
    const cmd = events.comment(env.gh, 123, '/video revise make the end card orange')
    const r = await runAction(env, { event: cmd, runId: '3' })
    expect(r.status).toBe('ready')
    expect(r.outputs).toMatchObject({ 'video-id': first.outputs['video-id'], version: '2', created: 'true' })
    const v = await video(env, first.outputs['video-id'] ?? '')
    expect(v.versions.find((x: { n: number }) => x.n === 2).prompt).toMatch(/^make the end card orange\n/)
    const ours = env.gh.state.comments.filter((c) => c.user.login === 'github-actions[bot]')
    expect(ours).toHaveLength(1)
    expect(ours[0]?.body).toContain('"made":2')
  })

  it('a command during a run waits for it, then runs', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    const first = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'timeout-minutes': '0' },
    })
    expect(first.status).toBe('queued')
    const r = await runAction(env, {
      event: events.comment(env.gh, 123, '/video revise shorter please'),
      runId: '2',
    })
    expect(r.status).toBe('ready')
    expect(r.outputs.version).toBe('2')
    expectLog(r.logs, { decision: 'wait', reason: 'a version is in progress' })
  })

  it('/video retry tries a failed version again, at most twice', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    env.outcome(outcomes.failed())
    const first = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(first.status).toBe('failed')
    env.outcome(outcomes.ready())
    const retried = await runAction(env, { event: events.comment(env.gh, 123, '/video retry'), runId: '2' })
    expect(retried.status).toBe('ready')
    expect(retried.outputs.version).toBe('1')
    env.outcome(outcomes.failed())
    const again = await runAction(env, {
      event: events.comment(env.gh, 123, '/video revise one more'),
      runId: '3',
    })
    expect(again.status).toBe('failed')
    // v2 failed once: one retry left, then none.
    env.outcome(outcomes.failed())
    await runAction(env, { event: events.comment(env.gh, 123, '/video retry'), runId: '4' })
    const refused = events.comment(env.gh, 123, '/video retry')
    const r = await runAction(env, { event: refused, runId: '5' })
    expect(r.status).toBe('refused')
    expect(r.warnings.join('\n')).toContain('no retries left')
    expect(reactions(env, (refused.payload.comment as { id: number }).id)).toEqual(['eyes', 'confused'])
  })

  it('/video publish puts the GIF in the comment; refused for a private video', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    await runAction(env, { event: events.labeled(env.gh, 123) })
    const r = await runAction(env, { event: events.comment(env.gh, 123, '/video publish'), runId: '2' })
    expect(r.status).toBe('ready')
    expect(r.outputs['share-url']).toMatch(/\/v\/[a-z0-9]+$/)
    expect(r.outputs['gif-url']).toMatch(/\.gif$/)
    const body = env.gh.state.comments.find((c) => c.user.login === 'github-actions[bot]')?.body ?? ''
    expect(body).toContain(`[![Demo video](${r.outputs['gif-url']})](${r.outputs['share-url']})`)

    const env2 = await setup()
    events.labeled(env2.gh, 123)
    await runAction(env2, { event: events.labeled(env2.gh, 123), inputs: { private: 'true' } })
    const p = await runAction(env2, { event: events.comment(env2.gh, 123, '/video publish'), runId: '2' })
    expect(p.status).toBe('refused')
    expect(p.warnings.join('\n')).toContain('this video is private')
  })

  it('/video cancel stops the version in progress', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    env.outcome(outcomes.stillRunning())
    await runAction(env, { event: events.labeled(env.gh, 123), inputs: { 'timeout-minutes': '0' } })
    const r = await runAction(env, { event: events.comment(env.gh, 123, '/video cancel'), runId: '2' })
    expect(['cancelled', 'queued', 'still-making']).toContain(r.status)
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(['cancelled']).toContain(
      v.versions[0].status === 'cancelled'
        ? 'cancelled'
        : (await env.h.drive(3), (await video(env, v.id)).versions[0].status),
    )
  })

  it('refuses commands without the label, from untrusted commenters, and unknown ones, with 😕 only', async () => {
    const env = await setup()
    const nolabel = events.comment(env.gh, 123, '/video')
    const a = await runAction(env, { event: nolabel })
    expect(a.status).toBe('refused')
    expect(reactions(env, (nolabel.payload.comment as { id: number }).id)).toEqual(['confused'])
    events.labeled(env.gh, 123)
    const eve = events.comment(env.gh, 123, '/video', { login: 'eve' })
    const b = await runAction(env, { event: eve, runId: '2' })
    expect(b.status).toBe('refused')
    expect(reactions(env, (eve.payload.comment as { id: number }).id)).toEqual(['confused'])
    const unknown = events.comment(env.gh, 123, '/video dance')
    await runAction(env, { event: unknown, runId: '3' })
    expect(reactions(env, (unknown.payload.comment as { id: number }).id)).toEqual(['confused'])
    expect(
      (await env.h.json(await env.h.call('GET', '/api/v1/videos?owner=me', { key: env.key }))).items,
    ).toHaveLength(0)
  })
})

describe('the post-create race check', () => {
  it('a label run and a /video run that both create end with one video', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    // Both look up and find nothing: the label run is held right after its lookup until the command run has created.
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
    expect(command.outputs.created).toBe('true')
    release()
    const l = await label
    const list = await env.h.json(await env.h.call('GET', '/api/v1/videos?owner=me', { key: env.key }))
    const ids = list.items.map((v: { id: string }) => v.id)
    // The command run created first, so it's older and survives; the label run cancels and deletes its own.
    expect(ids).toEqual([command.outputs['video-id']])
    expect(l.outputs['video-id']).toBe(command.outputs['video-id'])
    const lost = expectLog(l.logs, { race: 'lost', adopted: command.outputs['video-id'] ?? '' })
    expect(lost).toMatch(/deleted=vid_/)
  })
})

describe('screenshots', () => {
  it('uploads trusted PR images, keeps items the library had, skips private hosts, and cleans up after', async () => {
    const env = await setup()
    env.images.files.set('https://img.example.com/one.png', { bytes: PNG, type: 'image/png' })
    env.images.files.set('https://img.example.com/svg.png', {
      bytes: new TextEncoder().encode('<svg/>'),
      type: 'image/png',
    })
    env.images.files.set('https://cdn.internal/inner.png', { bytes: PNG, type: 'image/png' })
    env.images.files.set('https://img.example.com/broken.png', { bytes: BROKEN, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr)
      pr.body =
        'Look: ![the list](https://img.example.com/one.png) ![x](https://img.example.com/svg.png) ![y](https://cdn.internal/inner.png) ![z](https://img.example.com/broken.png)'
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(r.failed).toBeNull()
    expect(r.status).toBe('ready')
    expectLog(r.logs, { screenshot: 'uploaded' })
    expectLog(r.logs, { screenshot: 'skipped', reason: 'type' })
    expectLog(r.logs, { screenshot: 'skipped', reason: 'private-address' })
    expectLog(r.logs, { screenshot: 'skipped', reason: 'refused', status: 400 })
    // No token or cookie went to the image host.
    for (const req of env.images.requests) expect(Object.keys(req.headers)).not.toContain('authorization')
    // The run had it; the library doesn't any more.
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.versions[0].prompt).toContain(
      'Screenshots: attached as library media with captions "PR #123 screenshot 1: the list"',
    )
    expect(await library(env)).toHaveLength(0)
    expectLog(r.logs, { screenshot: 'deleted' })
  })

  it('an image already in the library is reused and kept', async () => {
    const env = await setup()
    const existing = await env.h.json(await upload(env.h, env.h.member, png(), 'filename=shot.png'))
    const bytes = new Uint8Array(png())
    env.images.files.set('https://img.example.com/same.png', { bytes, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr) pr.body = '![same](https://img.example.com/same.png)'
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expectLog(r.logs, { screenshot: 'reused', media: existing.id })
    expect((await library(env)).map((m) => m.id)).toContain(existing.id)
  })

  it("an untrusted author's images aren't used", async () => {
    const env = await setup()
    env.gh.pull({
      number: 5,
      title: 'Outside',
      user: { login: 'eve' },
      body: '![a](https://img.example.com/one.png)',
    })
    env.images.files.set('https://img.example.com/one.png', { bytes: PNG, type: 'image/png' })
    const r = await runAction(env, { event: events.labeled(env.gh, 5) })
    expect(r.status).toBe('ready')
    expect(env.images.requests).toHaveLength(0)
    expectLog(r.logs, { trust: 'refused', who: 'author', login: 'eve' })
  })

  it('private-repo attachments download through bodyHTML’s signed URLs', async () => {
    const env = await setup()
    const signed = 'https://private-user-images.githubusercontent.com/1/abc.png?jwt=x'
    env.images.files.set(signed, { bytes: PNG, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr) {
      pr.body = '<img alt="shot" src="https://github.com/user-attachments/assets/abc">'
      pr.bodyHTML = `<p><a href="${signed}"><img alt="shot" src="${signed}"></a></p>`
    }
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expectLog(r.logs, { screenshot: 'uploaded' })
    expect(env.images.requests.map((x) => x.url)).toEqual([signed])
  })
})

describe('screenshots from the workspace and max-versions', () => {
  it('reads a glob of workspace files (never outside it) and removes them from the library afterwards', async () => {
    const env = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'action-ws-'))
    mkdirSync(join(dir, 'video-shots'))
    writeFileSync(join(dir, 'video-shots', 'a.png'), PNG)
    writeFileSync(join(dir, 'video-shots', 'notes.txt'), 'not an image')
    writeFileSync(join(dir, 'outside.png'), PNG)
    const r = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { screenshots: 'video-shots/*.png' },
      deps: { cwd: dir },
    })
    expect(r.status).toBe('ready')
    expect(r.logs.filter((l) => l.includes('screenshot=uploaded'))).toHaveLength(1)
    expect(await library(env)).toHaveLength(0)
  })

  it('max-versions stops a revision before spending', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    await runAction(env, { event: events.labeled(env.gh, 123), inputs: { 'max-versions': '1' } })
    const r = await runAction(env, {
      event: events.comment(env.gh, 123, '/video revise again'),
      runId: '2',
      inputs: { 'max-versions': '1' },
    })
    expect(r.status).toBe('skipped')
    expectLog(r.logs, { decision: 'stopped', cap: 'max-versions', used: 1, limit: 1 })
    const ours = env.gh.state.comments.find((c) => c.user.login === 'github-actions[bot]')
    expect(ours?.body).toContain('already has 1 version (')
  })
})

describe('the gate’s remaining paths', () => {
  it('timeout → Still making it → /video status completes it and removes the leftover screenshots', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    env.images.files.set('https://img.example.com/one.png', { bytes: PNG, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr) pr.body = '![shot](https://img.example.com/one.png)'
    env.outcome(outcomes.stillRunning())
    const first = await runAction(env, {
      event: events.labeled(env.gh, 123),
      inputs: { 'timeout-minutes': '5' },
    })
    expect(first.status).toBe('still-making')
    // The upload waits in the marker's pending list.
    const ours = () => env.gh.state.comments.find((c) => c.user.login === 'github-actions[bot]')?.body ?? ''
    expect(ours()).toMatch(/"pending":\["med_/)
    expect(await library(env)).toHaveLength(1)
    // The run finishes; /video status shows it and cleans up.
    env.outcome(outcomes.ready())
    const run = [...env.h.deps.runner.runs.values()][0]
    if (run) run.script = { ...env.h.deps.runner.defaultScript(run.req) }
    await env.h.drive(6)
    const status = await runAction(env, { event: events.comment(env.gh, 123, '/video status'), runId: '2' })
    expect(status.status).toBe('ready')
    expect(await library(env)).toHaveLength(0)
    expect(ours()).not.toContain('"pending"')
    expect(ours()).toContain('**Ready:**')
  })

  it('a revision after cleanup still has the screenshots (the version keeps its own copy)', async () => {
    const env = await setup()
    events.labeled(env.gh, 123)
    env.images.files.set('https://img.example.com/one.png', { bytes: PNG, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr) pr.body = '![shot](https://img.example.com/one.png)'
    const first = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(await library(env)).toHaveLength(0)
    await runAction(env, { event: events.comment(env.gh, 123, '/video revise brighter'), runId: '2' })
    const id = first.outputs['video-id'] ?? ''
    const media = async (n: number) =>
      (
        await env.h.json(
          await env.h.call('GET', `/api/v1/videos/${id}/versions/${n}/media`, { key: env.key }),
        )
      ).items as unknown[]
    expect(await media(1)).toHaveLength(1)
    expect(await media(2)).toHaveLength(1)
  })

  it('refuses a screenshot over 4 MB without reading past the cap', async () => {
    const env = await setup()
    const big = new Uint8Array(4 * 1024 * 1024 + 10)
    big.set(PNG.slice(0, 8))
    env.images.files.set('https://img.example.com/big.png', { bytes: big, type: 'image/png' })
    const pr = env.gh.state.pulls.get(123)
    if (pr) pr.body = '![big](https://img.example.com/big.png)'
    const r = await runAction(env, { event: events.labeled(env.gh, 123) })
    expect(r.status).toBe('ready')
    expectLog(r.logs, { screenshot: 'skipped', reason: 'too-big' })
  })
})

describe('releases', () => {
  it('a published release gets one video and a section in its notes; a re-run replaces it', async () => {
    const env = await makeEnv({ hide: PHASE3_FEATURES })
    env.gh.release({
      tag_name: 'v2.4.0',
      body: '## What changed\n* Faster deploys by @lee in https://github.com/acme/web/pull/130',
    })
    const r = await runAction(env, { event: events.release(env.gh, 'v2.4.0') })
    expect(r.status).toBe('ready')
    const v = await video(env, r.outputs['video-id'] ?? '')
    expect(v.title).toBe("web: What's new in v2.4.0")
    expect(v.versions[0].prompt).toContain('- Faster deploys')
    const body = env.gh.state.releases[0]?.body ?? ''
    expect(body.startsWith('## What changed\n* Faster deploys')).toBe(true)
    expect(body).toMatch(/<!-- video-agent:start -->\n<!-- video-agent:v1 \{"videoId":"vid_/)
    expect(body).toContain('(sign in to watch)')
    const again = await runAction(env, { event: events.release(env.gh, 'v2.4.0'), runId: '2' })
    expect(again.outputs).toMatchObject({ created: 'false', 'video-id': r.outputs['video-id'] })
    expect((env.gh.state.releases[0]?.body ?? '').match(/video-agent:start/g)).toHaveLength(1)
  })

  it('target release/<tag> works from a push step, and a missing release skips', async () => {
    const env = await makeEnv({ hide: PHASE3_FEATURES })
    env.gh.release({ tag_name: 'v3.0.0', body: '- One thing' })
    const r = await runAction(env, { event: events.push(env.gh), inputs: { target: 'release/v3.0.0' } })
    expect(r.status).toBe('ready')
    const missing = await runAction(env, {
      event: events.push(env.gh),
      inputs: { target: 'release/v9' },
      runId: '2',
    })
    expect(missing.status).toBe('skipped')
  })
})

describe('one-off videos', () => {
  it('workflow_dispatch with no target makes a video from the prompt, with no comment', async () => {
    const env = await makeEnv({ hide: PHASE3_FEATURES })
    const r = await runAction(env, {
      event: events.dispatch(env.gh),
      inputs: { prompt: 'A 20-second teaser for our launch.' },
    })
    expect(r.status).toBe('ready')
    expect(r.outputs.prompt).toBe('A 20-second teaser for our launch.')
    expect(env.gh.state.comments).toHaveLength(0)
    const short = await runAction(env, {
      event: events.dispatch(env.gh),
      inputs: { prompt: 'hi' },
      runId: '2',
    })
    expect(short.failed).toMatch(/prompt: is required for a one-off video/)
  })
})
