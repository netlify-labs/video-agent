// Finalize checks the engine twice (render-engines plan §4.2): the one the run's manifest names, and the shape of the
// composition it saved. Either mismatch fails the attempt with engine_mismatch before anything becomes a version.
import { describe, expect, it } from 'vitest'
import { bundleShapeProblems } from '../src/domain/bundles.js'
import { engineFailureOf } from '../src/domain/finalize.js'
import { getSettings } from '../src/domain/settings.js'
import { running, succeeded } from './fakes.js'
import { harness, pgStore, PROMPT, readyVideo, type Harness } from './helpers.js'
import { remotionBundle, templateFiles } from './remotion-files.js'
import { tarGz } from './tarball.js'

const make = async (h: Harness) => {
  const id = await readyVideo(h)
  return (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).versions[0] as {
    status: string
    error: { category: string; message: string } | null
  }
}
const mismatchLog = (h: Harness) =>
  h.deps.logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.event === 'finalize.engine_mismatch')

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('finalize engine checks (%s)', (_name, stores) => {
  it('a HyperFrames run finalizes as before, and its manifest may name its engine', async () => {
    const h = harness({}, await stores())
    h.deps.nextExtra = { manifest: { engine: { id: 'hyperframes', version: '0.8.222' } } }
    expect(await make(h)).toMatchObject({ status: 'ready', error: null })
    expect(mismatchLog(h)).toBeUndefined()
  })

  it('a manifest naming another engine fails the attempt', async () => {
    const h = harness({}, await stores())
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    expect(await make(h)).toMatchObject({
      status: 'failed',
      error: {
        category: 'engine_mismatch',
        message: 'The run produced a Remotion project for a HyperFrames video.',
      },
    })
    expect(mismatchLog(h)).toMatchObject({
      expected: 'hyperframes',
      got: 'remotion',
      attemptId: expect.any(String),
    })
  })

  it('a HyperFrames run that saved no index.html fails, naming the missing file', async () => {
    const h = harness({}, await stores())
    h.deps.nextSource = tarGz([
      { name: 'video/props.json', body: '{}' },
      { name: 'video/summary.json', body: '{}' },
    ])
    expect(await make(h)).toMatchObject({
      status: 'failed',
      error: {
        category: 'engine_mismatch',
        message: "The run didn't save a HyperFrames project: There is no index.html at the top of video/.",
      },
    })
    expect(mismatchLog(h)).toMatchObject({ problems: ['There is no index.html at the top of video/.'] })
  })
})

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('a Remotion video end to end (%s)', { timeout: 20_000 }, (_name, stores) => {
  async function remotionHarness() {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await getSettings(h.deps)
    await h.deps.store.updateSettings({
      remotionEnabled: true,
      remotionLicenseAck: {
        by: 'u_admin',
        email: 'admin@acme.com',
        at: '2026-11-05T00:00:00Z',
        tier: 'free',
        note: null,
      },
    })
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    return h
  }
  /** A video whose first version is Remotion's (paused, so nothing starts it first; choosing it on create is 3.4's). */
  async function create(h: Harness) {
    await h.deps.store.updateSettings({ queuePausedReason: 'test' })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.deps.store.updateVersion(v.id, 1, { engine: 'remotion' })
    await h.deps.store.updateSettings({ queuePausedReason: null })
    return v.id as string
  }
  const versions = async (h: Harness, id: string) =>
    (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).versions as {
      n: number
      status: string
      editable: boolean
      error: { category: string; message: string } | null
    }[]

  it('creates to ready, not editable, and a revision keeps the engine and finalizes too', async () => {
    const h = await remotionHarness()
    h.deps.nextSource = tarGz(remotionBundle())
    const id = await create(h)
    await h.drive(4)
    expect((await versions(h, id)).find((v) => v.n === 1)).toMatchObject({ status: 'ready', editable: false })
    h.deps.nextSource = tarGz(remotionBundle())
    h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540' } } }
    await h.call('POST', `/api/v1/videos/${id}/versions`, { as: h.member, body: { prompt: 'Warmer.' } })
    await h.drive(4)
    expect((await versions(h, id)).find((v) => v.n === 2)).toMatchObject({ status: 'ready', editable: false })
    expect((await h.deps.store.getVersion(id, 2))?.engine).toBe('remotion')
  })

  it('a run that stopped on an engine error fails soon, under that code', async () => {
    const h = await remotionHarness()
    const id = await create(h)
    h.deps.runner.nextScripts.push({
      timeline: [
        running(),
        succeeded(
          'Nothing was rendered.\n\nprepare-run stopped: engine_install_failed: npm ci timed out after 180 s\nI stopped as instructed.',
        ),
      ],
    })
    await h.drive(6)
    expect((await versions(h, id))[0]).toMatchObject({
      status: 'failed',
      error: {
        category: 'engine_install_failed',
        message: 'prepare-run stopped: engine_install_failed: npm ci timed out after 180 s',
      },
    })
  })

  it('a tampered project fails engine_mismatch, naming the file, with every problem logged', async () => {
    const h = await remotionHarness()
    h.deps.nextSource = tarGz(remotionBundle({ 'babel.config.js': 'module.exports = {}' }))
    const id = await create(h)
    await h.drive(4)
    const [v1] = await versions(h, id)
    expect(v1).toMatchObject({ status: 'failed', error: { category: 'engine_mismatch' } })
    expect(v1?.error?.message).toContain('babel.config.js')
    expect(mismatchLog(h)).toMatchObject({
      problems: expect.arrayContaining([expect.stringContaining('babel.config.js')]),
    })
  })
})

