// Run by the agent inside an Agent Runner run, after `hyperframes check` passes:
//   npx tsx scripts/render-job.ts --job <id> --attempt <id> --callback <url> --token <t> --upload blobs
// Renders video/, checks the file, makes the poster, GIF preview, captions and source archive,
// uploads everything to the uploads store under the attempt id, and notifies the service.
// Prints the manifest as a fenced json block on stdout. Logs JSON lines on stderr.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toVtt } from './lib/captions.js'
import {
  StepError,
  log,
  netlifyCli,
  parseArgs,
  repoRoot,
  run,
  sha256File,
  which,
  withRetries,
} from './lib/run-tools.js'

const OUTPUTS = ['video.mp4', 'poster.jpg', 'preview.gif', 'captions.vtt', 'source.tar.gz'] as const
const QUALITY = process.env.RENDER_QUALITY ?? 'standard'
const MAX_BYTES = 2 * 1024 * 1024 * 1024

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { job, attempt, callback, token } = args
  if (!job || !attempt || !callback || !token)
    throw new StepError(
      'Usage: render-job.ts --job <id> --attempt <id> --callback <url> --token <token> --upload blobs',
    )
  const started = Date.now()
  const videoDir = join(repoRoot, 'video')
  const out = join(repoRoot, '.render', attempt)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  for (const tool of ['ffmpeg', 'ffprobe'])
    if (!which(tool))
      throw new StepError(
        `${tool} is not installed. netlify-agent-kit should have installed it; check the run setup log.`,
      )
  if (!existsSync(join(videoDir, 'index.html')))
    throw new StepError('video/index.html does not exist. Write the composition first.')

  const summaryPath = join(videoDir, 'summary.json')
  if (!existsSync(summaryPath))
    throw new StepError(
      'video/summary.json is missing. Write { "title", "summary", "captions": [...] } first.',
    )
  let summary: { title?: unknown; summary?: unknown; captions?: unknown }
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as typeof summary
  } catch (e) {
    throw new StepError(`video/summary.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  log('render.start', { quality: QUALITY })
  const video = join(out, 'video.mp4')
  run('npx', ['-y', 'hyperframes', 'render', '--quality', QUALITY, '--output', video], {
    cwd: videoDir,
    timeoutMs: 20 * 60_000,
  })
  log('render.done', { ms: Date.now() - started, bytes: statSync(video).size })

  const probe = JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,codec_name:format=duration',
      '-of',
      'json',
      video,
    ]),
  ) as {
    streams?: { width?: number; height?: number; codec_name?: string }[]
    format?: { duration?: string }
  }
  const stream = probe.streams?.[0]
  const durationSec = Number(probe.format?.duration)
  if (!stream?.width || !stream.height || !(durationSec > 0))
    throw new StepError(
      'The rendered MP4 has no video stream or duration. Re-run hyperframes check and render.',
    )
  if (statSync(video).size > MAX_BYTES)
    throw new StepError('The rendered MP4 is larger than 2 GB. Make the video shorter.')

  const posterAt = Math.min(Math.max(durationSec * 0.3, 0.5), Math.max(durationSec - 0.1, 0))
  run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    posterAt.toFixed(2),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-q:v',
    '3',
    join(out, 'poster.jpg'),
  ])
  run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-t',
    String(Math.min(4, durationSec)),
    '-i',
    video,
    '-vf',
    'fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
    '-loop',
    '0',
    join(out, 'preview.gif'),
  ])
  writeFileSync(join(out, 'captions.vtt'), toVtt(summary.captions, durationSec))
  run('tar', [
    '-czf',
    join(out, 'source.tar.gz'),
    '--exclude=node_modules',
    '--exclude=.hyperframes',
    '--exclude=renders',
    '--exclude=*.mp4',
    '-C',
    repoRoot,
    'video',
  ])
  log('assets.done', { durationSec, width: stream.width, height: stream.height })

  const files = Object.fromEntries(
    OUTPUTS.map((name) => [
      name,
      { sha256: sha256File(join(out, name)), bytes: statSync(join(out, name)).size },
    ]),
  ) as Record<(typeof OUTPUTS)[number], { sha256: string; bytes: number }>

  const cli = netlifyCli()
  for (const name of OUTPUTS) {
    const [bin, ...pre] = cli as [string, ...string[]]
    await withRetries(`upload ${name}`, 4, () =>
      run(
        bin,
        [...pre, 'blobs:set', 'uploads', `${attempt}/${name}`, '--input', join(out, name), '--force'],
        { timeoutMs: 5 * 60_000 },
      ),
    )
  }
  log('upload.done', { ms: Date.now() - started })

  const manifest = {
    jobId: job,
    attemptId: attempt,
    title: typeof summary.title === 'string' ? summary.title.slice(0, 120) : '',
    summary: typeof summary.summary === 'string' ? summary.summary.slice(0, 4000) : '',
    files,
    durationSec,
    width: stream.width,
    height: stream.height,
    tools: {
      hyperframes:
        run('npx', ['-y', 'hyperframes', '--version'], { cwd: videoDir }).trim().split('\n').pop() ?? '',
      quality: QUALITY,
    },
  }

  const status = await withRetries('callback', 5, async () => {
    const res = await fetch(callback, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 410) return 410
    if (res.status >= 500 || res.status === 429) throw new Error(`callback HTTP ${res.status}`)
    if (res.status !== 202)
      throw new StepError(
        `The service rejected the callback (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`,
      )
    return res.status
  })
  log('callback.done', { status, ms: Date.now() - started })
  if (status === 410) console.log('The service says this job was cancelled. Stop here.')
  console.log(`\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``)
}

main().catch((e: unknown) => {
  log('failed', { error: e instanceof Error ? e.message : String(e) })
  console.error(`\nrender-job failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
