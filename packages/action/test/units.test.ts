// Unit tests for the action's pure parts: inputs, the event router, trust, keys and markers, the comment, commands and
// screenshot sniffing (beads va-mg4i.2.3, 2.4, 2.7, 2.9, 2.11, 2.12).
import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/commands.js'
import { renderComment, type CommentState } from '../src/comment.js'
import type { RunContext } from '../src/context.js'
import { createGitHub } from '../src/github.js'
import { checkConnection, checkVisibility, readInputs, type Inputs } from '../src/inputs.js'
import { createLog } from '../src/log.js'
import { route } from '../src/router.js'
import { imageLinks, sniff } from '../src/screenshots.js'
import { capKey, keys, parseMarker, renderMarker, type Version } from '../src/state.js'
import { isFork, Trust } from '../src/trust.js'
import { fakeGitHub } from './harness/index.js'

const core = (inputs: Record<string, string>) => ({ getInput: (n: string) => inputs[n] ?? '' })
const defaults: Record<string, string> = { label: 'video' }
const inputs = (o: Record<string, string> = {}): Inputs => readInputs(core({ ...defaults, ...o }))

const ctx = (eventName: string, event: Record<string, unknown>): RunContext => ({
  eventName,
  event,
  repository: 'acme/web',
  runId: '1',
  runAttempt: '1',
  serverUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
})
const pr = (labels: string[] = ['video']) => ({ number: 5, labels: labels.map((name) => ({ name })) })

