// video-agent create, revise, remix against the real routes (cli-and-sdk plan §6.2; bead va-p1th.4.6): every flag
// reaches the request with the API's field name, media files upload first, planning, --wait, --out, idempotency.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../packages/cli/src/exit.js'
import { cli } from './cli-io.js'
import { failedSnap, running } from './fakes.js'
import { harness, PROMPT, readyVideo } from './helpers.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'va-make-'))
const posts = (requests: Request[], path: string) =>
  requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === path)
const body = async (r: Request | undefined) =>
  r ? ((await r.clone().json()) as Record<string, unknown>) : null

describe('video-agent create', () => {
  it("sends each flag as the API's field, and a file in --media is uploaded first (deduped next time)", async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    const png = join(tmp(), 'shot.mp4')
    writeFileSync(png, readFileSync(new URL('./fixtures/a169.mp4', import.meta.url)))
    const argv = [
      'create',
      PROMPT,
      '--aspect',
      '9:16',
      '--duration',
      '20',
      '--sound',
      'music',
      '--voice',
      'af_heart',
      '--title',
      'Webhooks',
      '--webhook-url',
      'https://hooks.example.com/va',
      '--media',
      `${png}:"The new checkout"`,
      '--json',
    ]
    const r = await run(argv)
    expect(r.code).toBe(0)
    const sent = await body(posts(requests, '/api/v1/videos').at(-1))
    expect(sent).toMatchObject({
      prompt: PROMPT,
      aspect: '9:16',
      durationSec: 20,
      sound: 'music',
      voiceover: { enabled: true, voice: 'af_heart' },
      title: 'Webhooks',
      webhookUrl: 'https://hooks.example.com/va',
    })
    expect((sent?.mediaIds as string[]).length).toBe(1)
    const media = await h.json(
      await h.call('GET', `/api/v1/media/${(sent?.mediaIds as string[])[0]}`, { as: h.member }),
    )
    expect(media.caption).toBe('The new checkout')
    expect(r.json().id).toMatch(/^vid_/)
    // Again: the same file is found by hash, not uploaded twice.
    const uploads = () =>
      requests.filter((q) => q.method === 'POST' && new URL(q.url).pathname === '/api/v1/media').length
    const before = uploads()
    expect((await run(['create', PROMPT, '--media', png, '--voice', 'off', '--json'])).code).toBe(0)
    expect(uploads()).toBe(before)
    expect(await body(posts(requests, '/api/v1/videos').at(-1))).toMatchObject({
      voiceover: { enabled: false },
    })
  })

  it('reads the prompt from stdin, and the same --idempotency-key twice makes one video', async () => {
    const h = harness()
    const { run } = await cli(h, { stdin: `${PROMPT}\n` })
    const a = await run(['create', '--prompt-file', '-', '--idempotency-key', 'k1', '--json'])
    const b = await run(['create', '--prompt-file', '-', '--idempotency-key', 'k1', '--json'])
    expect(a.code).toBe(0)
    expect(b.json().id).toBe(a.json().id)
    expect((await run(['create'])).code).toBe(EXIT.usage)
  })

  it('--plan prints the questions; --plan-id with --answers makes the video from the brief', async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    h.deps.gateway.replies.push(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            question: 'Who is it for?',
            why: '',
            options: [
              { id: 'a', label: 'Developers', description: '' },
              { id: 'b', label: 'Platform teams', description: '', recommended: true },
            ],
          },
        ],
      }),
    )
    const plan = await run(['create', PROMPT, '--plan', '--json'])
    expect(plan.code).toBe(0)
    const { planId, questions } = plan.json()
    expect(questions).toEqual([
      {
        id: 'q1',
        text: 'Who is it for?',
        choices: [
          { id: 'b', label: 'Platform teams', recommended: true },
          { id: 'a', label: 'Developers', recommended: false },
        ],
      },
    ])
    h.deps.gateway.replies.push(
      JSON.stringify({
        title: 'Webhooks',
        goal: 'Announce',
        audience: 'Developers',
        keyMessage: 'One subscription',
        beats: [{ text: 'Problem', seconds: 10 }],
        tone: 'Calm',
        callToAction: 'Read the docs',
        mustInclude: [],
        avoid: [],
      }),
    )
    const answers = join(tmp(), 'answers.json')
    writeFileSync(answers, JSON.stringify({ answers: [{ questionId: 'q1', optionIds: ['a'] }] }))
    const made = await run(['create', '--plan-id', planId, '--answers', answers, '--json'])
    expect(made.code).toBe(0)
    expect(await body(posts(requests, '/api/v1/videos').at(-1))).toMatchObject({ planId })
    h.deps.gateway.isAvailable = false
    const off = await cli(h)
    expect((await off.run(['create', PROMPT, '--plan'])).code).toBe(EXIT.unsupported)
  })

  it('--wait follows to ready, --out downloads three files, and a failed run exits 5', async () => {
    const h = harness()
    const { run } = await cli(h, {
      drive: true,
      other: (req) => new Response(`bytes ${new URL(req.url).pathname}`),
    })
    const out = tmp()
    const r = await run(['create', PROMPT, '--out', out, '--json'])
    expect(r.code).toBe(0)
    expect(r.json().files).toHaveLength(3)
    expect(readdirSync(out).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.mp4$/),
        expect.stringMatching(/\.jpg$/),
        expect.stringMatching(/\.vtt$/),
      ]),
    )
    const h2 = harness()
    for (let i = 0; i < 5; i++) h2.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const failed = await (await cli(h2, { drive: true })).run(['create', PROMPT, '--wait', '--json'])
    expect(failed.code).toBe(EXIT.videoFailed)
  })
})

describe('video-agent revise and remix', () => {
  it('revise sends the change, --from-version and --comments; remix is refused when switched off (exit 7)', async () => {
    const h = harness()
    const id = await readyVideo(h, h.member)
    const { run, requests } = await cli(h)
    const r = await run([
      'revise',
      id,
      'Make the end card orange',
      '--from-version',
      '1',
      '--comments',
      'c1, c2',
      '--json',
    ])
    // Unknown comment ids are the server's call; the request carries them as commentIds.
    expect(await body(posts(requests, `/api/v1/videos/${id}/versions`).at(-1))).toMatchObject({
      prompt: 'Make the end card orange',
      fromVersion: 1,
      commentIds: ['c1', 'c2'],
    })
    expect([0, EXIT.usage, EXIT.notFound]).toContain(r.code)
    const ok = await run(['revise', id, 'Make the end card orange', '--json'])
    expect(ok.code).toBe(0)
    expect(ok.json().latestVersion).toBe(2)

    const remix = await run(['remix', id, 'Same format, about edge functions', '--aspect', '1:1', '--json'])
    expect(remix.code).toBe(0)
    expect(remix.json().id).not.toBe(id)
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { remixEnabled: false } })
    const fresh = await cli(h)
    expect((await fresh.run(['remix', id, 'Again'])).code).toBe(EXIT.unsupported)
  })
})
