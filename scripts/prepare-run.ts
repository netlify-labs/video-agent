// Run first when the prompt says so: sets video/ up from the run manifest the server wrote for this attempt.
//   npx tsx scripts/prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>
// The manifest lives in the sources store at <jobId>/runs/<attempt>.json and must match the hash in the prompt.
// Only keys inside it are followed. Revisions restore the parent's source archive; render-unchanged runs restore
// a frozen bundle and verify its canonical file manifest (keeping copies of the files a re-voice may rewrite), each
// with its reference files (the narration bus) fetched by key and checked; incorporate-feedback runs also get one still per pinned
// comment in video/feedback/, and library media is downloaded into video/assets/media/. Recorded narration's takes are
// hydrated into .va-run/narration/ (outside video/: never archived, checkpointed or previewed; scripts/narration.ts
// mixes them). Never falls back to the template: on any failure it
// exits non-zero and the agent must stop. Writes the verified manifest to .render/run-manifest.json for render-job.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import type { BundleReference } from '../src/lib/bundle-references.js'
import { frozenFilesFor, optionalFrozenFilesFor } from '../src/lib/narration-run.js'
import { FROZEN_DIR, keptHash } from '../src/lib/revoice.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import {
  feedbackStillPath,
  runManifestKey,
  verifyRunManifest,
  type FeedbackPin,
  type FrozenNarration,
  type RunManifest,
} from '../src/lib/run-manifest.js'
import { MAX_OUTPUT_SAMPLES, SAMPLE_RATE } from '../src/lib/timeline.js'
import { narrationPaths, type HydratedTake, type NarrationInputs } from './lib/narration-inputs.js'
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

/** Fetches an archive's reference files into <root>/video by key, each checked against its entry. */
async function restoreReferences(
  root: string,
  refs: BundleReference[] | undefined,
  fetch: Fetch,
  what: string,
) {
  for (const r of refs ?? []) {
    const to = join(root, 'video', r.path)
    mkdirSync(dirname(to), { recursive: true })
    await fetch(r.key, to, 'videos')
    const actual = sha256File(to)
    if (actual !== r.sha256 || statSync(to).size !== r.bytes) {
      rmSync(to, { force: true })
      throw new StepError(
        `The saved ${what}'s ${r.path} doesn't match its hash (got ${actual}). Stop and report this.`,
      )
    }
  }
  if (refs?.length) log('references', { what, files: refs.map((r) => r.path) })
}

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

/**
 * ffprobe of a take: whether it already is what the run mixes (24 kHz mono PCM16 WAV, as the recorder uploads), or
 * at least has audio within the 15-minute output limit to decode.
 */
export function probeTake(path: string, mediaId: string): { pcm16: boolean } {
  let info: {
    streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }[]
    format?: { format_name?: string; duration?: string }
  }
  try {
    info = JSON.parse(
      run(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,sample_rate,channels:format=format_name,duration',
          '-of',
          'json',
          path,
        ],
        { timeoutMs: 60_000 },
      ),
    ) as typeof info
  } catch (e) {
    throw new StepError(
      `Narration take ${mediaId} can't be read (${e instanceof Error ? e.message.slice(0, 200) : 'ffprobe failed'}). Stop and report this.`,
    )
  }
  const audio = info.streams?.filter((s) => s.codec_type === 'audio') ?? []
  if (!audio.length)
    throw new StepError(`Narration take ${mediaId} has no audio stream. Stop and report this.`)
  if (Number(info.format?.duration) > MAX_OUTPUT_SAMPLES / SAMPLE_RATE + 0.5)
    throw new StepError(`Narration take ${mediaId} is longer than 15 minutes. Stop and report this.`)
  const [a] = audio
  return {
    pcm16:
      audio.length === 1 &&
      info.streams?.length === 1 &&
      info.format?.format_name === 'wav' &&
      a?.codec_name === 'pcm_s16le' &&
      Number(a.sample_rate) === SAMPLE_RATE &&
      a.channels === 1,
  }
}

/**
 * Recorded narration's takes (plan 2026-11-02 §6.3 "Run inputs"): each fetched by key from the media store like
 * library media, checked against its frozen sha256 and size, then put in .va-run/narration/src/<mediaId>.wav as
 * 24 kHz mono PCM16 (a recording as it is; any other upload decoded with ffmpeg, single-threaded and bitexact). Never
 * under video/. Writes .va-run/narration/manifest.json for scripts/narration.ts. A run without narration gets no
 * .va-run/narration/ at all, so a stale one from an earlier attempt can't be mixed.
 */
