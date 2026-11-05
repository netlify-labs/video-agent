// One CLI over the run's engine (render-engines plan §4.3): the engine the run manifest names, or --engine in local
// mode, HyperFrames when neither says.
//   npx tsx scripts/engine.ts check                 the engine's checks; exits 1 on any error
//   npx tsx scripts/engine.ts snapshot --at 1,3,5   stills at those seconds (all in one call: each one is a render)
//   npx tsx scripts/engine.ts render                render-job renders runs; this says so (local mode, CLI plan)
//   npx tsx scripts/engine.ts mix                   the music level (HyperFrames: normalize-audio; Remotion: 3.10)
// HyperFrames hands each command to its own CLI, which its skill's work loop already teaches. Prints one JSON line as
// its last line for the Remotion engine.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isEngineId, type EngineId } from '../src/domain/engines.js'
import { remotionEngine } from './lib/engines/remotion.js'
import type { RunEngine } from './lib/engines/types.js'
import { repoRoot, StepError } from './lib/run-tools.js'

export interface EngineCliDeps {
  root: string
  /** The Remotion engine (tests pass a stub). */
  remotion: () => Pick<RunEngine, 'check' | 'snapshot'>
  /** Runs a command with the output passed through, returning its exit code. */
  spawn: (cmd: string, args: string[], cwd: string) => number
  out: (line: string) => void
}

const USAGE =
  'Usage: engine.ts check | snapshot --at <seconds,…> | render | mix [--engine hyperframes|remotion]'

/** The engine: --engine, else the run manifest's, else HyperFrames. */
export function engineOf(root: string, argv: string[]): EngineId {
  const flag = argv.indexOf('--engine')
  const asked = flag >= 0 ? argv[flag + 1] : undefined
  if (asked !== undefined) {
    if (!isEngineId(asked)) throw new StepError(`Unknown engine "${asked}". ${USAGE}`)
    return asked
  }
  const path = join(root, '.render', 'run-manifest.json')
  const id = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { engine?: { id?: unknown } }).engine?.id
    : undefined
  if (id === undefined) return 'hyperframes'
  if (!isEngineId(id))
    throw new StepError(`The run manifest names an unknown engine (${JSON.stringify(id)}).`)
  return id
}

/** The seconds after --at: positive numbers, comma-separated. */
export function secondsOf(argv: string[]): number[] {
  const at = argv[argv.indexOf('--at') + 1]
  const list = argv.includes('--at') && at ? at.split(',').map(Number) : []
  if (!list.length || list.some((n) => !Number.isFinite(n) || n < 0))
    throw new StepError('snapshot needs --at with the seconds to capture, like --at 1,3.5,8.')
  return list
}

export async function runEngineCli(argv: string[], d: EngineCliDeps): Promise<number> {
  const cmd = argv[0]
  const video = join(d.root, 'video')
  const engine = engineOf(d.root, argv)
  if (engine === 'hyperframes') {
    if (cmd === 'check') return d.spawn('npx', ['hyperframes', 'check'], video)
    if (cmd === 'snapshot')
      return d.spawn('npx', ['hyperframes', 'snapshot', '--at', secondsOf(argv).join(',')], video)
    if (cmd === 'mix')
      return d.spawn(
        'npx',
        ['hyperframes', 'normalize-audio', '--target=music', '--lufs=-14', '--write'],
        video,
      )
    if (cmd === 'render') {
      d.out('Runs render with scripts/render-job.ts, exactly as your prompt says.')
      return 2
    }
    d.out(USAGE)
    return 2
  }
  const r = d.remotion()
  if (cmd === 'check' && r.check) {
    const res = await r.check(video)
    for (const e of res.errors) d.out(`error: ${e}`)
    d.out(
      JSON.stringify({
        step: 'engine.check',
        engine,
        errors: res.errors.length,
        warnings: res.warnings.length,
      }),
    )
    return res.errors.length ? 1 : 0
  }
  if (cmd === 'snapshot' && r.snapshot) {
    const files = await r.snapshot(video, secondsOf(argv))
    d.out(JSON.stringify({ step: 'engine.snapshot', engine, files }))
    return 0
  }
  if (cmd === 'render') {
    d.out('Runs render with scripts/render-job.ts, exactly as your prompt says.')
    return 2
  }
  if (cmd === 'mix') {
    d.out('engine_unavailable: mix for Remotion arrives with va-ed2s.3.10.')
    return 2
  }
  d.out(USAGE)
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  try {
    process.exit(
      await runEngineCli(process.argv.slice(2), {
        root: repoRoot,
        remotion: () => remotionEngine(),
        spawn: (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1,
        out: (l) => {
          console.log(l)
        },
      }),
    )
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
