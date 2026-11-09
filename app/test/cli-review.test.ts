// video-agent publish, unpublish, cancel, retry, comments, verdict against the real routes, with role errors
// (cli-and-sdk plan §6.2; bead va-p1th.4.8).
import { describe, expect, it } from 'vitest'
import { EXIT } from '../../packages/cli/src/exit.js'
import { cli, SITE } from './cli-io.js'
import { failedSnap, running } from './fakes.js'
import { harness, person, PROMPT, readyVideo } from './helpers.js'

describe('video-agent publish and unpublish', () => {
  it('prints the share link, MP4 link and embed snippet; --json has them all', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run } = await cli(h)
    const r = await run(['publish', id, '--json'])
    expect(r.code).toBe(0)
    const pub = r.json()
    expect(pub).toMatchObject({ versionN: 1, unpublishedAt: null, showTranscript: false })
    expect(pub.urls.page).toMatch(/\/v\/[a-z2-9]+$/)
    expect(pub.urls.mp4).toBe(`${pub.urls.page}.mp4`)
    expect(pub.embed).toContain('<video')
    expect(pub.player).toBe(
      `<script type="module" src="${SITE}/player.js"></script><video-agent-player src="${pub.urls.page}"></video-agent-player>`,
    )
    expect(Object.keys(pub).sort()).toMatchInlineSnapshot(`
      [
        "embed",
        "player",
        "publishedAt",
        "showTranscript",
        "slug",
        "unpublishedAt",
        "urls",
        "versionN",
      ]
    `)
    const human = await run(['publish', id])
    expect(human.stdout).toContain(`share  ${pub.urls.page}`)
    expect(human.stdout).toContain('Embed:')
    expect(human.stdout).toContain('Player:')
    expect(human.stdout).toContain(`<video-agent-player src="${pub.urls.page}">`)
    expect((await run(['unpublish', id])).stdout).toContain('Unpublished v1')
    expect((await run(['unpublish', id, '--json'])).code).toBe(EXIT.notFound)
  })

  it('a Reviewer or Viewer key gets exit 4', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    for (const role of ['reviewer', 'viewer'] as const) {
      const cookie = await person(h, `u_${role}`, role)
      const { run } = await cli(h, { as: cookie })
      const r = await run(['publish', id, '--json'])
      expect(r.code, role).toBe(EXIT.notFound)
      expect(['forbidden', 'not_found']).toContain(r.json().error.code)
    }
  })
})

describe('video-agent cancel and retry', () => {
  it('cancels a running version and retries a failed one (the latest by default)', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), running(), running(), running()] })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    const { run } = await cli(h)
    const c = await run(['cancel', v.id, '--json'])
    expect(c.code).toBe(0)
    await h.drive(3)
    const after = await h.json(await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }))
    expect(after.versions[0].status).toBe('cancelled')

    const h2 = harness()
    for (let i = 0; i < 5; i++) h2.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const v2 = await h2.json(
      await h2.call('POST', '/api/v1/videos', { as: h2.member, body: { prompt: PROMPT } }),
    )
    await h2.drive(20)
    const r = await (await cli(h2)).run(['retry', v2.id])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`Follow it: video-agent wait ${v2.id}`)
  })
})

describe('video-agent comments and verdict', () => {
  it("adds and lists comments; a reviewer sets, changes and clears a verdict (not the owner's own)", async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run } = await cli(h)
    const add = await run(['comments', 'add', id, 'The logo is too small', '--at', '2.5', '--json'])
    expect(add.code).toBe(0)
    expect(add.json()).toMatchObject({ versionN: 1, body: 'The logo is too small', timeSec: 2.5 })
    const list = await run(['comments', 'list', `${SITE}/videos/${id}`])
    expect(list.stdout).toMatch(/v1 @2\.5s {2}.+: The logo is too small/)
    expect((await run(['comments', 'add', id])).code).toBe(EXIT.usage)

    // Someone else's verdict: the owner can't approve their own version (exit 4).
    expect((await run(['verdict', id, 'approve'])).code).toBe(EXIT.notFound)
    const reviewer = await cli(h, { as: await person(h, 'u_rev', 'reviewer') })
    expect((await reviewer.run(['verdict', id, 'approve'])).stdout).toBe('Marked v1 approved.\n')
    expect((await reviewer.run(['verdict', id, 'changes', '--note', 'Shorter intro'])).stdout).toBe(
      'Marked v1 changes requested.\n',
    )
    const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(v.versions[0].verdicts).toMatchObject({ approved: 0, changesRequested: 1 })
    expect((await reviewer.run(['verdict', id, 'clear'])).code).toBe(0)
    expect((await reviewer.run(['verdict', id, 'maybe'])).code).toBe(EXIT.usage)
  })
})