describe('engineFailureOf', () => {
  it.each([
    ["engine_tampered: src/Root.tsx doesn't match the template", 'engine_tampered'],
    ['engine_install_failed: npm ci exited 1', 'engine_install_failed'],
    ['engine_skills_unavailable: the pinned skills archive is missing', 'engine_skills_unavailable'],
    ['engine_check_failed: run npx tsx scripts/engine.ts check and fix:', 'engine_check_failed'],
    ['engine_license_key_missing: VIDEO_AGENT_REMOTION_KEY is not set', 'engine_unavailable'],
  ])('%s -> %s', (line, category) => {
    expect(engineFailureOf(`Stopped.\n\n${line}\nNothing else ran.`)).toEqual({ category, message: line })
  })

  it('is null for anything else, an unknown engine code included', () => {
    expect(engineFailureOf('The run ended without a callback.')).toBeNull()
    expect(engineFailureOf('engine_unheard_of: what')).toBeNull()
    expect(engineFailureOf(null)).toBeNull()
  })
})

describe('bundle shape per engine', () => {
  const files = (...paths: string[]) => new Map(paths.map((p) => [p, new Uint8Array()]))
  it('HyperFrames needs index.html', () => {
    expect(bundleShapeProblems('hyperframes', files('index.html', 'summary.json'))).toEqual([])
    expect(bundleShapeProblems('hyperframes', files('props.json'))).toHaveLength(1)
  })
  it('Remotion needs props.json and src/Root.tsx, and no index.html', () => {
    expect(bundleShapeProblems('remotion', templateFiles())).toEqual([])
    expect(bundleShapeProblems('remotion', files('index.html'))).toEqual([
      'There is no props.json at the top of video/.',
      'There is no src/Root.tsx in video/.',
      'video/index.html belongs to a HyperFrames composition.',
    ])
  })

  it.each([
    ['an extra babel.config.js', { 'babel.config.js': 'module.exports = {}' }, 'babel.config.js'],
    ['a changed src/Root.tsx', { 'src/Root.tsx': 'export const Root = () => null' }, 'src/Root.tsx'],
    ['a stale registry', { 'src/registry.ts': 'export const beats = {}\n' }, 'src/registry.ts'],
    ['props.json that breaks its schema', { 'props.json': '{"contract":1}' }, 'props.json'],
  ])('Remotion: %s is refused, naming the file', (_label, changes, file) => {
    const all = templateFiles()
    for (const [p, body] of Object.entries(changes)) all.set(p, new TextEncoder().encode(body))
    const problems = bundleShapeProblems('remotion', all)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toContain(file)
  })
})
