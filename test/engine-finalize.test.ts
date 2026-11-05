// Finalize checks the engine twice (render-engines plan §4.2): the one the run's manifest names, and the shape of the
// composition it saved. Either mismatch fails the attempt with engine_mismatch before anything becomes a version.
import { describe, expect, it } from 'vitest'
import { bundleShapeProblems } from '../src/domain/bundles.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const make = async (h: Harness) => {
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return (await h.json(await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }))).versions[0] as {
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

describe('bundle shape per engine', () => {
  const files = (...paths: string[]) => new Map(paths.map((p) => [p, new Uint8Array()]))
  it('HyperFrames needs index.html', () => {
    expect(bundleShapeProblems('hyperframes', files('index.html', 'summary.json'))).toEqual([])
    expect(bundleShapeProblems('hyperframes', files('props.json'))).toHaveLength(1)
  })
  it('Remotion needs props.json and src/Root.tsx, and no index.html', () => {
    expect(bundleShapeProblems('remotion', files('props.json', 'src/Root.tsx', 'summary.json'))).toEqual([])
    expect(bundleShapeProblems('remotion', files('index.html'))).toEqual([
      'There is no props.json at the top of video/.',
      'There is no src/Root.tsx in video/.',
      'video/index.html belongs to a HyperFrames composition.',
    ])
  })
})