describe('inputs', () => {
  it('parses defaults and checks each input by name', () => {
    const i = inputs()
    expect(i).toMatchObject({
      aspect: '16:9',
      label: 'video',
      onPush: 'ignore',
      maxVersions: 3,
      maxRunsPerDay: 10,
      timeoutMinutes: 30,
      trust: 'members',
      publish: false,
      duration: null,
      target: null,
      maxCreditsPerMonth: null,
      screenshots: { kind: 'body' },
    })
    expect(inputs({ target: 'release/v2.4.0' }).target).toEqual({ kind: 'release', tag: 'v2.4.0' })
    expect(inputs({ screenshots: 'shots/*.png' }).screenshots).toEqual({
      kind: 'glob',
      pattern: 'shots/*.png',
    })
    expect(inputs({ 'timeout-minutes': '0' }).timeoutMinutes).toBe(0)
    expect(inputs({ label: '' }).label).toBe('')
  })

  it.each([
    [{ aspect: '4:3' }, 'aspect: must be 16:9, 9:16, 1:1, 4:5 (got "4:3")'],
    [{ 'timeout-minutes': '-1' }, 'timeout-minutes: must be a whole number of at least 0 (got "-1")'],
    [{ duration: '0' }, 'duration: must be a whole number of at least 1 (got "0")'],
    [{ target: 'issue/3' }, 'target: must be pr/<number> or release/<tag> (got "issue/3")'],
    [{ 'on-push': 'yes' }, 'on-push: must be ignore, revise (got "yes")'],
    [{ publish: 'yes' }, 'publish: must be true or false (got "yes")'],
    [{ 'base-video': 'abc' }, 'base-video: must be a video id like vid_01jc… (got "abc")'],
    [{ 'max-credits-per-month': '-5' }, 'max-credits-per-month: must be a positive number (got "-5")'],
    [{ private: 'true', publish: 'true' }, /^private: can't be used with publish/],
  ] as const)('refuses %o', (o, message) => {
    expect(() => inputs(o)).toThrow(message)
  })

  it('refuses private or release-asset without publish on a public repo; private repos allow either', () => {
    expect(() => checkVisibility(inputs({ 'release-asset': 'true', private: 'true' }), false)).toThrow(
      /^private: can't be used with release-asset/,
    )
    expect(() => checkVisibility(inputs({ 'release-asset': 'true' }), false)).toThrow(
      'release-asset: on a public repo publishes the video: set publish: true',
    )
    expect(() => checkVisibility(inputs({ 'release-asset': 'true', publish: 'true' }), false)).not.toThrow()
    expect(() => checkVisibility(inputs({ 'release-asset': 'true', private: 'true' }), true)).not.toThrow()
  })

  it('checks url and api-key only when asked (after the fork check)', () => {
    expect(() => checkConnection(inputs())).toThrow('url: is required')
    expect(() => checkConnection(inputs({ url: 'http://videos.acme.com', 'api-key': 'nva_x' }))).toThrow(
      'url: must be https',
    )
    expect(() => checkConnection(inputs({ url: 'http://localhost:8888', 'api-key': 'nva_x' }))).not.toThrow()
    expect(() => checkConnection(inputs({ url: 'https://v.acme.com', 'api-key': 'ghp_x' }))).toThrow(
      'api-key: must be a Video Agent key',
    )
  })
})

describe('router', () => {
  const r = (eventName: string, event: Record<string, unknown>, o: Record<string, string> = {}) =>
    route(ctx(eventName, event), inputs(o))
  it.each([
    [
      'labeled with the label',
      'pull_request',
      { action: 'labeled', label: { name: 'video' }, pull_request: pr() },
      {},
      'pr-label',
    ],
    [
      'labeled with another label',
      'pull_request',
      { action: 'labeled', label: { name: 'bug' }, pull_request: pr() },
      {},
      'none',
    ],
    [
      'any label when label is empty',
      'pull_request',
      { action: 'labeled', label: { name: 'bug' }, pull_request: pr([]) },
      { label: '' },
      'pr-label',
    ],
    [
      'synchronize, on-push ignore',
      'pull_request',
      { action: 'synchronize', pull_request: pr() },
      {},
      'none',
    ],
    [
      'synchronize, on-push revise, labelled',
      'pull_request',
      { action: 'synchronize', pull_request: pr() },
      { 'on-push': 'revise' },
      'pr-push',
    ],
    [
      'synchronize, on-push revise, no label',
      'pull_request',
      { action: 'synchronize', pull_request: pr([]) },
      { 'on-push': 'revise' },
      'none',
    ],
    [
      'a command',
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, pull_request: {}, labels: [{ name: 'video' }] },
        comment: { id: 9, body: '/video revise make it orange', user: { login: 'dana' } },
      },
      {},
      'command',
    ],
    [
      '/videos is not a command',
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, pull_request: {}, labels: [{ name: 'video' }] },
        comment: { id: 9, body: '/videos', user: { login: 'd' } },
      },
      {},
      'none',
    ],
    [
      '/Video is not a command',
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, pull_request: {}, labels: [{ name: 'video' }] },
        comment: { id: 9, body: '/Video', user: { login: 'd' } },
      },
      {},
      'none',
    ],
    [
      'a command without the label',
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, pull_request: {}, labels: [] },
        comment: { id: 9, body: '/video', user: { login: 'd' } },
      },
      {},
      'command-refused',
    ],
    [
      'a comment on an issue',
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, labels: [] },
        comment: { id: 9, body: '/video', user: { login: 'd' } },
      },
      {},
      'none',
    ],
    ['release published', 'release', { action: 'published', release: { tag_name: 'v1' } }, {}, 'release'],
    ['release edited', 'release', { action: 'edited', release: { tag_name: 'v1' } }, {}, 'none'],
    ['dispatch without target', 'workflow_dispatch', {}, {}, 'dispatch'],
    ['dispatch with a PR target', 'workflow_dispatch', {}, { target: 'pr/12' }, 'pr-label'],
    ['push with a release target', 'push', {}, { target: 'release/v3' }, 'release'],
    ['an unknown event', 'schedule', {}, {}, 'none'],
  ] as const)('%s', (_name, eventName, event, o, kind) => {
    expect(r(eventName, event, o).kind).toBe(kind)
  })

  it('says why it does nothing', () => {
    expect(r('push', {}).reason).toBe('nothing to do for event push')
    expect(r('pull_request', { action: 'labeled', label: { name: 'bug' }, pull_request: pr() }).reason).toBe(
      "label bug isn't video",
    )
    expect(
      r('issue_comment', {
        action: 'created',
        issue: { number: 5, pull_request: {}, labels: [] },
        comment: { id: 1, body: '/video', user: { login: 'd' } },
      }).reason,
    ).toBe('add the video label first')
  })
})

