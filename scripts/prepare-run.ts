// Run first when the prompt says so: sets video/ up from the run manifest the server wrote for this attempt.
//   npx tsx scripts/prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>
// The manifest lives in the sources store at <jobId>/runs/<attempt>.json and must match the hash in the prompt.
// Local mode adds --inputs <dir> (or VA_INPUTS_DIR): every key is read from <dir>/<store>/<key> instead of Blobs, with
// the same store names and keys, and everything after the fetch is the same (cli-and-sdk plan §7; va-p1th.5.2).
// Only keys inside it are followed. Revisions restore the parent's source archive; render-unchanged runs restore
// a frozen bundle and verify its canonical file manifest (keeping copies of the files a re-voice may rewrite), and
// fit-to-narration runs (author_from_frozen) restore the frozen edited draft the same way, keeping all of it, each
// with its reference files (the narration bus) fetched by key and checked; incorporate-feedback runs also get one still per pinned
// comment in video/feedback/, and library media is downloaded into video/assets/media/. Recorded narration's takes are
// hydrated into .va-run/narration/ (outside video/: never archived, checkpointed or previewed; scripts/narration.ts
// mixes them). Never falls back to the template: on any failure it
// exits non-zero and the agent must stop. Writes the verified manifest to .render/run-manifest.json for render-job.
//
// The steps, in the order other plans add to (docs/plans/2026-11-04-render-engines.md §4.3); each is skipped when the
// manifest doesn't ask for it:
//   1. Source: the engine's scaffold for author runs, or the restore of a source or bundle (and recorded narration's
//      takes) and then the engine's hydrate for every other kind. HyperFrames has neither hook.
//   2. Library media into video/assets/media/ (PDFs into context/media/).
//   3. The look (looks plan).
//   4. Recording files (screen-recording plan), then scope files (regenerate-beat plan).
//   5. Feedback and scope stills, last: feedbackStills empties video/feedback/ first, so nothing else may write into
//      video/ after it.
//   6. .render/run-manifest.json for render-job (main()).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { archiveFiles, bundleManifest } from '../src/lib/bundle-manifest.js'
import type { BundleReference } from '../src/lib/bundle-references.js'
import { NARRATION_SRC, load, read } from '../src/lib/contract.js'
import { frozenFilesFor, optionalFrozenFilesFor } from '../src/lib/narration-run.js'
import { LOOK_ARCHIVE_ROOT, lookFiles, lookHash } from '../src/lib/looks.js'
import { FROZEN_DIR, keptHash } from '../src/lib/revoice.js'
import { SCOPE_LAYOUT_FILE, type ScopeLayout } from '../src/lib/scope.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import {
  feedbackStillPath,
  runManifestKey,
  verifyRunManifest,
  type FeedbackPin,
  runEngineId,
  type FrozenNarration,
  type RunLook,
  type RunManifest,
  type RunRecording,
  type ScopeStill,
} from '../src/lib/run-manifest.js'
import { RECORDING_LIMITS } from '../src/lib/media/classify.js'
import { MAX_OUTPUT_SAMPLES, SAMPLE_RATE } from '../src/lib/timeline.js'
import { runEngineFor } from './lib/engines/index.js'
import type { RunEngine } from './lib/engines/types.js'
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
  const t = Date.now()
  const [bin, ...pre] = netlifyCli() as [string, ...string[]]
  await withRetries(`download ${key}`, 4, () =>
    run(bin, [...pre, 'blobs:get', store, key, '--output', to], { timeoutMs: 5 * 60_000 }),
  )
  log('prepare.fetch', { store, key, bytes: statSync(to).size, ms: Date.now() - t, mode: 'blobs' })
}

/**
 * Local mode's fetch: <dir>/<store>/<key>, the layout the CLI writes with the server's own key builders. A key that
 * would leave the folder (.., an absolute path, a symlink that resolves outside) is refused, never followed.
 */
