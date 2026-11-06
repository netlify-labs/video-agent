// Spike S11 (plan 2026-11-02-record-your-own-voiceover §6.6, §9): speech-to-text on the Agent Runner.
//   npx tsx docs/spikes/s11/stt.ts [--provider parakeet|whisper|all] [--lengths 60,90,600] [--out /tmp/va-s11]
//        [--deadline-min 10] [--install-deadline-min 15] [--kill-test-s 8] [--voices af_heart,am_michael]
//        [--self-test]
// 1. Speaks a fixed set of phrases with Kokoro (`npx hyperframes tts`, as scripts/voice.ts does) and lays them out
//    sample-exactly into 60/90/600 s 24 kHz buses with known phrase onsets (see metrics.ts for the timing model).
// 2. Parakeet: `hyperframes models install parakeet`, then `hyperframes transcribe --engine parakeet --json`.
// 3. whisper.cpp: pinned tag, cmake build, pinned base.en model (sha256), `whisper-cli -ml 1 -sow -oj`
//    and `-ojf --dtw base.en -nfa` (token DTW timestamps) on every input.
// Every provider call runs under an outer process-group deadline (docs/spikes/lib/proc.ts runGroup); a kill test
// checks that the deadline reaps the whole tree. Progress: JSON lines on stderr. Summary: one JSON block on stdout
// between ===S11-JSON=== lines, also saved as <out>/summary.json. Nothing in the repo is written.
//
// Local macOS note: Kokoro needs kokoro-onnx in the python3 on PATH; Homebrew espeak-ng may be needed via
// PHONEMIZER_ESPEAK_LIBRARY=/opt/homebrew/lib/libespeak-ng.dylib ESPEAK_DATA_PATH=/opt/homebrew/share/espeak-ng-data.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir, platform, arch, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { kokoro, toPcm } from '../../../scripts/lib/voice-providers.js'
import {
  decodeMono,
  duBytes,
  ffmpeg,
  log,
  metrics,
  parseFlags,
  printSummary,
  repoRoot,
  rms,
  round,
  runGroup,
  sha1File,
  sha256File,
  tool,
  which,
  writeWav,
  type GroupResult,
} from '../lib/proc.js'
import {
  parseHyperframesTranscript,
  parseWhisperJson,
  score,
  selfTest,
  type ExpectedWord,
  type HypWord,
} from './metrics.js'

const RATE = 24_000
const STT_RATE = 16_000
const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp'
const WHISPER_TAG = 'v1.9.5'
const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
const MODEL = {
  name: 'ggml-base.en.bin',
  revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin',
  bytes: 147_964_211,
  sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  // whisper.cpp's models/download-ggml-model.sh lists this sha1 for base.en.
  sha1: '137c40403d78fd54d454da0f9bd998f78703390c',
  license: 'MIT (OpenAI Whisper weights, converted to ggml by ggerganov; HF card license: mit)',
}

// Our own text: short, plain sentences, no digits, contractions, hyphens or words read two ways.
const PHRASES = [
  'The river bends north past the old stone mill.',
  'Every morning the baker opens her shop before sunrise.',
  'A small brown dog waits patiently by the garden gate.',
  'Clouds gather over the hills and the air turns cool.',
  'The children run along the beach collecting smooth shells.',
  'Our team builds tools that help people share their stories.',
  'Lanterns glow softly in the windows of the quiet village.',
  'She carries a basket of apples down the narrow path.',
  'The train arrives on time and the platform fills with travelers.',
  'Bright green leaves cover the branches after a week of rain.',
  'He writes a letter to his brother who lives by the sea.',
  'The market square is full of music and laughter tonight.',
  'A gentle breeze moves the tall grass across the meadow.',
  'Please check your settings before you start the next step.',
  'The museum keeps maps drawn by sailors many years ago.',
  'Snow falls slowly and covers the rooftops in white.',
  'Two owls call to each other from the dark forest.',
  'The kettle whistles and the kitchen smells of fresh bread.',
  'We walk together to the top of the hill to watch the stars.',
  'Thank you for watching, and have a wonderful day.',
]

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-s11')
const lengths = (flags.lengths ?? '60,90,600').split(',').map(Number).filter((n) => n > 0)
const provider = flags.provider ?? 'all'
const voices = (flags.voices ?? 'af_heart,am_michael').split(',')
const deadlineMs = Number(flags['deadline-min'] ?? 10) * 60_000
const installDeadlineMs = Number(flags['install-deadline-min'] ?? 15) * 60_000
const killTestMs = Number(flags['kill-test-s'] ?? 8) * 1000
// 4 = the runner's CPUs; more threads than performance cores stalls whisper.cpp (seen: -t 14 on an M4 Pro, 60x slower).
const threads = Number(flags.threads ?? Math.min(4, availableParallelism()))
const videoDir = join(repoRoot, 'video')
mkdirSync(outDir, { recursive: true })