export async function hydrateNarration(
  root: string,
  m: Pick<RunManifest, 'jobId' | 'attemptId'>,
  n: FrozenNarration | undefined,
  fetch: Fetch,
): Promise<NarrationInputs | null> {
  const p = narrationPaths(root)
  rmSync(p.dir, { recursive: true, force: true })
  if (!n) return null
  const started = Date.now()
  for (const d of [p.fetch, p.src]) mkdirSync(d, { recursive: true })
  const takes: HydratedTake[] = []
  for (const t of n.takes) {
    const ext = /\.([a-z0-9]{2,5})$/.exec(t.key)?.[1] ?? 'bin'
    const raw = join(p.fetch, `${t.mediaId}.${ext}`)
    await fetch(t.key, raw, 'media')
    const actual = sha256File(raw)
    if (actual !== t.sha256 || statSync(raw).size !== t.bytes) {
      rmSync(p.dir, { recursive: true, force: true })
      throw new StepError(
        `Narration take ${t.mediaId} doesn't match its hash (got ${actual}). Stop and report this.`,
      )
    }
    const to = join(p.src, `${t.mediaId}.wav`)
    const { pcm16 } = probeTake(raw, t.mediaId)
    if (pcm16) renameSync(raw, to)
    else {
      run(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-y',
          '-threads',
          '1',
          '-i',
          raw,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          '-map_metadata',
          '-1',
          '-fflags',
          '+bitexact',
          '-flags:a',
          '+bitexact',
          to,
        ],
        { timeoutMs: 5 * 60_000 },
      )
      rmSync(raw, { force: true })
    }
    let samples: number
    try {
      const pcm = readPcm16(readFileSync(to))
      if (pcm.sampleRate !== SAMPLE_RATE || pcm.channels !== 1) throw new Error('not 24 kHz mono')
      samples = pcm.samples.length
    } catch (e) {
      throw new StepError(
        `Narration take ${t.mediaId} didn't become 24 kHz mono PCM16 (${e instanceof Error ? e.message : String(e)}). Stop and report this.`,
      )
    }
    takes.push({
      mediaId: t.mediaId,
      key: t.key,
      sha256: t.sha256,
      bytes: t.bytes,
      ...(t.license ? { license: t.license } : {}),
      path: relative(root, to),
      wavSha256: sha256File(to),
      samples,
      decoded: !pcm16,
    })
  }
  rmSync(p.fetch, { recursive: true, force: true })
  const inputs: NarrationInputs = {
    v: 1,
    jobId: m.jobId,
    attemptId: m.attemptId,
    op: n.op,
    recipe: n.recipe,
    targetSamples: n.targetSamples,
    captions: n.captions,
    ...(n.transcriptionProvider ? { transcriptionProvider: n.transcriptionProvider } : {}),
    takes,
  }
  writeFileSync(p.manifest, JSON.stringify(inputs, null, 2))
  log('narration.hydrated', {
    ms: Date.now() - started,
    takes: takes.map((t) => ({ mediaId: t.mediaId, samples: t.samples, decoded: t.decoded })),
  })
  return inputs
}

/** Restores what the manifest lists. `root` and `fetch` are injectable for tests. */
export async function prepare(m: RunManifest, opts: { tmp: string; root?: string; fetch?: Fetch }) {
  const { tmp, root = repoRoot, fetch = download } = opts
  if (m.source) {
    const archive = join(tmp, 'source.tar.gz')
    await fetch(m.source.key, archive)
    restoreArchive(root, archive, m.source.sha256, 'composition')
    await restoreReferences(root, m.source.references, fetch, 'composition')
    log('restored', { kind: 'source', key: m.source.key, parentN: m.source.parentN })
  }
  if (m.bundle) {
    const archive = join(tmp, 'bundle.tar.gz')
    await fetch(m.bundle.key, archive)
    restoreArchive(root, archive, m.bundle.sha256, 'bundle')
    await restoreReferences(root, m.bundle.references, fetch, 'bundle')
    const restored = bundleManifest(join(root, 'video'))
    const actual = restored.hash
    if (actual !== m.bundle.manifestHash)
      throw new StepError(
        `The restored bundle's files don't match its manifest (got ${actual}). Stop and report this.`,
      )
    log('restored', { kind: 'bundle', key: m.bundle.key, manifestHash: actual })
    // Lines to re-voice or narration to mix: keep the frozen copies of the files those steps rewrite (narration-run.ts),
    // for render-job's checks.
    const frozen = join(root, FROZEN_DIR)
    rmSync(frozen, { recursive: true, force: true })
    if (m.bundle.revoice && keptHash(restored.files, m.bundle.revoice.beats) !== m.bundle.revoice.keptHash)
      throw new StepError("The restored bundle doesn't match its re-voice manifest. Stop and report this.")
    const optional = optionalFrozenFilesFor(m.bundle)
    for (const p of [...frozenFilesFor(m.bundle), ...optional]) {
      const from = join(root, 'video', p)
      if (!existsSync(from)) {
        if (optional.includes(p)) continue
        throw new StepError(`The restored bundle has no video/${p} to work from. Stop and report this.`)
      }
      mkdirSync(dirname(join(frozen, p)), { recursive: true })
      copyFileSync(from, join(frozen, p))
    }
    if (m.bundle.revoice) log('revoice.planned', { beats: m.bundle.revoice.beats })
  }
  await hydrateNarration(root, m, m.bundle?.narration, fetch)
  // Library media by reference (plan v2 §9): exactly the snapshotted bytes, each one verified. PDFs are reference
  // reading for the agent, so they go to context/media/, outside the composition and its source archive.
  if (m.media?.length) {
    for (const item of m.media) {
      const dir =
        item.kind === 'pdf' ? join(root, 'context', 'media') : join(root, 'video', 'assets', 'media')
      mkdirSync(dir, { recursive: true })
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
