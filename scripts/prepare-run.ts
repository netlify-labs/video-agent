// Run first when the prompt says so: sets video/ up from the run manifest the server wrote for this attempt.
//   npx tsx scripts/prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>
// The manifest lives in the sources store at <jobId>/runs/<attempt>.json and must match the hash in the prompt.
// Only keys inside it are followed. Revisions restore the parent's source archive; render-unchanged runs restore
// a frozen bundle and verify its canonical file manifest (keeping copies of the files a re-voice may rewrite); incorporate-feedback runs also get one still per pinned
// comment in video/feedback/, and library media is downloaded into video/assets/media/. Never falls back to the template: on any failure it
// exits non-zero and the agent must stop. Writes the verified manifest to .render/run-manifest.json for render-job.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import { FROZEN_DIR, FROZEN_FILES, keptHash } from '../src/lib/revoice.js'
import {
  feedbackStillPath,
  runManifestKey,
  verifyRunManifest,
  type FeedbackPin,
  type RunManifest,
} from '../src/lib/run-manifest.js'
import {
  StepError,
  log,
  netlifyCli,
  parseArgs,
  repoRoot,
  run,
  sha256File,
  withRetries,
} from './lib/run-tools.js'

type Fetch = (key: string, to: string, store?: 'sources' | 'videos' | 'media') => Promise<void>

const download: Fetch = async (key, to, store = 'sources') => {
  const [bin, ...pre] = netlifyCli() as [string, ...string[]]
  await withRetries(`download ${key}`, 4, () =>
    run(bin, [...pre, 'blobs:get', store, key, '--output', to], { timeoutMs: 5 * 60_000 }),
  )
}

/**
 * One still per pinned comment from the parent MP4, with a dot at the spot, into video/feedback/ (plan v2 §5).
 * index.json maps each still to its comment so the agent can match them with the comments in the prompt.
 */
export function feedbackStills(root: string, parentMp4: string, pins: FeedbackPin[]) {
  const dir = join(root, 'video', 'feedback')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const duration = Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', parentMp4]).trim(),
  )
  const index = pins.map((p, i) => {
    // A pin at (or past) the very end still gets the last frame.
    const at = Math.max(0, Math.min(p.timeSec, duration > 0.1 ? duration - 0.05 : 0))
    const filters = ["scale='min(1280,iw)':-2"]
    if (p.x !== null && p.y !== null)
      filters.push(
        `drawbox=x=iw*${p.x}-15:y=ih*${p.y}-15:w=30:h=30:color=white@0.95:t=fill`,
        `drawbox=x=iw*${p.x}-10:y=ih*${p.y}-10:w=20:h=20:color=red@0.95:t=fill`,
      )
    const still = feedbackStillPath(i, p.commentId)
    run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      at.toFixed(3),
      '-i',
      parentMp4,
      '-frames:v',
      '1',
      '-vf',
      filters.join(','),
      '-q:v',
      '3',
      join(root, 'video', still),
    ])
    return { still, commentId: p.commentId, timeSec: p.timeSec, x: p.x, y: p.y }
  })
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2))
  log('feedback.stills', { count: index.length })
  return index
}

/** Unpacks a verified archive over <root>/video (the archive holds video/…). */
function restoreArchive(root: string, archive: string, sha256: string, what: string) {
  const actual = sha256File(archive)
  if (actual !== sha256)
    throw new StepError(`The saved ${what} doesn't match its hash (got ${actual}). Stop and report this.`)
  const listing = run('tar', ['-tzf', archive]) // validates the archive before touching video/
  for (const entry of listing.split('\n').filter(Boolean))
    if (!entry.startsWith('video/') || entry.split('/').includes('..'))
      throw new StepError(`The saved ${what} has an unexpected entry (${entry}). Stop and report this.`)
  rmSync(join(root, 'video'), { recursive: true, force: true })
  run('tar', ['-xzf', archive, '-C', root])
}

/** Restores what the manifest lists. `root` and `fetch` are injectable for tests. */
/** A second check of a clip with ffprobe (the upload was checked without it): H.264, AAC or no audio, ≤ 2 min. */
export function probeClip(path: string, name: string) {
  let info: { streams?: { codec_type?: string; codec_name?: string }[]; format?: { duration?: string } }
  try {
    info = JSON.parse(
      run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', path],
        { timeoutMs: 60_000 },
      ),
    ) as typeof info
  } catch (e) {
    throw new StepError(
      `Clip ${name} can't be read (${e instanceof Error ? e.message.slice(0, 200) : 'ffprobe failed'}). Stop and report this.`,
    )
  }
  const video = info.streams?.find((s) => s.codec_type === 'video')
  const audio = info.streams?.filter((s) => s.codec_type === 'audio') ?? []
  const duration = Number(info.format?.duration)
  if (video?.codec_name !== 'h264') throw new StepError(`Clip ${name} isn't H.264. Stop and report this.`)
  if (audio.some((s) => s.codec_name !== 'aac'))
    throw new StepError(`Clip ${name} has non-AAC audio. Stop and report this.`)
  if (!(duration > 0) || duration > 120.5)
    throw new StepError(`Clip ${name} is longer than 2 minutes. Stop and report this.`)
}

