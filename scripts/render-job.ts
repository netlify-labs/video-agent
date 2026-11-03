// Run by the agent inside an Agent Runner run, after `hyperframes check` passes:
//   npx tsx scripts/render-job.ts --job <id> --attempt <id> --callback <url> --token <t> --upload blobs
// Renders video/, checks the file, masters a narrated mix's loudness (scripts/lib/mastering.ts), makes the poster, GIF preview, captions and source archive (plus optional preview
// variants: small WebP/AVIF posters, a placeholder and a hover clip), uploads everything to the uploads store under the attempt id, and notifies the service.
// Reference files (the narration bus) stay out of source.tar.gz and are uploaded on their own (scripts/lib/references.ts).
// Prints the manifest as a fenced json block on stdout. Logs JSON lines on stderr.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MasteringReport, NarrationOutput, NarrationReport } from '../src/domain/types.js'
import { bundleManifest, compositionFiles } from '../src/lib/bundle-manifest.js'
import { NARRATION_SRC, validate, type Summary } from '../src/lib/contract.js'
import { groupWords, transcriptText } from '../src/lib/narration-captions.js'
import { checkNarration } from '../src/lib/narration-guard.js'
import { checkNarrationModified } from '../src/lib/narration-modified.js'
import { checkRevoiced, FROZEN_DIR } from '../src/lib/revoice.js'
import type { PreviewFile } from '../src/lib/media/previews.js'
import type { RunManifest } from '../src/lib/run-manifest.js'
import type { NarrationOp } from '../src/lib/timeline.js'
import { postCheckpoint } from './checkpoint.js'
import { readNarrationReceipt } from './lib/narration-inputs.js'
import { toVtt } from './lib/captions.js'
import {
  HYPERFRAMES_AUTOMATION_POINTS,
  MAX_AUTOMATION_POINTS,
  automationOverCap,
  master,
  narrationOf,
} from './lib/mastering.js'
import { captionsForRender } from './lib/narration-captions.js'
import { readSttRecord } from './lib/stt/index.js'
import { makePreviews, posterTime } from './lib/previews.js'
import { uploadReferences } from './lib/references.js'
import { RenderProgressReporter } from './lib/render-progress.js'
import {
  StepError,
  assertNoTakesInVideo,
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
    if (/data-va-revoice/.test(indexHtml))
      throw new StepError(
        'Some narration lines are still marked for re-voicing (data-va-revoice). Run npx tsx scripts/voice.ts revoice first.',
      )
    log('contract.ok')
  } else log('contract.absent', { note: 'This video will not be editable in the browser.' })

  // Render-unchanged runs render exactly the frozen bundle prepare-run restored (plan v2 §14 rule 21).
  const runManifestPath = join(repoRoot, '.render', 'run-manifest.json')
  // The frozen narration op: captions.vtt captions only what its tracks leave audible.
  let narrationOp: NarrationOp | undefined
  if (existsSync(runManifestPath)) {
    const m = JSON.parse(readFileSync(runManifestPath, 'utf8')) as RunManifest
    if (m.attemptId === attempt) narrationOp = m.bundle?.narration?.op
    if (m.attemptId === attempt && m.kind === 'render_unchanged' && m.bundle?.narration) {
      // Recorded narration (after any re-voice): only the files narration-run.ts's steps write may differ, each
      // exactly as those steps write it from the frozen files and the receipt (src/lib/narration-guard.ts).
      const receipt = readNarrationReceipt(repoRoot)
      const problems = checkNarration(
        join(repoRoot, FROZEN_DIR),
        videoDir,
        receipt,
        m,
        readSttRecord(repoRoot),
      )
      if (problems.length)
        throw new StepError(
          `narration_guard_failed: ${problems[0]}\nvideo/ changed in ways re-voicing and mixing the narration don't explain. Render-unchanged runs must not edit files. Stop and report this.\n- ${problems.join('\n- ')}`,
        )
      log('bundle.verified', {
        narration: { bus: receipt?.bus.sha256, samples: receipt?.bus.samples },
        ...(m.bundle.revoice ? { revoiced: m.bundle.revoice.beats } : {}),
      })
    } else if (m.attemptId === attempt && m.kind === 'author_from_frozen') {
      // A fit to recorded narration: the agent retimed the visuals, but the narration must sound exactly as
      // scripts/narration.ts mixed it (src/lib/narration-modified.ts), from the frozen draft and the receipt.
      const receipt = readNarrationReceipt(repoRoot)
      const problems = checkNarrationModified(
        join(repoRoot, FROZEN_DIR),
        videoDir,
        receipt,
        m,
        readSttRecord(repoRoot),
      )
      if (problems.length)
        throw new StepError(
          `narration_modified: ${problems[0]}\nThe recorded narration is locked in a fit: change the visuals around it, never the narration element, its bus, its path to the mix, or audio over its speech. Fix the composition and run render-job again.\n- ${problems.join('\n- ')}`,
        )
      log('narration.locked', {
        bus: receipt?.bus.sha256,
        samples: receipt?.bus.samples,
        ...(m.bundle?.revoice ? { revoiced: m.bundle.revoice.beats } : {}),
      })
    } else if (m.attemptId === attempt && m.kind === 'render_unchanged' && m.bundle?.revoice) {
      // Re-voiced lines: only the files voice.ts revoice writes may differ, and exactly as it writes them.
      const problems = checkRevoiced(videoDir, join(repoRoot, FROZEN_DIR), m.bundle.revoice)
      if (problems.length)
        throw new StepError(
          `video/ changed in ways re-voicing doesn't explain. Render-unchanged runs must not edit files. Stop and report this.\n- ${problems.join('\n- ')}`,
        )
      log('bundle.verified', { revoiced: m.bundle.revoice.beats })
    } else if (m.attemptId === attempt && m.kind === 'render_unchanged' && m.bundle) {
      const actual = bundleManifest(videoDir).hash
      if (actual !== m.bundle.manifestHash)
        throw new StepError(
          `video/ changed since prepare-run restored it (got ${actual}). Render-unchanged runs must not edit files. Stop and report this.`,
        )
      log('bundle.verified', { manifestHash: actual })
    }
  }

  // Recorded takes stay in .va-run/ (plan 2026-11-02 §6.3): nothing rendered, previewed or archived may hold one.
  assertNoTakesInVideo()
  // HyperFrames keeps only the first 512 points of a lane and says nothing (docs/spikes.md S12): refuse lanes it would
  // cut. Narrated renders keep their own, stricter cap (the duck lane under narration stays at MAX_AUTOMATION_POINTS).
  const cap = narrationOf(readFileSync(join(videoDir, 'index.html'), 'utf8')).narrated
    ? MAX_AUTOMATION_POINTS
    : HYPERFRAMES_AUTOMATION_POINTS
  const longLanes = compositionFiles(videoDir)
    .filter((f) => f.endsWith('.html'))
    .flatMap((f) =>
      automationOverCap(readFileSync(join(videoDir, f), 'utf8'), cap).map((l) => ({ file: f, ...l })),
    )
  if (longLanes.length)
    throw new StepError(
      `automation_over_cap: ${longLanes.map((l) => `${l.file} #${l.element} ${l.target} has ${l.points} points`).join('; ')}. Keep every data-automation lane at ${cap} points or fewer (HyperFrames silently drops points past ${HYPERFRAMES_AUTOMATION_POINTS}).`,
    )
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
  // The MP4 keeps its sound; only the previews below drop it. A composition with <audio> and no track is logged.
  const audioCodecs = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    video,
  ])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const wantsAudio = /<audio\b/i.test(indexHtml) || /data-has-audio\s*=\s*["']true["']/i.test(indexHtml)
  log(wantsAudio && !audioCodecs.length ? 'render.audio_missing' : 'render.audio', {
    codecs: audioCodecs,
    composed: wantsAudio,
  })

  // Narrated renders only (plan 2026-11-02 §6.3 step 7): one master gain on the final mix, audio re-encoded, video
  // packets copied. Every other video keeps the sound HyperFrames rendered.
  const narration = narrationOf(indexHtml)
  let mastering: MasteringReport | undefined
  if (narration.narrated && audioCodecs.length) {
    const t = Date.now()
    mastering = master(video, { speech: narration.speech })
    log('mastering', { ms: Date.now() - t, ...mastering })
  }

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
  writeFileSync(
    join(out, 'captions.vtt'),
    toVtt(captionsForRender(summary.captions, narrationOp), durationSec),
  )
  // Recorded narration's own outputs (plan 2026-11-02 §6.7): the processed bus as a 192 kbps CBR MP3 (48 kHz: MP3
  // has no 192 kbps at the bus's 24 kHz), and the transcript, a paragraph per cue. Narrated renders only.
  const narrationOutputs: NarrationOutput[] = []
  if (narrationOp) {
    const bus = join(videoDir, NARRATION_SRC)
    if (existsSync(bus)) {
      run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        bus,
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        join(out, 'narration.mp3'),
      ])
      narrationOutputs.push('narration.mp3')
    }
    const stt = readSttRecord(repoRoot)
    const text = stt?.status === 'ok' ? transcriptText(groupWords(stt.words)) : ''
    if (text) {
      writeFileSync(join(out, 'transcript.txt'), text)
      narrationOutputs.push('transcript.txt')
    }
    log('narration.outputs', { files: narrationOutputs, stt: stt?.status ?? 'missing' })
  }
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
    Partial<Record<PreviewFile | NarrationOutput, { sha256: string; bytes: number }>>

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
  for (const name of narrationOutputs) {
    const [bin, ...pre] = cli as [string, ...string[]]
    await withRetries(`upload ${name}`, 4, () =>
      run(
        bin,
        [...pre, 'blobs:set', 'uploads', `${attempt}/${name}`, '--input', join(out, name), '--force'],
        { timeoutMs: 5 * 60_000 },
      ),
    )
    files[name] = entry(name)
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
  const references = await uploadReferences(attempt, videoDir)
  log('upload.done', { ms: Date.now() - started })
  // What finalize records on the version (versions.narration and versions.captions): the receipt, summed up.
  const narrationReport = narrationOp ? narrationReportOf(readNarrationReceipt(repoRoot)) : undefined

  const manifest = {
    jobId: job,
    attemptId: attempt,
    title: typeof summary.title === 'string' ? summary.title.slice(0, 120) : '',
    summary: typeof summary.summary === 'string' ? summary.summary.slice(0, 4000) : '',
    files,
    // Only when there are some, so every other manifest keeps its shape.
    ...(references.length ? { references } : {}),
    ...(previews.lqip ? { lqip: previews.lqip } : {}),
    // Why a variant is missing, so the service can log it (the run's own output isn't kept).
    ...(previews.skipped.length
      ? {
          previewsSkipped: previews.skipped
            .slice(0, 12)
            .map((s) => ({ name: s.name, reason: s.reason.slice(0, 300) })),
        }
      : {}),
    ...(mastering ? { mastering } : {}),
    ...(narrationReport ? { narration: narrationReport } : {}),
    durationSec,
    width: stream.width,
    height: stream.height,
    tools: {
      hyperframes:
        run('npx', ['-y', 'hyperframes', '--version'], { cwd: videoDir }).trim().split('\n').pop() ?? '',
      quality: QUALITY,
    },
  }

  // Kept on disk too, so the agent can print it again without rendering again (a second render overwrites the uploads).
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))

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

/** The receipt as the callback carries it: the recipe, the bus and how transcription went (no words, no spans). */
function narrationReportOf(r: ReturnType<typeof readNarrationReceipt>): NarrationReport | undefined {
  if (!r) return undefined
  return {
    pipeline: r.pipeline,
    cleanup: r.recipe.cleanup,
    ffmpeg: r.recipe.ffmpeg.slice(0, 200),
    bus: { sha256: r.bus.sha256, samples: r.bus.samples },
    stt: r.stt
      ? { status: r.stt.status, provider: r.stt.provider, model: r.stt.model, words: r.stt.words }
      : null,
  }
}

main().catch((e: unknown) => {
  log('failed', { error: e instanceof Error ? e.message : String(e) })
  console.error(`\nrender-job failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