describe('trust', () => {
  const setup = (permissions: Record<string, string>) => {
    const gh = fakeGitHub({ permissions })
    const lines: string[] = []
    const log = createLog({
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
    return {
      gh,
      lines,
      trust: new Trust(createGitHub({ token: 't', repository: 'acme/web', fetch: gh.fetch, log }), log),
    }
  }

  it('trusts write, maintain and admin through the permission endpoint, whatever author_association says', async () => {
    const { trust, lines } = setup({
      dana: 'write',
      mo: 'maintain',
      ada: 'admin',
      tri: 'triage',
      rita: 'read',
      out: 'none',
    })
    expect((await trust.check('sender', 'dana', 'NONE')).trusted).toBe(true)
    expect((await trust.check('sender', 'mo', 'CONTRIBUTOR')).trusted).toBe(true)
    expect((await trust.check('sender', 'ada')).trusted).toBe(true)
    expect((await trust.check('sender', 'tri')).trusted).toBe(false)
    expect((await trust.check('author', 'rita', 'MEMBER')).trusted).toBe(false)
    expect((await trust.check('commenter', 'out')).trusted).toBe(false)
    expect((await trust.check('sender', 'stranger')).trusted).toBe(false) // 404
    expect((await trust.check('sender', 'dependabot[bot]')).trusted).toBe(false)
    expect(lines).toContain('video-agent: trust=ok who=sender login=dana via=permission permission=write')
    expect(lines).toContain('video-agent: trust=refused who=author login=rita via=permission permission=read')
  })

  it('accepts OWNER and COLLABORATOR without a request, and asks once per login per run', async () => {
    const { trust, gh } = setup({ dana: 'write' })
    expect((await trust.check('author', 'boss', 'OWNER')).trusted).toBe(true)
    await trust.check('sender', 'dana')
    await trust.check('author', 'dana')
    expect(gh.count('GET /repos/{o}/{r}/collaborators/{login}/permission')).toBe(1)
  })

  it('treats a different head repo or a deleted fork as a fork', () => {
    const base = { base: { repo: { full_name: 'acme/web' } } }
    expect(isFork({ ...base, head: { repo: { full_name: 'acme/web' } } })).toBe(false)
    expect(isFork({ ...base, head: { repo: { full_name: 'eve/web' } } })).toBe(true)
    expect(isFork({ ...base, head: { repo: null } })).toBe(true)
  })
})

describe('keys and the marker', () => {
  const t = { kind: 'pr' as const, owner: 'acme', repo: 'web', number: 123 }
  it('builds run-scoped keys under 200 characters, with a stable hash suffix when long', () => {
    expect(keys.create(t, '7001')).toBe('gh:acme/web#pr-123:create:7001')
    expect(keys.revise(t, 'abc', '7001')).toBe('gh:acme/web#pr-123:rev:abc:7001')
    expect(keys.command(t, 55)).toBe('gh:acme/web#pr-123:cmd:55')
    expect(keys.create({ kind: 'release', owner: 'acme', repo: 'web', tag: 'v1' }, '9')).toBe(
      'gh:acme/web@v1:create:9',
    )
    expect(keys.dispatch('acme', 'web', '9')).toBe('gh:acme/web:dispatch:9')
    const long = keys.create(
      { kind: 'release', owner: 'o'.repeat(39), repo: 'r'.repeat(100), tag: 'x'.repeat(200) },
      '1',
    )
    expect(long.length).toBe(200)
    expect(long).toMatch(/:h[0-9a-f]{16}$/)
    expect(capKey('k'.repeat(300))).toBe(capKey('k'.repeat(300)))
    expect(capKey('k'.repeat(300))).not.toBe(capKey(`${'k'.repeat(299)}j`))
  })

  it('round-trips the marker, tolerates edits around it, ignores broken JSON', () => {
    const m = { videoId: 'vid_1', headSha: 'abc', made: 2, pending: ['med_1'] }
    expect(parseMarker(`someone added text\n${renderMarker(m)}\nand more`)).toEqual(m)
    expect(parseMarker('<!-- video-agent:v1 {"videoId": -->')).toBeNull()
    expect(parseMarker('<!-- video-agent:v1 {"other":1} -->')).toBeNull()
    expect(parseMarker('no marker')).toBeNull()
  })
})

const version = (o: Partial<Version>): Version =>
  ({
    n: 2,
    status: 'ready',
    attempts: 1,
    output: { durationSec: 32, width: 1920, height: 1080, bytes: 1, title: 't', summary: 's', notices: [] },
    usage: { totalCreditsCost: 168.4 },
    credits: [],
    publications: [],
    error: null,
    timings: null,
    ...o,
  }) as unknown as Version

describe('comment', () => {
  const d = {
    marker: { videoId: 'vid_1' },
    webUrl: 'https://v.acme.com/videos/vid_1',
    features: [] as string[],
  }
  const render = (s: CommentState, features: string[] = []) => renderComment(s, { ...d, features })
  it('renders every state with the marker first', () => {
    const states: CommentState[] = [
      { kind: 'started', revision: 1 },
      { kind: 'started', revision: 3 },
      { kind: 'running', revision: 1, since: '2026-11-05T14:02:11Z' },
      { kind: 'ready', version: version({}) },
      {
        kind: 'ready',
        version: version({
          publications: [
            {
              unpublishedAt: null,
              urls: {
                page: 'https://v/v/s',
                mp4: 'https://v/v/s.mp4',
                gif: 'https://v/v/s.gif',
                poster: 'https://v/v/s.jpg',
                captions: '',
              },
            },
          ] as never,
          credits: [
            {
              role: 'Music',
              title: 'Calm Piano',
              creator: 'Ada',
              creatorUrl: null,
              licenseLabel: 'CC BY 4.0',
              licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
              sourceUrl: 'https://jamendo.com/t/1',
            },
          ] as never,
        }),
      },
      {
        kind: 'failed',
        version: version({
          status: 'failed',
          error: { category: 'terminal', message: 'The agent crashed.' },
          usage: { totalCreditsCost: 5 },
          output: null,
        }),
        retriesLeft: true,
      },
      {
        kind: 'failed',
        version: version({ status: 'timed_out', attempts: 2, error: null, output: null }),
        retriesLeft: false,
      },
      { kind: 'still', minutes: 45, version: undefined },
      { kind: 'limit', maxVersions: 5 },
      { kind: 'budget', cap: 'max-runs-per-day', used: 10, limit: 10 },
    ]
    const all = states.map((s) => render(s))
    for (const text of all) expect(text.split('\n')[0]).toBe('<!-- video-agent:v1 {"videoId":"vid_1"} -->')
    expect(all).toMatchSnapshot()
    expect(all[3]).toContain(
      '**Ready:** [Open in Video Agent](https://v.acme.com/videos/vid_1) (sign in to watch) · 0:32 · v2 · 168 credits',
    )
    expect(all[5]).toContain('at least 5 credits')
    expect(all[6]).toContain('No retries left')
    expect(all[7]).toContain('after 45 minutes')
    expect(all[8]).toContain('already has 5 versions')
  })

  it('offers /video redo only when the server has scoped_revision', () => {
    expect(render({ kind: 'ready', version: version({}) })).not.toContain('/video redo')
    expect(render({ kind: 'ready', version: version({}) }, ['scoped_revision'])).toContain('/video redo')
  })
})

describe('commands', () => {
  it('parses each command; revise takes the rest of the comment', () => {
    expect(parseCommand('/video', 1)).toEqual({ kind: 'video' })
    expect(parseCommand('/video  \n', 1)).toEqual({ kind: 'video' })
    expect(parseCommand('/video revise make the end card orange\nand bigger', 7)).toEqual({
      kind: 'revise',
      change: 'make the end card orange\nand bigger',
      commentId: 7,
    })
    expect(parseCommand('/video   STATUS', 1)).toEqual({ kind: 'status' })
    expect(parseCommand('/video publish', 1)).toEqual({ kind: 'publish' })
    expect(parseCommand('/video retry', 1)).toEqual({ kind: 'retry' })
    expect(parseCommand('/video cancel\r\n', 1)).toEqual({ kind: 'cancel' })
    expect(parseCommand('/video revise', 1)).toEqual({ kind: 'revise', change: '', commentId: 1 })
    expect(parseCommand('/video dance', 1)).toEqual({ kind: 'unknown', word: 'dance' })
  })
})

describe('screenshots', () => {
  it('finds markdown and HTML images in order, and sniffs types from bytes', () => {
    const body =
      'a ![first shot](https://img.example.com/1.png) b <img width="10" src="https://github.com/user-attachments/assets/abc" alt="second"> c ![](https://img.example.com/3.jpg)'
    expect(imageLinks(body)).toEqual([
      { url: 'https://img.example.com/1.png', alt: 'first shot' },
      { url: 'https://github.com/user-attachments/assets/abc', alt: 'second' },
      { url: 'https://img.example.com/3.jpg', alt: '' },
    ])
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('png')
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniff(new TextEncoder().encode('GIF89a'))).toBe('gif')
    expect(sniff(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniff(new TextEncoder().encode('<svg'))).toBeNull()
  })
})
