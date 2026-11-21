// Screen recordings in a run, and in the CLI's local mode (screen-recording plan §5.2). One script, subcommands; each
// prints a JSON result on stdout and logs every stage with its timing (scripts/lib/run-tools.ts log) on stderr.
//
//   npx tsx scripts/recording.ts analyze (--media <id> | --file <path>) [--trace <trace.json>] [--out <analysis.json>]
//     [--context <dir>] [--no-transcript] [--crop x,y,width,height]
//
// analyze: refuses a recording that isn't normalized (§4.2) with the reason, then writes what happens in it (idle,
// scene changes, activity, the cursor and clicks: times and positions only, no names) to
// video/assets/recording/analysis.json. --media finds the library file in video/assets/media/ (<id>.<ext>); the
// trace, when the recording has one, is .va-run/recording/<id>/trace.json unless --trace says otherwise. An
// analysis.json for the same bytes and analyzer version is reused. Contact sheets per scene and, when the recording
// has speech, an on-device transcript go to context/recording/<id>/ (or --context): for the agent to read, never
// archived (scripts/lib/recording-extras.ts). A crop (input.json's, from the person's setup; or --crop in source
// pixels, for a file with no trace) is analyzed as the picture: analysis.json records it, and plan, emit and compose
// follow the analysis, so they take no crop of their own.
//
//   npx tsx scripts/recording.ts plan --media <id> [--target <s>] [--aspect 16:9|9:16|1:1|4:5]
//
// plan: the steps, trims, speeds, camera, hidden areas (scripts/lib/recording-plan.ts) from analysis.json, the trace
// and input.json in .va-run/recording/<id>/, and context/look/look.json's recording block. Writes the full plan to
// .va-run/recording/<id>/plan.json and the kept plan (no names from the recorded app) to
// video/assets/recording/plan.json, which the agent edits. Prints the clicked elements per step, fenced, then the JSON
// summary with checkpointMessage. Then a focus crop per step (at most 12) in context/recording/<id>/focus/.
// --analysis, --trace, --input, --look, --out, --full, --file and --context override the paths.
//
//   npx tsx scripts/recording.ts emit --step <id> [--beat <scene id>] [--label <name>] [--start <s>] [--duration <s>]
//   npx tsx scripts/recording.ts emit --holds-only
//
// emit: prints a recording scene's markup from the kept plan (scripts/lib/recording-emit.ts) and writes its data files
// (cursor path, locked hidden areas, the hold still when --duration is past 0.5x) under video/assets/recording/.
// --holds-only writes only the missing stills index.html's held scenes name. --video, --plan, --analysis and --trace
// override the paths.
//
//   npx tsx scripts/recording.ts compose --plan <full plan.json> [--look <id|none>] [--title <text>]
//
// compose: a whole demo with no agent (scripts/lib/recording-compose.ts): intro, a scene per step, outro, captions.
//
//   npx tsx scripts/recording.ts check
//
// check: the recording scenes of video/index.html against the run's inputs (app/server/lib/recording-check.ts): one line per
// problem naming the scene and the rule, exit 1. check-contract runs the same check.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { cropFromFractions, isRecordingCrop, type RecordingCrop } from '../app/server/lib/recording-crop.js'
import { parseTrace } from '../app/server/lib/recording-trace.js'
import { analyzeRecording } from './lib/recording-analyze.js'
import { ASPECTS, keptPlan, type Aspect, type PlanRedact, type PlanV1 } from '../app/server/lib/recording.js'
import type { Analysis } from './lib/recording-analyze.js'
import { composeDemo } from './lib/recording-compose.js'
import { emitStep, holdsOnly, readKeptPlan } from './lib/recording-emit.js'
import { checkRecordingScenes } from './lib/recording-inputs.js'
import { scanPrivacy, type PrivacyCandidate } from './lib/recording-privacy.js'
import { cachedAnalysis, makeFocusCrops, makeSheets, transcribeRecording } from './lib/recording-extras.js'
import {
  checkpointMessage,
  clickedElements,
  planRecording,
  planSummary,
  stableJson,
  type LookRecording,
  type PlanInput,
} from './lib/recording-plan.js'
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

