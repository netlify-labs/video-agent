// Screen recordings in a run, and in the CLI's local mode (screen-recording plan §5.2). One script, subcommands; each
// prints a JSON result on stdout and logs every stage with its timing (scripts/lib/run-tools.ts log) on stderr.
//
//   npx tsx scripts/recording.ts analyze (--media <id> | --file <path>) [--trace <trace.json>] [--out <analysis.json>]
//     [--context <dir>] [--no-transcript]
//
// analyze: refuses a recording that isn't normalized (§4.2) with the reason, then writes what happens in it (idle,
// scene changes, activity, the cursor and clicks: times and positions only, no names) to
// video/assets/recording/analysis.json. --media finds the library file in video/assets/media/ (<id>.<ext>); the
// trace, when the recording has one, is .va-run/recording/<id>/trace.json unless --trace says otherwise. An
// analysis.json for the same bytes and analyzer version is reused. Contact sheets per scene and, when the recording
// has speech, an on-device transcript go to context/recording/<id>/ (or --context): for the agent to read, never
// archived (scripts/lib/recording-extras.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { parseTrace } from '../src/lib/recording-trace.js'
import { analyzeRecording } from './lib/recording-analyze.js'
import { cachedAnalysis, makeSheets, transcribeRecording } from './lib/recording-extras.js'
import { log, parseArgs, repoRoot, sha256File, StepError } from './lib/run-tools.js'
import { parakeet } from './lib/stt/parakeet.js'

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
  const id = args.media ?? basename(file, extname(file))
  const context = args.context ?? join(repoRoot, 'context', 'recording', id)
  const cached = cachedAnalysis(out, sha256File(file))
  log('recording.analyze_cache', { hit: Boolean(cached) })
  const analysis = cached ?? (await analyzeRecording(file, trace))
  if (!cached) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(analysis)}\n`)
  }
  const sheets = makeSheets(file, analysis, join(context, 'sheets'))
  // The transcript isn't redone on a cache hit when it's there already: same bytes, same words.
  const transcriptPath = join(context, 'transcript.json')
  const words =
    'no-transcript' in args || (cached && existsSync(transcriptPath))
      ? null
      : await transcribeRecording(file, transcriptPath, parakeet(), {
          workDir: join(repoRoot, '.va-run', 'recording', id, 'stt'),
          cwd: join(repoRoot, 'video'),
          deadlineAt: Date.now() + 10 * 60_000,
        })
  return {
    ok: true,
    out,
    cached: Boolean(cached),
    sheets: sheets.length,
    transcript: existsSync(transcriptPath) ? { path: transcriptPath, words: words?.length ?? null } : null,
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