export function fromInputs(dir: string): Fetch {
  const top = realpathSync(dir)
  return async (key, to, store = 'sources') => {
    const t = Date.now()
    const outside = () =>
      new StepError(`The input ${store}/${key} is outside the inputs folder. Stop and report this.`)
    if (!key || isAbsolute(key) || key.includes('\\') || key.split('/').includes('..')) throw outside()
    const file = join(top, store, key)
    if (!existsSync(file))
      throw new StepError(
        `download ${key} failed: ${store}/${key} is not in the inputs folder. Stop and report this.`,
      )
    const real = realpathSync(file)
    if (!real.startsWith(`${top}${sep}`)) throw outside()
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(real, to)
    log('prepare.fetch', { store, key, bytes: statSync(to).size, ms: Date.now() - t, mode: 'inputs' })
  }
}

export { SCOPE_LAYOUT_FILE, type ScopeLayout } from '../src/lib/scope.js'

/**
 * One still per pinned comment from the parent MP4, with a dot at the spot, into video/feedback/ (plan v2 §5).
 * index.json maps each still to its comment so the agent can match them with the comments in the prompt. A scoped
 * revision's stills of its neighbours (redo a scene, plan §4.3) come from the same MP4 in the same call, with no dot,
 * listed after the pins: this function empties video/feedback/ first, so it's the only place stills are made.
 */
export function feedbackStills(
  root: string,
  parentMp4: string,
  pins: FeedbackPin[],
  scopeStills: readonly ScopeStill[] = [],
) {
  const dir = join(root, 'video', 'feedback')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  if (scopeStills.length) mkdirSync(join(dir, 'scope'), { recursive: true })
  const duration = Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', parentMp4]).trim(),
  )
  // A still at (or past) the very end still gets the last frame.
  const clamp = (t: number) => Math.max(0, Math.min(t, duration > 0.1 ? duration - 0.05 : 0))
  const grab = (still: string, atSec: number, filters: string[]) =>
    run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      clamp(atSec).toFixed(3),
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
  const scale = "scale='min(1280,iw)':-2"
  const pinned = pins.map((p, i) => {
    const filters = [scale]
    if (p.x !== null && p.y !== null)
      filters.push(
        `drawbox=x=iw*${p.x}-15:y=ih*${p.y}-15:w=30:h=30:color=white@0.95:t=fill`,
        `drawbox=x=iw*${p.x}-10:y=ih*${p.y}-10:w=20:h=20:color=red@0.95:t=fill`,
      )
    const still = feedbackStillPath(i, p.commentId)
    grab(still, p.timeSec, filters)
    return { still, commentId: p.commentId, timeSec: p.timeSec, x: p.x, y: p.y }
  })
  const scoped = scopeStills.map((s) => {
    grab(s.path, s.atSec, [scale])
    return { still: s.path, beat: s.beat, what: s.what, atSec: s.atSec }
  })
  const index = [...pinned, ...scoped]
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2))
  log('feedback.stills', { count: index.length, pins: pinned.length, scope: scoped.length })
  return index
}

/**
 * A demo's recording inputs (screen-recording plan §5.5), outside video/ so they never reach the archive: the frozen
 * pointer trace (hash checked) at .va-run/recording/<id>/trace.json, and the person's boxes, trim, privacy mode and
 * hide strings in input.json (recording.ts analyze scans for those; plan and check read the rest).
 */