const started = Date.now()
const selfTestFails = selfTest()
log('selftest', { pass: selfTestFails.length === 0, fails: selfTestFails })
if (flags['self-test']) {
  printSummary('S11-JSON', join(outDir, 'selftest.json'), { spike: 'S11', selfTest: { pass: !selfTestFails.length, fails: selfTestFails } })
  process.exit(selfTestFails.length ? 1 : 0)
}

const firstLine = (cmd: string, args: string[]) => {
  try {
    return tool(cmd, args).split('\n')[0]?.trim() ?? null
  } catch {
    return null
  }
}
const host = {
  platform: platform(),
  arch: arch(),
  cpus: availableParallelism(),
  memGb: round(totalmem() / 2 ** 30, 1),
  node: process.version,
  ffmpeg: firstLine('ffmpeg', ['-version']),
  python: firstLine('python3', ['--version']),
  glibc: (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ?? null,
  timeWrapper: which('python3') ? 'python3 resource.getrusage(RUSAGE_CHILDREN)' : 'none',
}
log('host', host)

// ---- 1. Phrases with Kokoro, cached by voice + index. ----
interface Clip {
  samples: Int16Array
  onset: number
  offset: number
}
function speechSpan(s: Int16Array): { onset: number; offset: number } {
  const frame = RATE / 100
  const levels: number[] = []
  for (let i = 0; i < s.length; i += frame) levels.push(rms(s, i, i + frame))
  const thr = Math.max(...levels) * 0.05
  const first = levels.findIndex((l) => l > thr)
  const last = levels.length - 1 - [...levels].reverse().findIndex((l) => l > thr)
  return { onset: (Math.max(0, first) * frame) / RATE, offset: Math.min(s.length, (last + 1) * frame) / RATE }
}

const tts = { voices, phrases: PHRASES.length, ms: 0, firstCallMs: null as number | null, cached: 0, spoken: 0, error: null as string | null }
const clips = new Map<string, Clip>()
{
  const dir = join(outDir, 'phrases')
  mkdirSync(dir, { recursive: true })
  const speaker = kokoro(videoDir)
  const t0 = Date.now()
  try {
    for (const voice of voices)
      for (const [i, text] of PHRASES.entries()) {
        const file = join(dir, `${voice}-${i}.wav`)
        if (!existsSync(file)) {
          const t = Date.now()
          const speech = await speaker.synthesize(text, { voice, speed: 1 })
          const pcm = toPcm(speech)
          writeWav(file, { rate: RATE, samples: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2) })
          tts.firstCallMs ??= Date.now() - t
          tts.spoken++
        } else tts.cached++
        const samples = decodeMono(file, RATE).samples
        clips.set(`${voice}-${i}`, { samples, ...speechSpan(samples) })
      }
  } catch (e) {
    tts.error = e instanceof Error ? e.message.slice(0, 1500) : String(e)
  }
  tts.ms = Date.now() - t0
  log('tts', tts)
}
if (tts.error) {
  printSummary('S11-JSON', join(outDir, 'summary.json'), { spike: 'S11', host, selfTest: { pass: !selfTestFails.length, fails: selfTestFails }, tts, totalMs: Date.now() - started })
  process.exit(1)
}