/** A second check of a library audio file with ffprobe: it has an audio stream and lasts at most 10 minutes. */
export function probeAudio(path: string, name: string) {
  let info: { streams?: { codec_type?: string }[]; format?: { duration?: string } }
  try {
    info = JSON.parse(
      run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path],
        {
          timeoutMs: 60_000,
        },
      ),
    ) as typeof info
  } catch (e) {
    throw new StepError(
      `Audio ${name} can't be read (${e instanceof Error ? e.message.slice(0, 200) : 'ffprobe failed'}). Stop and report this.`,
    )
  }
  if (!info.streams?.some((s) => s.codec_type === 'audio'))
    throw new StepError(`Audio ${name} has no audio stream. Stop and report this.`)
  if (Number(info.format?.duration) > 600.5)
    throw new StepError(`Audio ${name} is longer than 10 minutes. Stop and report this.`)
}

export async function prepare(m: RunManifest, opts: { tmp: string; root?: string; fetch?: Fetch }) {
  const { tmp, root = repoRoot, fetch = download } = opts
  if (m.source) {
    const archive = join(tmp, 'source.tar.gz')
    await fetch(m.source.key, archive)
    restoreArchive(root, archive, m.source.sha256, 'composition')
    log('restored', { kind: 'source', key: m.source.key, parentN: m.source.parentN })
  }
  if (m.bundle) {
    const archive = join(tmp, 'bundle.tar.gz')
    await fetch(m.bundle.key, archive)
    restoreArchive(root, archive, m.bundle.sha256, 'bundle')
    const restored = bundleManifest(join(root, 'video'))
    const actual = restored.hash
    if (actual !== m.bundle.manifestHash)
      throw new StepError(
        `The restored bundle's files don't match its manifest (got ${actual}). Stop and report this.`,
      )
    log('restored', { kind: 'bundle', key: m.bundle.key, manifestHash: actual })
    // Lines to re-voice: keep the frozen copies of the files voice.ts revoice rewrites, for render-job's check.
    const frozen = join(root, FROZEN_DIR)
    rmSync(frozen, { recursive: true, force: true })
    if (m.bundle.revoice) {
      if (keptHash(restored.files, m.bundle.revoice.beats) !== m.bundle.revoice.keptHash)
        throw new StepError("The restored bundle doesn't match its re-voice manifest. Stop and report this.")
      for (const p of FROZEN_FILES) {
        const from = join(root, 'video', p)
        if (!existsSync(from))
          throw new StepError(`The restored bundle has no video/${p} to re-voice from. Stop and report this.`)
        mkdirSync(dirname(join(frozen, p)), { recursive: true })
        copyFileSync(from, join(frozen, p))
      }
      log('revoice.planned', { beats: m.bundle.revoice.beats })
    }
  }
  // Library media by reference (plan v2 §9): exactly the snapshotted bytes, each one verified.
  if (m.media?.length) {
    const dir = join(root, 'video', 'assets', 'media')
    mkdirSync(dir, { recursive: true })
    for (const item of m.media) {
      const to = join(dir, item.filename)
      await fetch(item.key, to, 'media')
      const actual = sha256File(to)
      if (actual !== item.sha256)
        throw new StepError(
          `Media ${item.filename} doesn't match its hash (got ${actual}). Stop and report this.`,
        )
      if (item.kind === 'video') probeClip(to, item.filename)
      if (item.kind === 'audio') probeAudio(to, item.filename)
    }
    log('media', { count: m.media.length, files: m.media.map((x) => x.filename) })
  }
  // After any restore, so the stills land in the restored video/.
  if (m.feedback) {
    const mp4 = join(tmp, 'parent.mp4')
    await fetch(m.feedback.video.key, mp4, 'videos')
    const actual = sha256File(mp4)
    if (actual !== m.feedback.video.sha256)
      throw new StepError(`The parent video doesn't match its hash (got ${actual}). Stop and report this.`)
    feedbackStills(root, mp4, m.feedback.pins)
  }
}

async function main() {
  const { job, attempt, manifest: sha } = parseArgs(process.argv.slice(2))
  if (!job || !attempt || !sha || !/^[0-9a-f]{64}$/.test(sha))
    throw new StepError('Usage: prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>')
  const tmp = join(repoRoot, '.render', `${attempt}-prepare`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const local = join(tmp, 'run.json')
  await download(runManifestKey(job, attempt), local)
  let m: RunManifest
  try {
    m = verifyRunManifest(readFileSync(local, 'utf8'), { attemptId: attempt, sha256: sha })
  } catch (e) {
    throw new StepError(`${e instanceof Error ? e.message : String(e)} Stop and report this.`)
  }
  if (m.jobId !== job) throw new StepError('The run manifest is for a different video. Stop and report this.')
  log('manifest', {
    kind: m.kind,
    source: Boolean(m.source),
    bundle: Boolean(m.bundle),
    pins: m.feedback?.pins.length ?? 0,
  })
  await prepare(m, { tmp })
  writeFileSync(join(repoRoot, '.render', 'run-manifest.json'), JSON.stringify(m))
  console.log(
    m.kind === 'revision'
      ? `Restored video/ from version ${m.source?.parentN}. Continue with the revision.`
      : 'video/ is ready. Continue.',
  )
}

if (process.argv[1]?.endsWith('prepare-run.ts'))
  main().catch((e: unknown) => {
    console.error(`prepare-run failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