export async function hydrateRecording(root: string, r: RunRecording, fetch: Fetch) {
  const dir = join(root, '.va-run', 'recording', r.mediaId)
  mkdirSync(dir, { recursive: true })
  if (r.trace) {
    const to = join(dir, 'trace.json')
    await fetch(r.trace.key, to, 'media')
    if (sha256File(to) !== r.trace.sha256) {
      rmSync(to, { force: true })
      throw new StepError("The pointer trace doesn't match its hash. Stop and report this.")
    }
  }
  writeFileSync(
    join(dir, 'input.json'),
    `${JSON.stringify(
      {
        boxes: r.boxes,
        ...(r.trim ? { trim: r.trim } : {}),
        ...(r.privacy ? { privacy: true } : {}),
        ...(r.hideStrings?.length ? { hideStrings: r.hideStrings } : {}),
      },
      null,
      2,
    )}\n`,
  )
  log('recording', {
    mediaId: r.mediaId,
    trace: Boolean(r.trace),
    boxes: r.boxes.length,
    trim: r.trim ?? null,
    privacy: r.privacy === true,
    hideStrings: r.hideStrings?.length ?? 0,
  })
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

/**
 * Unpacks the version's look snapshot into <root>/context/look/ and checks it: the archive's sha256, entries only under
 * look/, and the unpacked files' look hash (the same lookHash the build recorded), so the run reads exactly the rules
 * the version was made with.
 */
async function restoreLook(root: string, look: RunLook, tmp: string, fetch: Fetch) {
  const archive = join(tmp, 'look.tar.gz')
  await fetch(look.key, archive)
  const actual = sha256File(archive)
  if (actual !== look.sha256)
    throw new StepError(`The saved look doesn't match its hash (got ${actual}). Stop and report this.`)
  const listing = run('tar', ['-tzf', archive]) // validates the archive before touching context/look/
  for (const entry of listing.split('\n').filter(Boolean))
    if (!entry.startsWith(`${LOOK_ARCHIVE_ROOT}/`) || entry.split('/').includes('..'))
      throw new StepError(`The saved look has an unexpected entry (${entry}). Stop and report this.`)
  const unpacked = join(tmp, 'look-unpacked')
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  run('tar', ['-xzf', archive, '-C', unpacked])
  const dir = join(root, 'context', 'look')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dirname(dir), { recursive: true })
  renameSync(join(unpacked, LOOK_ARCHIVE_ROOT), dir)
  const files = new Map(lookFiles(dir).map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))]))
  const hash = lookHash(files)
  if (hash !== look.hash) {
    rmSync(dir, { recursive: true, force: true })
    throw new StepError(`The restored look's files don't match its hash (got ${hash}). Stop and report this.`)
  }
  log('look.restored', { id: look.id, hash, files: files.size })
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

/**
 * A second check of a clip with ffprobe (the upload was checked without it): H.264, AAC or no audio, ≤ 2 min; a screen
 * recording (the manifest's recording) may run 5 minutes (RECORDING_LIMITS, screen-recording plan gotcha 2).
 */
export function probeClip(path: string, name: string, opts: { role?: 'screen-recording' } = {}) {
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
  const recording = opts.role === 'screen-recording'
  const max = recording ? RECORDING_LIMITS.seconds : 120
  if (!(duration > 0) || duration > max + 0.5)
    throw new StepError(`Clip ${name} is longer than ${recording ? '5' : '2'} minutes. Stop and report this.`)
}

interface ProbedStreams {
  streams?: { codec_type?: string; codec_name?: string }[]
  format?: { format_name?: string }
}

/**
 * Why a WebM/Matroska file isn't audio this app uses (plan 2026-11-02 §5.2: one Opus or Vorbis track, no video),
 * or null. The upload was checked structurally without ffprobe; this is the second look. Other formats pass.
 */
export function webmProblem(info: ProbedStreams): string | null {
  if (!/matroska|webm/.test(info.format?.format_name ?? '')) return null
  const streams = info.streams ?? []
  if (streams.some((s) => s.codec_type === 'video')) return 'has a video track'
  if (streams.length !== 1 || !['opus', 'vorbis'].includes(streams[0]?.codec_name ?? ''))
    return "isn't one Opus or Vorbis track"
  return null
}