// ---- 2. Inputs: phrases laid out with deterministic gaps, voices alternating per pass. ----
interface Input {
  seconds: number
  wav24: string
  wav16: string
  expected: ExpectedWord[]
}
function buildInput(seconds: number): Input {
  const total = Math.round(seconds * RATE)
  const bus = new Int16Array(total)
  const expected: ExpectedWord[] = []
  let at = Math.round(0.5 * RATE)
  for (let k = 0; ; k++) {
    const i = k % PHRASES.length
    const voice = voices[Math.floor(k / PHRASES.length) % voices.length]!
    const clip = clips.get(`${voice}-${i}`)!
    if (at + clip.samples.length > total - Math.round(0.3 * RATE)) break
    bus.set(clip.samples, at)
    const start = at / RATE + clip.onset
    const end = at / RATE + clip.offset
    const words = PHRASES[i]!.split(/\s+/)
    const weights = words.map((w) => w.replace(/[^A-Za-z]/g, '').length + 1)
    const sum = weights.reduce((a, b) => a + b, 0)
    let t = start
    words.forEach((w, j) => {
      const dur = ((end - start) * weights[j]!) / sum
      expected.push({ text: w, start: round(t), end: round(t + dur), phrase: k, first: j === 0, last: j === words.length - 1 })
      t += dur
    })
    at += clip.samples.length + Math.round((0.35 + ((k * 7) % 5) * 0.1) * RATE)
  }
  const dir = join(outDir, 'inputs')
  mkdirSync(dir, { recursive: true })
  const wav24 = join(dir, `bus-${seconds}s-24k.wav`)
  const wav16 = join(dir, `bus-${seconds}s-16k.wav`)
  writeWav(wav24, { rate: RATE, samples: bus })
  writeFileSync(join(dir, `bus-${seconds}s.expected.json`), JSON.stringify(expected))
  return { seconds, wav24, wav16, expected }
}

const inputs: Input[] = []
const prep: Record<string, unknown>[] = []
for (const seconds of lengths) {
  const input = buildInput(seconds)
  // The plan's STT path decodes the bus to 16 kHz first; the light clean chain is timed as a budget proxy.
  let t = Date.now()
  ffmpeg(['-loglevel', 'error', '-y', '-i', input.wav24, '-ac', '1', '-ar', String(STT_RATE), '-c:a', 'pcm_s16le', input.wav16])
  const decode16kMs = Date.now() - t
  t = Date.now()
  ffmpeg([
    '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-i', input.wav24,
    '-af', 'highpass=f=80,afftdn=nr=10:nf=-40,deesser,acompressor=threshold=-24dB:ratio=2:attack=10:release=120:knee=4',
    '-ar', String(RATE), '-c:a', 'pcm_s16le', join(outDir, 'inputs', `bus-${seconds}s-clean.wav`),
  ])
  const cleanChainMs = Date.now() - t
  const row = {
    seconds,
    phrases: new Set(input.expected.map((w) => w.phrase)).size,
    words: input.expected.length,
    sha256: sha256File(input.wav24),
    decode16kMs,
    cleanChainMs,
  }
  prep.push(row)
  inputs.push(input)
  log('input', row)
}

const realtime = (r: GroupResult, seconds: number) => round(r.wallMs / 1000 / seconds, 3)
const errorOf = (e: unknown) => (e instanceof Error ? e.message.slice(0, 1500) : String(e))

