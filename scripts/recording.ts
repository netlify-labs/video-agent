// Screen recordings in a run, and in the CLI's local mode (screen-recording plan §5.2). One script, subcommands; each
// prints a JSON result on stdout and logs every stage with its timing (scripts/lib/run-tools.ts log) on stderr.
//
//   npx tsx scripts/recording.ts analyze (--media <id> | --file <path>) [--trace <trace.json>] [--out <analysis.json>]
//
// analyze: refuses a recording that isn't normalized (§4.2) with the reason, then writes what happens in it (idle,
// scene changes, activity, the cursor and clicks: times and positions only, no names) to
// video/assets/recording/analysis.json. --media finds the library file in video/assets/media/ (<id>.<ext>); the
// trace, when the recording has one, is .va-run/recording/<id>/trace.json unless --trace says otherwise.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseTrace } from '../src/lib/recording-trace.js'
import { analyzeRecording } from './lib/recording-analyze.js'
import { log, parseArgs, repoRoot, StepError } from './lib/run-tools.js'

const [command, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)

/** The library file for a media id in a run's composition. */
function mediaFile(id: string) {
  const dir = join(repoRoot, 'video', 'assets', 'media')
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${id}.`)) : undefined
  if (!name) throw new StepError(`No file for ${id} in video/assets/media/.`)
  return join(dir, name)
}

async function analyze() {
  const file = args.file ?? (args.media ? mediaFile(args.media) : null)
  if (!file) throw new StepError('analyze needs --media <id> or --file <path>.')
  const tracePath =
    args.trace ?? (args.media ? join(repoRoot, '.va-run', 'recording', args.media, 'trace.json') : undefined)
  const trace = tracePath && existsSync(tracePath) ? parseTrace(readFileSync(tracePath, 'utf8')) : null
  const out = args.out ?? join(repoRoot, 'video', 'assets', 'recording', 'analysis.json')
  const analysis = await analyzeRecording(file, trace)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(analysis)}\n`)
  return {
    ok: true,
    out,
    cursorSource: analysis.cursorSource,
    idle: analysis.idle,
    scenes: analysis.scenes,
    clicks: analysis.clicks.length,
  }
}

const commands: Record<string, () => Promise<unknown>> = { analyze }

try {
  const run = command ? commands[command] : undefined
  if (!run) throw new StepError(`Usage: recording.ts <${Object.keys(commands).join('|')}> …`)
  console.log(JSON.stringify(await run()))
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  log('recording.failed', { command, message })
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}