/** A second check of a library audio file with ffprobe: it has an audio stream and lasts at most 10 minutes. */
export function probeAudio(path: string, name: string) {
  let info: ProbedStreams & { format?: { duration?: string } }
  try {
    info = JSON.parse(
      run(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name:format=format_name,duration',
          '-of',
          'json',
          path,
        ],
        { timeoutMs: 60_000 },
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
  const webm = webmProblem(info)
  if (webm) throw new StepError(`Audio ${name} ${webm}. Stop and report this.`)
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
  const webm = webmProblem(info)
  if (webm) throw new StepError(`Narration take ${mediaId} ${webm}. Stop and report this.`)
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
  m: Pick<RunManifest, 'jobId' | 'attemptId'> & { kind?: RunManifest['kind'] },
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
    ...(n.language ? { language: n.language } : {}),
    ...(m.kind === 'author_from_frozen' ? { fit: true as const } : {}),
    takes,
  }
  writeFileSync(p.manifest, JSON.stringify(inputs, null, 2))
  log('narration.hydrated', {
    ms: Date.now() - started,
    takes: takes.map((t) => ({ mediaId: t.mediaId, samples: t.samples, decoded: t.decoded })),
    ...(inputs.fit ? { fit: true, targetSamples: n.targetSamples } : {}),
  })
  return inputs
}

/** Restores what the manifest lists, in the steps above. `root`, `fetch` and `engine` are injectable for tests. */
export async function prepare(
  m: RunManifest,
  opts: { tmp: string; root?: string; fetch?: Fetch; engine?: Pick<RunEngine, 'scaffold' | 'hydrate'> },
) {
  const { tmp, root = repoRoot, fetch = download } = opts
  const engine = opts.engine ?? runEngineFor(runEngineId(m))
  let t = Date.now()
  const stepDone = (name: string, skipped: boolean) => {
    log('prepare.step', { name, ms: Date.now() - t, skipped })
    t = Date.now()
  }
  // 1. Source.
  if (m.kind === 'author') await engine.scaffold?.(join(root, 'video'))
  if (m.source) {
    const archive = join(tmp, 'source.tar.gz')
    await fetch(m.source.key, archive)
    restoreArchive(root, archive, m.source.sha256, 'composition')
    await restoreReferences(root, m.source.references, fetch, 'composition')
    log('restored', { kind: 'source', key: m.source.key, parentN: m.source.parentN })
    // A narrated parent's narration stays locked through the revision (plan 2026-11-02 §6.4), and a scoped revision
    // may only change its scenes (redo a scene, plan §4.5): keep the composition as restored, before library media or
    // any later step writes into video/, for render-job's narration_modified and scope checks. One copy serves both.
    const frozen = join(root, FROZEN_DIR)
    rmSync(frozen, { recursive: true, force: true })
    const narrated = m.source.references?.some((r) => r.path === NARRATION_SRC) ?? false
    if (narrated || m.scope) {
      const files = archiveFiles(join(root, 'video'))
      for (const p of files) {
        mkdirSync(dirname(join(frozen, p)), { recursive: true })
        copyFileSync(join(root, 'video', p), join(frozen, p))
      }
      if (narrated) log('narration.locked', { parentN: m.source.parentN })
      if (m.scope) log('scope.frozen', { parentN: m.source.parentN, files: files.length })
    }
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
    // for render-job's checks. A fit may change any file, so it keeps the whole frozen composition: the
    // narration_modified guard proves the copies against the bundle's manifest hash before it reads them.
    const frozen = join(root, FROZEN_DIR)
    rmSync(frozen, { recursive: true, force: true })
    if (m.bundle.revoice && keptHash(restored.files, m.bundle.revoice.beats) !== m.bundle.revoice.keptHash)
      throw new StepError("The restored bundle doesn't match its re-voice manifest. Stop and report this.")
    const optional = optionalFrozenFilesFor(m.bundle)
    const keep =
      m.kind === 'author_from_frozen'
        ? archiveFiles(join(root, 'video'))
        : [...frozenFilesFor(m.bundle), ...optional]
    for (const p of keep) {
      const from = join(root, 'video', p)
      if (!existsSync(from)) {
        if (optional.includes(p)) continue
        throw new StepError(`The restored bundle has no video/${p} to work from. Stop and report this.`)
      }
      mkdirSync(dirname(join(frozen, p)), { recursive: true })
      copyFileSync(from, join(frozen, p))
    }
    if (m.bundle.revoice) log('revoice.planned', { beats: m.bundle.revoice.beats })
    if (m.kind === 'author_from_frozen') log('frozen.kept', { kind: m.kind, files: keep.length })
  }
  await hydrateNarration(root, m, m.bundle?.narration, fetch)
  if (m.kind !== 'author') await engine.hydrate?.(join(root, 'video'))
  stepDone('source', m.kind === 'author' && !engine.scaffold)
  // 2. Library media.
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
      if (item.kind === 'video')
        probeClip(
          to,
          item.filename,
          m.recording?.filename === item.filename ? { role: 'screen-recording' } : {},
        )
      if (item.kind === 'audio') probeAudio(to, item.filename)
    }
    log('media', { count: m.media.length, files: m.media.map((x) => x.filename) })
  }
  stepDone('media', !m.media?.length)
  // 3. The look (looks plan §4.6): its snapshot into context/look/, outside the composition, so it's never archived.
  if (m.look) await restoreLook(root, m.look, tmp, fetch)
  stepDone('look', !m.look)
  // 4. Recording files, then scope files: the scoped beats and the parent's layout, read from the frozen copy (what
  // check-contract --fix and render-job splice against).
  if (m.recording) await hydrateRecording(root, m.recording, fetch)
  stepDone('recording', !m.recording)
  if (m.scope) {
    const html = readFileSync(join(root, FROZEN_DIR, 'index.html'), 'utf8')
    let layout: ScopeLayout['layout']
    try {
      layout = read(load(html)).beats.map((b) => ({
        id: b.id,
        label: b.label,
        start: b.start,
        duration: b.duration,
      }))
    } catch {
      throw new StepError("The restored composition can't be read as scenes. Stop and report this.")
    }
    const missing = m.scope.beats.filter((b) => !layout.some((x) => x.id === b))
    if (missing.length)
      throw new StepError(
        `The restored composition has no scene ${missing.map((b) => `"${b}"`).join(', ')}. Stop and report this.`,
      )
    const scope: ScopeLayout = { beats: [...m.scope.beats], layout }
    writeFileSync(join(root, FROZEN_DIR, SCOPE_LAYOUT_FILE), JSON.stringify(scope, null, 2))
    log('scope.layout', { beats: m.scope.beats, scenes: layout.length })
  }
  stepDone('scope', !m.scope)
  // 5. Stills, last: after any restore and every other write, so they land in the final video/.
  if (m.feedback) {
    const mp4 = join(tmp, 'parent.mp4')
    await fetch(m.feedback.video.key, mp4, 'videos')
    const actual = sha256File(mp4)
    if (actual !== m.feedback.video.sha256)
      throw new StepError(`The parent video doesn't match its hash (got ${actual}). Stop and report this.`)
    feedbackStills(root, mp4, m.feedback.pins, m.scope?.stills ?? [])
  }
  stepDone('stills', !m.feedback)
}

