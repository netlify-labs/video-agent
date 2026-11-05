// video-agent get, list, wait, download, open against the real routes (cli-and-sdk plan §6.2; bead va-p1th.4.7).
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../packages/cli/src/exit.js'
import { cli, SITE } from './cli-io.js'
import { failedSnap, running } from './fakes.js'
import { harness, PROMPT, readyVideo } from './helpers.js'

const storage = (req: Request) => new Response(`bytes of ${new URL(req.url).pathname}`)

describe('video-agent get', () => {
  it('takes an id, a web address or a share link', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const pub = await h.json<{ slug: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
    )
    const { run } = await cli(h, {
      other: (req) =>
        new URL(req.url).pathname === `/v/${pub.slug}.json`
          ? Response.json({ video_agent: { videoId: id, versionN: 1 } })
          : new Response('no', { status: 404 }),
    })
    for (const ref of [
      id,
      `${SITE}/videos/${id}`,
      `${SITE}/videos/${id}/edit/1`,
      `https://share.example/v/${pub.slug}`,
    ]) {
      const r = await run(['get', ref, '--json'])
      expect(r.code, ref).toBe(0)
      expect(r.json().id).toBe(id)
    }
    const human = await run(['get', id])
    expect(human.stdout).toContain(`(${id})`)
    expect(human.stdout).toMatch(/v1 {2}ready {2}published https:\/\//)
    const missing = await run(['get', 'vid_nope', '--json'])
    expect(missing.code).toBe(EXIT.notFound)
    expect(missing.json().error.code).toBe('not_found')
    expect((await run(['get', 'hello'])).code).toBe(EXIT.usage)
  })
})

describe('video-agent list', () => {
  it("maps flags to the API's query names, and --all walks every page", async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    for (let i = 0; i < 3; i++)
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: `${PROMPT} ${i}` } })
    const r = await run(['list', '--mine', '--search', 'webhooks', '--limit', '2', '--json'])
    expect(r.code).toBe(0)
    const q = new URL(requests.at(-1)?.url ?? '').searchParams
    expect(Object.fromEntries(q)).toEqual({ owner: 'me', q: 'webhooks', limit: '2' })
    const page = await run(['list', '--mine', '--limit', '2', '--json'])
    expect(page.json().items).toHaveLength(2)
    expect(page.json().nextCursor).not.toBeNull()
    const all = await run(['list', '--mine', '--limit', '2', '--all', '--json'])
    expect(all.json().items).toHaveLength(3)
    expect(
      (await run(['list', '--mine'])).stdout.split('\n').filter((l) => l.startsWith('vid_')),
    ).toHaveLength(3)
  })
})

describe('video-agent wait', () => {
  it('follows a run to ready: progress on stderr, nothing on stdout', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run } = await cli(h)
    const r = await run(['wait', id])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('v1 · Ready')
    expect(r.stderr).toContain(`Ready: ${SITE}/videos/${id}`)
    expect((await run(['wait', id, '--json'])).json().id).toBe(id)
  })

  it('exits 5 when the version failed and 6 when --timeout passes', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(20)
    const { run } = await cli(h)
    const failed = await run(['wait', v.id, '--json'])
    expect(failed.code).toBe(EXIT.videoFailed)
    expect(failed.json().error.code).toBe('video_failed')
    const h2 = harness()
    h2.deps.runner.nextScripts.push({ timeline: [running(), running(), running(), running(), running()] })
    const v2 = await h2.json(
      await h2.call('POST', '/api/v1/videos', { as: h2.member, body: { prompt: PROMPT } }),
    )
    const slow = await (await cli(h2)).run(['wait', v2.id, '--timeout', '0'])
    expect(slow.code).toBe(EXIT.waitTimeout)
    expect(slow.stderr).toContain('Error:')
  })
})

describe('video-agent download', () => {
  it('downloads one file, or every file the version has (missing ones skipped), never sending the key to storage', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run, requests, key } = await cli(h, { other: storage })
    const dir = mkdtempSync(join(tmpdir(), 'va-dl-'))
    const one = await run(['download', id, '--out', join(dir, 'clip.mp4'), '--json'])
    expect(one.code).toBe(0)
    expect(readFileSync(join(dir, 'clip.mp4'), 'utf8')).toMatch(/^bytes of /)
    const all = await run(['download', id, '--file', 'all', '--out', join(dir, 'all'), '--json'])
    expect(all.code).toBe(0)
    const got = all.json() as { files: { file: string }[]; skipped: { file: string }[] }
    expect(got.files.map((f) => f.file)).toEqual(
      expect.arrayContaining(['video', 'poster', 'gif', 'captions']),
    )
    expect(got.skipped.map((s) => s.file)).toEqual(expect.arrayContaining(['narration']))
    expect(readdirSync(join(dir, 'all')).length).toBe(got.files.length)
    const storageReqs = requests.filter((r) => !new URL(r.url).pathname.startsWith('/api/'))
    expect(storageReqs.length).toBeGreaterThan(0)
    for (const r of storageReqs) expect(r.headers.get('authorization')).toBeNull()
    expect(key).toMatch(/^nva_/)
    expect((await run(['download', id, '--file', 'nope'])).code).toBe(EXIT.usage)
  })
})

describe('video-agent open', () => {
  it("opens the video's page, or prints it with --json", async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run, opened } = await cli(h)
    const r = await run(['open', id])
    expect(r.code).toBe(0)
    expect(opened).toEqual([`${SITE}/videos/${id}`])
    expect((await run(['open', id, '--json'])).json()).toEqual({ url: `${SITE}/videos/${id}` })
    expect(opened).toHaveLength(1)
  })
})