// ---- 3. Parakeet through hyperframes. ----
async function parakeet() {
  const cacheDirs = [join(homedir(), '.cache', 'hyperframes', 'parakeet'), join(homedir(), '.cache', 'hyperframes', 'optional')]
  const before = cacheDirs.reduce((a, d) => a + duBytes(d), 0)
  const install = await runGroup('parakeet.install', 'npx', ['hyperframes', 'models', 'install', 'parakeet', '--json'], {
    cwd: videoDir,
    deadlineMs: installDeadlineMs,
  })
  const after = cacheDirs.reduce((a, d) => a + duBytes(d), 0)
  let installJson: unknown = null
  try {
    installJson = JSON.parse(install.stdout.trim().split('\n').at(-1) ?? 'null')
  } catch {
    // Not JSON.
  }
  const result: Record<string, unknown> = {
    install: { ...metrics(install), bytesAdded: after - before, cacheBytes: after, result: installJson },
  }
  log('parakeet.install', result.install as Record<string, unknown>)
  if (!install.ok) {
    const reason = (installJson as { error?: { message?: string } } | null)?.error?.message ?? install.stderrTail.slice(-500)
    return { status: 'unavailable', reason, ...result }
  }
  const runs: Record<string, unknown>[] = []
  for (const input of inputs) {
    const dir = join(outDir, 'runs', `parakeet-${input.seconds}s`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const r = await runGroup(
      `parakeet.${input.seconds}`,
      'npx',
      ['hyperframes', 'transcribe', input.wav16, '--engine', 'parakeet', '--language', 'en', '--dir', dir, '--json'],
      { cwd: videoDir, deadlineMs },
    )
    const row: Record<string, unknown> = { seconds: input.seconds, ...metrics(r), realtimeFactor: realtime(r, input.seconds) }
    try {
      const words: HypWord[] = parseHyperframesTranscript(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')))
      row.score = score(input.expected, words)
      row.cli = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? 'null') as unknown
    } catch (e) {
      row.parseError = errorOf(e)
    }
    runs.push(row)
    log('parakeet.run', row)
  }
  return { status: runs.every((r) => r.ok) ? 'ok' : 'failed', model: 'parakeet-tdt-0.6b-v3-int8 (sherpa-onnx, csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8@2bda32ec; CC-BY-4.0 per NVIDIA model card)', ...result, runs, killTest: await killTest('parakeet') }
}

// ---- 4. whisper.cpp from source. ----
const whisperDir = join(outDir, 'whisper')
const whisperSrc = join(whisperDir, `whisper.cpp-${WHISPER_TAG}`)
const whisperBin = join(whisperSrc, 'build', 'bin', 'whisper-cli')
const modelPath = join(whisperDir, MODEL.name)

function whisperArgs(input: Input, prefix: string, dtw: boolean) {
  return [
    '-m', modelPath, '-f', input.wav16, '-l', 'en', '-t', String(threads), '-np',
    // DTW token timestamps are silently disabled under flash attention (on by default in 1.9), hence -nfa.
    ...(dtw ? ['-ojf', '--dtw', 'base.en', '-nfa'] : ['-ml', '1', '-sow', '-oj']),
    '-of', prefix,
  ]
}

async function whisper() {
  const out: Record<string, unknown> = { tag: WHISPER_TAG, expectedCommit: WHISPER_COMMIT }
  mkdirSync(whisperDir, { recursive: true })
  const cmake = which('cmake')
  if (!cmake) return { status: 'unavailable', reason: 'cmake not found on PATH', ...out }
  let commit: string | null = null
  try {
    commit = tool('git', ['-C', whisperSrc, 'rev-parse', 'HEAD']).trim()
  } catch {
    // Not cloned yet.
  }
  if (commit !== WHISPER_COMMIT) {
    rmSync(whisperSrc, { recursive: true, force: true })
    const clone = await runGroup('whisper.clone', 'git', ['-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', WHISPER_TAG, WHISPER_REPO, whisperSrc], { deadlineMs: installDeadlineMs })
    out.clone = metrics(clone)
    log('whisper.clone', out.clone as Record<string, unknown>)
    if (!clone.ok) return { status: 'failed', reason: 'clone failed', ...out }
    commit = tool('git', ['-C', whisperSrc, 'rev-parse', 'HEAD']).trim()
  } else out.clone = { cached: true }
  out.commit = commit
  out.commitMatches = commit === WHISPER_COMMIT
  out.license = readFileSync(join(whisperSrc, 'LICENSE'), 'utf8').split('\n')[0]?.trim()
  if (!existsSync(whisperBin)) {
    const configure = await runGroup(
      'whisper.configure',
      cmake,
      [
        '-S', whisperSrc, '-B', join(whisperSrc, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
        '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_SDL2=OFF', '-DGGML_NATIVE=ON',
        // CPU only everywhere, like the runner (no Metal/Accelerate on a Mac either).
        ...(platform() === 'darwin' ? ['-DGGML_METAL=OFF', '-DGGML_BLAS=OFF', '-DWHISPER_COREML=OFF'] : []),
      ],
      { deadlineMs: installDeadlineMs },
    )
    out.configure = metrics(configure)
    log('whisper.configure', out.configure as Record<string, unknown>)
    if (!configure.ok) return { status: 'failed', reason: 'cmake configure failed', ...out }
    const build = await runGroup('whisper.build', cmake, ['--build', join(whisperSrc, 'build'), '--config', 'Release', '-j', String(threads), '--target', 'whisper-cli'], { deadlineMs: installDeadlineMs })
    out.build = metrics(build)
    log('whisper.build', out.build as Record<string, unknown>)
    if (!build.ok || !existsSync(whisperBin)) return { status: 'failed', reason: 'build failed', ...out }
  } else out.build = { cached: true }
  out.binaryBytes = duBytes(whisperBin)

  const model: Record<string, unknown> = { name: MODEL.name, url: MODEL.url, revision: MODEL.revision, license: MODEL.license, expectedSha256: MODEL.sha256 }
  if (!existsSync(modelPath) || sha256File(modelPath) !== MODEL.sha256) {
    const part = `${modelPath}.part`
    const dl = which('curl')
      ? await runGroup('whisper.model', 'curl', ['-sS', '-L', '--fail', '-o', part, MODEL.url], { deadlineMs: installDeadlineMs })
      : null
    if (!dl) {
      const t = Date.now()
      const res = await fetch(MODEL.url)
      writeFileSync(part, new Uint8Array(await res.arrayBuffer()))
      model.downloadMs = Date.now() - t
    } else {
      model.download = metrics(dl)
      if (!dl.ok) return { status: 'failed', reason: 'model download failed', ...out, model }
    }
    renameSync(part, modelPath)
  } else model.cached = true
  model.bytes = duBytes(modelPath)
  model.sha256 = sha256File(modelPath)
  model.sha1 = sha1File(modelPath)
  model.verified = model.sha256 === MODEL.sha256 && model.sha1 === MODEL.sha1
  out.model = model
  log('whisper.model', model)
  if (!model.verified) return { status: 'failed', reason: 'model digest mismatch', ...out }

  const runs: Record<string, unknown>[] = []
  for (const input of inputs) runs.push(await whisperRun(input, false))
  out.runs = runs
  // DTW token timestamps: same model, one more pass per input (much better word starts than -ml 1 in local tests).
  if (!flags['skip-dtw']) {
    const dtw: Record<string, unknown>[] = []
    for (const input of inputs) dtw.push(await whisperRun(input, true))
    out.dtwRuns = dtw
  }
  return { status: runs.every((r) => r.ok) ? 'ok' : 'failed', ...out, killTest: await killTest('whisper') }
}

async function whisperRun(input: Input, dtw: boolean) {
  const dir = join(outDir, 'runs', `whisper${dtw ? '-dtw' : ''}-${input.seconds}s`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const prefix = join(dir, 'out')
  const r = await runGroup(`whisper${dtw ? '.dtw' : ''}.${input.seconds}`, whisperBin, whisperArgs(input, prefix, dtw), { deadlineMs })
  const row: Record<string, unknown> = { seconds: input.seconds, mode: dtw ? 'ojf+dtw' : 'ml1+sow', ...metrics(r), realtimeFactor: realtime(r, input.seconds) }
  try {
    row.score = score(input.expected, parseWhisperJson(JSON.parse(readFileSync(`${prefix}.json`, 'utf8')), dtw ? 'dtw' : 'segments'))
  } catch (e) {
    row.parseError = errorOf(e)
  }
  log(`whisper.run`, row)
  return row
}

/** Starts the longest transcription with a short deadline and checks the group kill reaped every process. */
async function killTest(which_: 'parakeet' | 'whisper') {
  if (!killTestMs) return null
  const input = inputs.reduce((a, b) => (b.seconds > a.seconds ? b : a))
  const dir = join(outDir, 'runs', `${which_}-kill`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const r =
    which_ === 'parakeet'
      ? await runGroup('parakeet.kill', 'npx', ['hyperframes', 'transcribe', input.wav16, '--engine', 'parakeet', '--dir', dir, '--json'], { cwd: videoDir, deadlineMs: killTestMs })
      : await runGroup('whisper.kill', whisperBin, whisperArgs(input, join(dir, 'out'), false), { deadlineMs: killTestMs })
  const row = {
    seconds: input.seconds,
    deadlineMs: killTestMs,
    timedOut: r.timedOut,
    killToExitMs: r.timedOut ? r.wallMs - killTestMs : null,
    signal: r.signal,
    code: r.code,
    descendantsSeen: r.descendantsSeen,
    escapedGroup: r.escapedGroup,
    leftover: r.leftover,
    reaped: r.reaped,
  }
  log(`${which_}.kill`, row)
  return row
}

const results: Record<string, unknown> = {}
for (const p of provider === 'all' ? ['parakeet', 'whisper'] : [provider]) {
  try {
    results[p] = p === 'parakeet' ? await parakeet() : p === 'whisper' ? await whisper() : { status: 'unknown provider' }
  } catch (e) {
    results[p] = { status: 'error', error: errorOf(e) }
  }
  log(`${p}.done`, { status: (results[p] as { status?: string }).status })
}

printSummary('S11-JSON', join(outDir, `summary-${provider}.json`), {
  spike: 'S11',
  harness: 1,
  startedAt: new Date(started).toISOString(),
  host,
  selfTest: { pass: !selfTestFails.length, fails: selfTestFails },
  tts,
  inputs: prep,
  timingModel: 'phraseStart = exact (clip placement + measured onset); wordStartEstimated = proportional to letters within a phrase',
  ...results,
  totalMs: Date.now() - started,
})
