// Run by the agent inside an Agent Runner run, after `hyperframes check` passes:
//   npx tsx scripts/render-job.ts --job <id> --attempt <id> --callback <url> --token <t> --upload blobs
// Renders video/, checks the file, makes the poster, GIF preview, captions and source archive (plus optional preview
// variants: small WebP/AVIF posters, a placeholder and a hover clip), uploads everything to the uploads store under the attempt id, and notifies the service.
// Prints the manifest as a fenced json block on stdout. Logs JSON lines on stderr.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import { validate, type Summary } from '../src/lib/contract.js'
import type { PreviewFile } from '../src/lib/media/previews.js'
import type { RunManifest } from '../src/lib/run-manifest.js'
import { postCheckpoint } from './checkpoint.js'
import { toVtt } from './lib/captions.js'
import { makePreviews, posterTime } from './lib/previews.js'
import { RenderProgressReporter } from './lib/render-progress.js'
import {
  StepError,
  log,
  netlifyCli,
  parseArgs,
  repoRoot,
  run,
  runStreaming,
  sha256File,
  videoTarArgs,
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

  // Editing contract v1 (plan v2 §8): a composition that declares it must keep it, or the editor can't open it.
  const indexHtml = readFileSync(join(videoDir, 'index.html'), 'utf8')
  if (/data-va-contract\s*=\s*["']1["']/.test(indexHtml)) {
    const violations = validate(indexHtml, summary as Summary)
    if (violations.length)
      throw new StepError(
        `The composition breaks the editing contract (see "Editing contract v1" in video/AGENTS.md):\n- ${violations.join('\n- ')}`,
      )
    log('contract.ok')
  } else log('contract.absent', { note: 'This video will not be editable in the browser.' })

  // Render-unchanged runs render exactly the frozen bundle prepare-run restored (plan v2 §14 rule 21).
  const runManifestPath = join(repoRoot, '.render', 'run-manifest.json')
  if (existsSync(runManifestPath)) {
    const m = JSON.parse(readFileSync(runManifestPath, 'utf8')) as RunManifest
    if (m.attemptId === attempt && m.kind === 'render_unchanged' && m.bundle) {
      const actual = bundleManifest(videoDir).hash
      if (actual !== m.bundle.manifestHash)
        throw new StepError(
          `video/ changed since prepare-run restored it (got ${actual}). Render-unchanged runs must not edit files. Stop and report this.`,
        )
      log('bundle.verified', { manifestHash: actual })
    }
  }

  log('render.start', { quality: QUALITY })
  const video = join(out, 'video.mp4')
  // "Rendering N%" for the person watching, through the checkpoint endpoint (best effort, plan v2 §6 A2).
  const checkpointUrl = callback.replace(/\/done$/, '/checkpoint')
  const reporter = new RenderProgressReporter((pct) => {
    void postCheckpoint({ attempt, url: checkpointUrl, token, renderPercent: pct }).then((r) => {
      if (!r.ok) log('render.progress_skipped', { pct, reason: r.reason })
    })
  })
  await runStreaming('npx', ['-y', 'hyperframes', 'render', '--quality', QUALITY, '--output', video], {
    cwd: videoDir,
    timeoutMs: 20 * 60_000,
    onOutput: (chunk) => {
      reporter.line(chunk)
    },
  })
  reporter.end()
  // hyperframes stops its machine lines at 99%: close the render out so the page moves on to "saving".
  void postCheckpoint({
    attempt,
    url: checkpointUrl,
    token,
    renderPercent: 100,
    message: 'Rendered, saving the files',
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

  const posterAt = posterTime(durationSec)
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
  run('tar', videoTarArgs(join(out, 'source.tar.gz')))
  // Best effort: a variant that can't be made is left out, and the service falls back to the poster and GIF.
  const previews = makePreviews({ video, out, posterAt, durationSec })
  if (previews.skipped.length) log('previews.skipped', { skipped: previews.skipped })
  log('assets.done', { durationSec, width: stream.width, height: stream.height, previews: previews.files })

  const entry = (name: string) => ({
    sha256: sha256File(join(out, name)),
    bytes: statSync(join(out, name)).size,
  })
  const files = Object.fromEntries(OUTPUTS.map((name) => [name, entry(name)])) as Record<
    (typeof OUTPUTS)[number],
    { sha256: string; bytes: number }
  > &
    Partial<Record<PreviewFile, { sha256: string; bytes: number }>>

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
  for (const name of previews.files) {
    const [bin, ...pre] = cli as [string, ...string[]]
    try {
      await withRetries(`upload ${name}`, 2, () =>
        run(
          bin,
          [...pre, 'blobs:set', 'uploads', `${attempt}/${name}`, '--input', join(out, name), '--force'],
          {
            timeoutMs: 2 * 60_000,
          },
        ),
      )
      files[name] = entry(name)
    } catch (e) {
      const error = e instanceof Error ? e.message.slice(0, 300) : String(e)
      log('previews.upload_skipped', { name, error })
      previews.skipped.push({ name, reason: `upload failed: ${error}` })
    }
  }
  log('upload.done', { ms: Date.now() - started })

  const manifest = {
    jobId: job,
    attemptId: attempt,
    title: typeof summary.title === 'string' ? summary.title.slice(0, 120) : '',
    summary: typeof summary.summary === 'string' ? summary.summary.slice(0, 4000) : '',
    files,
    ...(previews.lqip ? { lqip: previews.lqip } : {}),
    // Why a variant is missing, so the service can log it (the run's own output isn't kept).
    ...(previews.skipped.length
      ? {
          previewsSkipped: previews.skipped
            .slice(0, 12)
            .map((s) => ({ name: s.name, reason: s.reason.slice(0, 300) })),
        }
      : {}),
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
