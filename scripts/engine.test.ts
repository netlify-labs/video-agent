// scripts/engine.ts: which engine a command goes to, HyperFrames' delegation to its own CLI, and Remotion's check and
// snapshot through a stub engine.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineOf, runEngineCli, secondsOf } from './engine.js'

function root(engine?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'va-engcli-'))
  mkdirSync(join(dir, '.render'))
  writeFileSync(join(dir, '.render', 'run-manifest.json'), JSON.stringify(engine ? { engine } : {}))
  return dir
}

function cli(dir: string, check = { errors: [] as string[], warnings: [] as string[] }) {
  const spawned: string[][] = []
  const out: string[] = []
  const asked: unknown[] = []
  const deps = {
    root: dir,
    remotion: () => ({
      check: (v: string) => {
        asked.push(['check', v])
        return Promise.resolve(check)
      },
      snapshot: (v: string, at: number[]) => {
        asked.push(['snapshot', v, at])
        return Promise.resolve(at.map((s) => `${v}/.render/snapshots/${s}.png`))
      },
    }),
    mix: () => ({ lufsSrc: -20, truePeakSrc: -6, volume: 1.995, truePeakAtGain: 0, clamped: false }),
    spawn: (cmd: string, args: string[], cwd: string) => {
      spawned.push([cwd.endsWith('/video') ? 'video/' : cwd, cmd, ...args])
      return 0
    },
    out: (l: string) => out.push(l),
  }
  return { deps, spawned, out, asked }
}

describe('engine.ts', () => {
  it('picks --engine, else the run manifest’s, else HyperFrames', () => {
    expect(engineOf(root(), ['check'])).toBe('hyperframes')
    expect(engineOf(root({ id: 'remotion' }), ['check'])).toBe('remotion')
    expect(engineOf(root({ id: 'remotion' }), ['check', '--engine', 'hyperframes'])).toBe('hyperframes')
    expect(() => engineOf(root(), ['check', '--engine', 'lottie'])).toThrow(/Unknown engine "lottie"/)
    expect(() => engineOf(root({ id: 'lottie' }), ['check'])).toThrow(/unknown engine/)
  })

  it('reads the seconds to snapshot', () => {
    expect(secondsOf(['snapshot', '--at', '1,3.5,8'])).toEqual([1, 3.5, 8])
    expect(() => secondsOf(['snapshot'])).toThrow(/--at/)
    expect(() => secondsOf(['snapshot', '--at', '1,x'])).toThrow(/--at/)
  })

  it('hands HyperFrames commands to its own CLI in video/', async () => {
    const c = cli(root())
    expect(await runEngineCli(['check'], c.deps)).toBe(0)
    expect(await runEngineCli(['snapshot', '--at', '1,2'], c.deps)).toBe(0)
    expect(await runEngineCli(['mix'], c.deps)).toBe(0)
    expect(c.spawned).toEqual([
      ['video/', 'npx', 'hyperframes', 'check'],
      ['video/', 'npx', 'hyperframes', 'snapshot', '--at', '1,2'],
      ['video/', 'npx', 'hyperframes', 'normalize-audio', '--target=music', '--lufs=-14', '--write'],
    ])
    expect(await runEngineCli(['render'], c.deps)).toBe(2)
    expect(c.out.at(-1)).toContain('render-job.ts')
  })

  it('runs Remotion’s check and snapshot, exiting 1 when the check finds errors', async () => {
    const ok = cli(root({ id: 'remotion' }))
    expect(await runEngineCli(['check'], ok.deps)).toBe(0)
    expect(JSON.parse(ok.out.at(-1) ?? '{}')).toMatchObject({
      step: 'engine.check',
      engine: 'remotion',
      errors: 0,
    })
    expect(await runEngineCli(['snapshot', '--at', '0.5,2'], ok.deps)).toBe(0)
    expect(JSON.parse(ok.out.at(-1) ?? '{}').files).toHaveLength(2)
    expect(ok.spawned).toEqual([])
    const bad = cli(root({ id: 'remotion' }), { errors: ['props.json.fps must be 30.'], warnings: [] })
    expect(await runEngineCli(['check'], bad.deps)).toBe(1)
    expect(bad.out[0]).toBe('error: props.json.fps must be 30.')
  })

  it('points render at render-job, and sets Remotion’s music level', async () => {
    const c = cli(root({ id: 'remotion' }))
    expect(await runEngineCli(['render'], c.deps)).toBe(2)
    expect(c.out.at(-1)).toContain('render-job.ts')
    expect(await runEngineCli(['mix'], c.deps)).toBe(0)
    expect(JSON.parse(c.out.at(-1) ?? '{}')).toMatchObject({
      step: 'engine.mix',
      engine: 'remotion',
      volume: 1.995,
    })
    expect(await runEngineCli(['nope'], c.deps)).toBe(2)
  })
})