async function main() {
  const { job, attempt, manifest: sha, inputs = process.env.VA_INPUTS_DIR } = parseArgs(process.argv.slice(2))
  if (!job || !attempt || !sha || !/^[0-9a-f]{64}$/.test(sha))
    throw new StepError(
      'Usage: prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256> [--inputs <dir>]',
    )
  const fetch = inputs ? fromInputs(inputs) : download
  const tmp = join(repoRoot, '.render', `${attempt}-prepare`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const local = join(tmp, 'run.json')
  await fetch(runManifestKey(job, attempt), local)
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
  await prepare(m, { tmp, fetch })
  writeFileSync(join(repoRoot, '.render', 'run-manifest.json'), JSON.stringify(m))
  console.log(
    m.kind === 'revision'
      ? m.source?.parentN == null
        ? "Restored video/ from the video you're remixing. Continue with the remix."
        : `Restored video/ from version ${m.source.parentN}. Continue with the revision.`
      : m.kind === 'author_from_frozen'
        ? 'Restored video/ from the edited draft, with the recorded narration to fit. Continue.'
        : 'video/ is ready. Continue.',
  )
}

if (process.argv[1]?.endsWith('prepare-run.ts'))
  main().catch((e: unknown) => {
    console.error(`prepare-run failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
