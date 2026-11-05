// video-agent scenes, revise --scene and redo against the real routes (regenerate-beat plan §4.13; bead va-8cy4.5.2):
// scenes lists ids, labels and times (filling an older version's), --scene takes ids or labels and repeats, redo is
// hidden without scoped_revision (exit 9), not_editable exits 7, every scene exits 2, idempotency and --wait.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../packages/cli/src/exit.js'
import { registerScopeCheck, resetScopeChecks } from '../src/domain/engines.js'
import { load, save } from '../src/lib/contract.js'
import { hyperframesScopeCheck, spliceBytes, spliceScoped } from '../src/lib/scope.js'
import { cli } from './cli-io.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary = { title: 't', captions: [] }
const archive = (html: string, s = JSON.stringify(summary)) =>
  tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: s },
  ])

/** A 9 s MP4, as long as the fixture's composition: finalize checks a scoped version's length. */
let mp4 = new Uint8Array()
beforeAll(() => {
  const out = join(mkdtempSync(join(tmpdir(), 'va-cli-scenes-')), 'v.mp4')
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1920x1080:r=30:d=9',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    out,
  ])
  mp4 = new Uint8Array(readFileSync(out))
}, 60_000)
beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

async function ready(h: Harness) {
  h.deps.nextSource = archive(music)
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}
const lastRevise = async (requests: Request[]) => {
  const r = requests.filter((x) => x.method === 'POST' && /\/versions$/.test(new URL(x.url).pathname)).at(-1)
  return r ? ((await r.clone().json()) as Record<string, unknown>) : null
}

describe('video-agent scenes', () => {
  it('lists ids, labels and times, filling an older version’s scenes', async () => {
    const h = harness()
    const id = await ready(h)
    await h.deps.store.updateVersion(id, 1, { beats: null })
    const { run } = await cli(h)
    const text = await run(['scenes', id])
    expect(text.code).toBe(0)
    expect(text.stdout).toBe('1. intro  Opening  0:00–0:03\n2. demo  0:03–0:06\n3. outro  0:06–0:09\n')
    const json = await run(['scenes', id, '--json'])
    expect(json.json()).toMatchObject({
      videoId: id,
      version: 1,
      scenes: [{ id: 'intro', label: 'Opening' }, {}, {}],
    })
    expect((await h.deps.store.getVersion(id, 1))?.beats).toHaveLength(3)
  })
})

describe('video-agent revise --scene and redo', () => {
  it('takes ids or labels (case-insensitive), repeats, and sends scope with fromVersion', async () => {
    const h = harness()
    const id = await ready(h)
    const { run, requests } = await cli(h)
    const r = await run([
      'revise',
      id,
      '--scene',
      'OPENING',
      '--scene',
      'outro',
      'Make it brighter.',
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(await lastRevise(requests)).toMatchObject({
      prompt: 'Make it brighter.',
      fromVersion: 1,
      scope: { beats: ['intro', 'outro'] },
    })
    expect(r.json().versions[0].scope).toEqual({
      beats: [
        { id: 'intro', label: 'Opening' },
        { id: 'outro', label: 'outro' },
      ],
    })
  })

  it('an unknown scene and every scene exit 2 with the list; not_editable exits 7', async () => {
    const h = harness()
    const id = await ready(h)
    const { run } = await cli(h)
    const unknown = await run(['redo', id, '--scene', 'feature', 'Redo it.'])
    expect(unknown.code).toBe(EXIT.usage)
    expect(unknown.stderr).toContain(
      `There's no scene "feature". This version's scenes: intro (Opening), demo, outro.`,
    )
    const every = await run([
      'redo',
      id,
      '--scene',
      'intro',
      '--scene',
      'demo',
      '--scene',
      'outro',
      'Redo it.',
    ])
    expect(every.code).toBe(EXIT.usage)
    expect(every.stderr).toContain("That's every scene")
    await h.deps.store.updateVersion(id, 1, { contract: null })
    const locked = await run(['redo', id, '--scene', 'demo', 'Redo it.'])
    expect(locked.code).toBe(EXIT.conflict)
  })

  it('redo is hidden and refused (exit 9) without scoped_revision', async () => {
    const h = harness()
    const id = await ready(h)
    resetScopeChecks()
    const { run } = await cli(h)
    expect((await run(['--help'])).stdout).not.toMatch(/^\s+redo\b/m)
    const r = await run(['redo', id, '--scene', 'demo', 'Redo it.'])
    expect(r.code).toBe(EXIT.unsupported)
    expect((await run(['revise', id, '--scene', 'demo', 'Redo it.'])).code).toBe(EXIT.unsupported)
  })

  it('an --idempotency-key replay returns the same version, and --wait follows it to ready', async () => {
    const h = harness()
    const id = await ready(h)
    const { run } = await cli(h, { drive: true })
    const spliced = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: music, summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    h.deps.nextSource = archive(spliced['index.html'], spliced['summary.json'])
    h.deps.nextExtra = { files: { 'video.mp4': mp4 } }
    const argv = ['redo', id, '--scene', 'demo', 'Redo the demo.', '--idempotency-key', 'k-redo', '--json']
    const a = await run(argv)
    const b = await run(argv)
    expect(a.code).toBe(0)
    expect(b.json().latestVersion).toBe(a.json().latestVersion)
    expect((await h.deps.store.listVersions(id)).length).toBe(2)
    const waited = await run(['wait', id, '--json'])
    expect(waited.code).toBe(0)
    expect(waited.json().versions[0]).toMatchObject({
      n: 2,
      status: 'ready',
      scope: { beats: [{ id: 'demo' }] },
    })
  })
})
