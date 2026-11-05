import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StepError } from '../run-tools.js'
import { hyperframesEngine, type Exec } from './hyperframes.js'
import { engineReport, runEngineFor, runEngineIdFromManifest } from './index.js'

const fx = (f: string) =>
  readFileSync(new URL(`../../../test/fixtures/contract1/${f}`, import.meta.url), 'utf8')
const renderOutput = readFileSync(
  new URL('../../../test/fixtures/hyperframes-render.txt', import.meta.url),
  'utf8',
)

function videoDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'va-engine-'))
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body)
  return dir
}

/** Records what would have been spawned, and plays back the given output. */
function stubExec(output = '', version = '0.8.222') {
  const calls: { cmd: string; args: string[]; cwd: string | undefined }[] = []
  const exec: Exec = {
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd })
      return `npm warn something\n${version}\n`
    },
    runStreaming: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd })
      for (const line of output.split('\n')) opts?.onOutput?.(`${line}\n`)
      return Promise.resolve(output)
    },
  }
  return { exec, calls }
}

describe('HyperFrames run engine', () => {
  it('renders with exactly the command render-job ran before, and forwards rising percentages', async () => {
    const { exec, calls } = stubExec(renderOutput)
    const dir = videoDir()
    const sent: number[] = []
    expect(
      await hyperframesEngine(exec).render(dir, '/out/video.mp4', 'standard', (p) => sent.push(p)),
    ).toEqual({})
    expect(calls).toEqual([
      {
        cmd: 'npx',
        args: ['-y', 'hyperframes', 'render', '--quality', 'standard', '--output', '/out/video.mp4'],
        cwd: dir,
      },
    ])
    expect(sent.length).toBeGreaterThan(5)
    expect([...sent].sort((a, b) => a - b)).toEqual(sent)
    expect(new Set(sent).size).toBe(sent.length)
  })

  it('reads its version from the last line npx prints', () => {
    const { exec, calls } = stubExec('', '0.8.222')
    const dir = videoDir()
    expect(hyperframesEngine(exec).version(dir)).toBe('0.8.222')
    expect(calls).toEqual([{ cmd: 'npx', args: ['-y', 'hyperframes', '--version'], cwd: dir }])
  })

  it('says to write the composition when there is none', () => {
    const engine = hyperframesEngine(stubExec().exec)
    expect(engine.entryProblems(videoDir())).toEqual([
      'video/index.html does not exist. Write the composition first.',
    ])
    expect(engine.entryProblems(videoDir({ 'index.html': '<div></div>' }))).toEqual([])
  })

  it('checks the editing contract with the messages render-job gave before', () => {
    const engine = hyperframesEngine(stubExec().exec)
    const html = fx('index.html')
    const summary = fx('summary.json')
    expect(engine.contract(videoDir({ 'index.html': html, 'summary.json': summary }))).toEqual([])
    expect(
      engine.contract(videoDir({ 'index.html': '<div id="root"></div>', 'summary.json': summary })),
    ).toBeNull()
    const broken = engine.contract(
      videoDir({
        'index.html': html.replace('data-track-index="0"', 'data-track-index="3"'),
        'summary.json': summary,
      }),
    )
    expect(broken).toHaveLength(1)
    expect(broken?.[0]).toMatch(
      /^The composition breaks the editing contract \(see "Editing contract v1" in video\/AGENTS\.md\):\n- /,
    )
    const revoice = engine.contract(
      videoDir({
        'index.html': html.replace('data-va-contract="1"', 'data-va-contract="1" data-va-revoice'),
        'summary.json': summary,
      }),
    )
    expect(revoice).toEqual([
      'Some narration lines are still marked for re-voicing (data-va-revoice). Run npx tsx scripts/voice.ts revoice first.',
    ])
  })
})

describe('picking the run engine', () => {
  function root(manifest?: object) {
    const dir = mkdtempSync(join(tmpdir(), 'va-root-'))
    if (manifest) {
      mkdirSync(join(dir, '.render'))
      writeFileSync(join(dir, '.render', 'run-manifest.json'), JSON.stringify(manifest))
    }
    return dir
  }

  it('is HyperFrames without a manifest, with one for another attempt, or one that names no engine', () => {
    expect(runEngineIdFromManifest(root(), 'att_1')).toBe('hyperframes')
    expect(runEngineIdFromManifest(root({ attemptId: 'att_2', engine: { id: 'remotion' } }), 'att_1')).toBe(
      'hyperframes',
    )
    expect(runEngineIdFromManifest(root({ attemptId: 'att_1' }), 'att_1')).toBe('hyperframes')
  })

  it('follows the engine the manifest names, and stops on an unknown one', () => {
    expect(runEngineIdFromManifest(root({ attemptId: 'att_1', engine: { id: 'remotion' } }), 'att_1')).toBe(
      'remotion',
    )
    expect(() =>
      runEngineIdFromManifest(root({ attemptId: 'att_1', engine: { id: 'lottie' } }), 'att_1'),
    ).toThrow(StepError)
  })

  it('has only HyperFrames to run in Phase 1', () => {
    expect(runEngineFor('hyperframes').id).toBe('hyperframes')
    expect(() => runEngineFor('remotion')).toThrow(/can't render Remotion videos yet/)
  })

  it('reports the engine for the manifest, with render counts only when it has them', () => {
    expect(engineReport({ id: 'hyperframes' }, '0.8.222', {})).toEqual({
      id: 'hyperframes',
      version: '0.8.222',
    })
    const renders = { video: 1, stills: 6, audio: 0 }
    expect(engineReport({ id: 'remotion' }, '4.0.540', { renders })).toEqual({
      id: 'remotion',
      version: '4.0.540',
      renders,
    })
  })
})