/** --crop x,y,width,height in source pixels (a local file; a run's crop is in input.json, with its trace converted). */
function cropArg(file: string): RecordingCrop | null {
  if (!args.crop) return null
  const n = args.crop.split(',').map(Number)
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
  const [W, H] = probe.stdout.trim().split(',').map(Number)
  if (n.length !== 4 || !n.every(Number.isFinite) || !W || !H)
    throw new StepError('--crop takes x,y,width,height in pixels of the recording (like 0,160,2560,1280).')
  if (args.trace)
    throw new StepError('--crop is for a recording without --trace (a run converts its trace itself).')
  try {
    return cropFromFractions([(n[0] ?? 0) / W, (n[1] ?? 0) / H, (n[2] ?? 0) / W, (n[3] ?? 0) / H], W, H)
  } catch (e) {
    throw new StepError(e instanceof Error ? e.message : '--crop is not valid.')
  }
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
  // Privacy mode, hide strings and the crop: input.json (prepare-run writes it), or flags.
  const input = args.media
    ? (readIf(join(repoRoot, '.va-run', 'recording', args.media, 'input.json')) as {
        privacy?: boolean
        hideStrings?: string[]
        crop?: unknown
      } | null)
    : null
  const crop = cropArg(file) ?? (isRecordingCrop(input?.crop) ? input.crop : null)
  const cached = cachedAnalysis(out, sha256File(file), crop)
  log('recording.analyze_cache', { hit: Boolean(cached), crop })
  const analysis = cached ?? (await analyzeRecording(file, trace, crop))
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
  // Privacy mode and hide strings (input.json, or --privacy and --hide-strings a,b): OCR for things to hide.
  const privacy = 'privacy' in args || input?.privacy === true
  const strings = args['hide-strings'] ? args['hide-strings'].split(',') : (input?.hideStrings ?? [])
  const scan =
    privacy || strings.length
      ? await scanPrivacy(file, analysis, { patterns: privacy, strings, contextDir: context })
      : null
  return {
    ok: true,
    out,
    cached: Boolean(cached),
    crop: analysis.crop ?? null,
    privacy: scan
      ? { candidates: scan.candidates.length, frames: scan.frames, ms: scan.ms, stopped: scan.stopped }
      : null,
    sheets: sheets.length,
    transcript: existsSync(transcriptPath) ? { path: transcriptPath, words: words?.length ?? null } : null,
    cursorSource: analysis.cursorSource,
    idle: analysis.idle,
    scenes: analysis.scenes,
    clicks: analysis.clicks.length,
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const readIf = (path: string): unknown => (existsSync(path) ? readJson(path) : null)

/** Privacy mode's candidates (analyze's scan) as the plan's proposed hidden areas; none without a scan. */
function proposalsFrom(path: string): PlanRedact[] {
  const scan = readIf(path) as { candidates?: PrivacyCandidate[] } | null
  return (scan?.candidates ?? []).map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    reason: c.reason,
    boxes: c.boxes,
  }))
}

function plan() {
  const id = args.media
  if (!id) throw new StepError('plan needs --media <id>.')
  const aspect = (args.aspect ?? '16:9') as Aspect
  if (!ASPECTS.includes(aspect)) throw new StepError(`--aspect must be one of ${ASPECTS.join(', ')}.`)
  const target = args.target ? Number(args.target) : undefined
  if (target !== undefined && !(target > 0)) throw new StepError('--target must be a number of seconds.')
  const run = join(repoRoot, '.va-run', 'recording', id)
  const analysisPath = args.analysis ?? join(repoRoot, 'video', 'assets', 'recording', 'analysis.json')
  if (!existsSync(analysisPath))
    throw new StepError(`No analysis at ${analysisPath}: run recording.ts analyze first.`)
  const tracePath = args.trace ?? join(run, 'trace.json')
  const look = readIf(args.look ?? join(repoRoot, 'context', 'look', 'look.json')) as {
    recording?: LookRecording
  } | null
  const analysis = readJson(analysisPath) as Analysis
  const started = Date.now()
  const { plan: full, decisions } = planRecording({
    mediaId: id,
    analysis,
    trace: existsSync(tracePath) ? parseTrace(readFileSync(tracePath, 'utf8')) : null,
    input: readIf(args.input ?? join(run, 'input.json')) as PlanInput | null,
    look: look?.recording,
    target,
    aspect,
    proposals: proposalsFrom(
      join(args.context ?? join(repoRoot, 'context', 'recording', id), 'privacy', 'candidates.json'),
    ),
  })
  // `step` is the log line's own key: the plan's step goes in `planStep`.
  for (const { step, ...d } of decisions) log('recording.plan_rule', { ...d, planStep: step })
  const fullPath = args.full ?? join(run, 'plan.json')
  const out = args.out ?? join(repoRoot, 'video', 'assets', 'recording', 'plan.json')
  for (const [path, value] of [
    [fullPath, full],
    [out, keptPlan(full)],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, stableJson(value))
  }
  log('recording.plan', {
    steps: full.steps.length,
    estimate: full.estimate.seconds,
    ms: Date.now() - started,
  })
  // Focus crops need the recording itself; without it (a plan from files alone) they're skipped.
  let file: string | null = args.file ?? null
  if (!file)
    try {
      file = mediaFile(id)
    } catch {
      file = null
    }
  const focusDir = join(args.context ?? join(repoRoot, 'context', 'recording', id), 'focus')
  const crops = file ? makeFocusCrops(file, full, analysis, focusDir) : []
  if (!file) log('recording.focus_crop', { skipped: 'no recording file' })
  console.log(clickedElements(full))
  return {
    ok: true,
    out,
    full: fullPath,
    focus: crops.length ? { dir: focusDir, crops: crops.length } : null,
    ...planSummary(full),
    checkpointMessage: checkpointMessage(full, analysis),
  }
}

function emit() {
  const videoDir = args.video ?? join(repoRoot, 'video')
  if ('holds-only' in args) return { ok: true, written: holdsOnly(videoDir) }
  if (!args.step) throw new StepError('emit needs --step <id> (or --holds-only).')
  const plan = readKeptPlan(args.plan ?? join(videoDir, 'assets', 'recording', 'plan.json'))
  const analysisPath = args.analysis ?? join(videoDir, 'assets', 'recording', 'analysis.json')
  if (!existsSync(analysisPath))
    throw new StepError(`No analysis at ${analysisPath}: run recording.ts analyze first.`)
  const tracePath = args.trace ?? join(repoRoot, '.va-run', 'recording', plan.mediaId, 'trace.json')
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new StepError(`--${name} must be a number of seconds.`)
    return n
  }
  const r = emitStep({
    videoDir,
    plan,
    step: args.step,
    analysis: readJson(analysisPath) as Analysis,
    trace: existsSync(tracePath) ? parseTrace(readFileSync(tracePath, 'utf8')) : null,
    beat: args.beat,
    label: args.label,
    start: num(args.start, 'start'),
    duration: num(args.duration, 'duration'),
  })
  // The markup for the agent to paste, then the JSON result.
  console.log(r.markup)
  return {
    ok: true,
    files: r.files,
    hold: r.hold,
    rate: r.rate,
    duration: r.duration,
    slotDuration: r.slotDuration,
    cursor: r.cursor,
  }
}

function compose() {
  const videoDir = args.video ?? join(repoRoot, 'video')
  const planPath = args.plan
  if (!planPath)
    throw new StepError('compose needs --plan <plan.json> (the full plan, from .va-run/recording/<id>/).')
  const full = readJson(planPath) as PlanV1
  const analysisPath = args.analysis ?? join(videoDir, 'assets', 'recording', 'analysis.json')
  if (!existsSync(analysisPath))
    throw new StepError(`No analysis at ${analysisPath}: run recording.ts analyze first.`)
  const tracePath = args.trace ?? join(repoRoot, '.va-run', 'recording', full.mediaId, 'trace.json')
  // --look none, a look id (app/looks/<id>/look.json), or the run's look (context/look/look.json) by default.
  const lookArg = args.look
  const lookPath =
    lookArg === 'none'
      ? null
      : lookArg
        ? join(repoRoot, 'app', 'looks', lookArg, 'look.json')
        : join(repoRoot, 'context', 'look', 'look.json')
  if (lookArg && lookArg !== 'none' && !existsSync(lookPath ?? ''))
    throw new StepError(`No look "${lookArg}".`)
  const look = lookPath ? (readIf(lookPath) as { recording?: LookRecording } | null) : null
  const brand = readIf(args.brand ?? join(repoRoot, 'context', 'brand.json')) as {
    name?: string
    primaryColor?: string
  } | null
  const r = composeDemo({
    videoDir,
    plan: full,
    analysis: readJson(analysisPath) as Analysis,
    trace: existsSync(tracePath) ? parseTrace(readFileSync(tracePath, 'utf8')) : null,
    look: look?.recording ?? null,
    title: args.title,
    brand,
  })
  return {
    ok: true,
    index: join(videoDir, 'index.html'),
    seconds: r.seconds,
    beats: r.summary.captions?.length ?? 0,
  }
}

function check() {
  // --root: another checkout laid out like a run (tests).
  const root = args.root ?? repoRoot
  const html = readFileSync(join(root, 'video', 'index.html'), 'utf8')
  const problems = checkRecordingScenes(root, html)
  for (const p of problems)
    console.error(`${p.scene === '*' ? 'Recording' : `Scene "${p.scene}"`} (${p.rule}): ${p.message}`)
  if (problems.length) {
    console.log(JSON.stringify({ ok: false, problems }))
    process.exit(1)
  }
  return { ok: true, problems: [] }
}

const commands: Record<string, () => unknown> = { analyze, plan, emit, compose, check }

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
