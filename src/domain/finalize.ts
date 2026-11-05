// finalize-background: verify the agent's uploads against the authenticated manifest, validate the
// media, copy it to immutable keys and commit the version as ready. Idempotent; leased.
import type { Deps } from '../deps.js'
import { NARRATION_CLEANUP_PRESETS } from '../lib/timeline.js'
import {
  isReference,
  MAX_REFERENCE_BYTES,
  REFERENCE_FILES,
  REFERENCES_FILE,
  referenceKey,
  referencesKey,
  type BundleReference,
} from '../lib/bundle-references.js'
import { decrypt, sha256Hex } from '../lib/crypto.js'
import { sniffAudio } from '../lib/media/audio.js'
import { inspectMp4, Mp4Error, sniff } from '../lib/media/mp4.js'
import {
  MAX_PREVIEW_BYTES,
  PREVIEW_FILES,
  PREVIEW_NAMES,
  isLqip,
  sniffPreview,
  type Previews,
} from '../lib/media/previews.js'
import { readRunCredits, RUN_CREDITS_FILE, type RunCredit } from '../lib/openverse-rules.js'
import { attr, load, NARRATION_SRC } from '../lib/contract.js'
import { SCOPE_REFUSED_PREFIX } from '../lib/scope.js'
import { BUNDLE_LIMITS, readTarGz, type TarLimits } from '../lib/tar.js'
import { beatsOf } from './beats.js'
import { bundleContract, bundleShapeProblems, ensureBundle, inBundle } from './bundles.js'
import { engineInfo, engineOf, isEngineId, scopeCheckFor, type EngineId } from './engines.js'
import { carriedCaptions, narrationOpHash } from './captions.js'
import { getSettings } from './settings.js'
import { promoteAttemptRefs } from './takes.js'
import { deriveTitle, setStage } from './videos.js'
import { emitTerminalEvent } from './webhooks.js'
import {
  ASPECTS,
  NARRATION_OUTPUTS,
  OUTPUT_FILES,
  type AttemptRow,
  type FailureCategory,
  type Manifest,
  type NarrationOutput,
  type NarrationReport,
  type OutputFile,
  type VersionCaptions,
  type VersionNarration,
  type VersionRow,
} from './types.js'
import { finalizeRecording } from './finalize-recording.js'

const MIN = 60_000
const FINALIZE_LEASE_MS = 12 * MIN
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024

export type FinalizeResult = 'ready' | 'retry' | 'failed' | 'cancelled' | 'skipped'

class Invalid extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message)
  }
}
class NotYet extends Error {}

/** Extracts the last fenced ```json block from the agent's final answer. */
export function manifestFromResult(text: string | null): unknown {
  if (!text) return null
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  const last = blocks.at(-1)?.[1]
  if (!last) return null
  try {
    return JSON.parse(last)
  } catch {
    return null
  }
}

/** render-job's Remotion render counts, when they're whole numbers of zero or more; null otherwise. */
function renderCounts(v: unknown): { video: number; stills: number; audio: number } | null {
  const r = (v ?? {}) as Record<string, unknown>
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 1e6
  return ok(r.video) && ok(r.stills) && ok(r.audio)
    ? { video: r.video, stills: r.stills, audio: r.audio }
    : null
}

export function isManifest(v: unknown, attemptId: string): v is Manifest {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  const files = m.files
  if (m.attemptId !== attemptId || typeof m.title !== 'string' || typeof m.summary !== 'string') return false
  if (!files || typeof files !== 'object') return false
  if (m.references !== undefined && !areReferenceUploads(m.references)) return false
  if (m.engine !== undefined) {
    const e = m.engine
    if (!e || typeof e !== 'object' || typeof (e as { id?: unknown }).id !== 'string') return false
  }
  return OUTPUT_FILES.every((f) => {
    const e = (files as Record<string, unknown>)[f] as { sha256?: unknown; bytes?: unknown } | undefined
    return typeof e?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)
  })
}

/** The manifest's reference files: each a known path at most once, with a digest and a bounded size. */
function areReferenceUploads(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > Object.keys(REFERENCE_FILES).length) return false
  const paths = new Set<unknown>()
  return v.every((r: { path?: unknown; sha256?: unknown; bytes?: unknown } | null) => {
    if (!r || typeof r.path !== 'string' || !isReference(r.path) || paths.has(r.path)) return false
    paths.add(r.path)
    return (
      typeof r.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(r.sha256) &&
      Number.isInteger(r.bytes) &&
      (r.bytes as number) > 0 &&
      (r.bytes as number) <= MAX_REFERENCE_BYTES
    )
  })
}

async function manifestFor(deps: Deps, a: AttemptRow): Promise<Manifest | null> {
  const receipt = await deps.store.getReceipt(a.id)
  if (receipt) return receipt.manifest
  if (!a.handleEnc) return null
  const snap = await deps.runner.snapshot(decrypt((await getSettings(deps)).dataEncryptionKey, a.handleEnc))
  const parsed = snap.kind === 'terminal' ? manifestFromResult(snap.resultText) : null
  return isManifest(parsed, a.id) ? parsed : null
}

export async function finalizeAttempt(deps: Deps, attemptId: string): Promise<FinalizeResult> {
  const log = deps.log.child({ attemptId })
  const a0 = await deps.store.getAttempt(attemptId)
  if (a0?.stage !== 'finishing') return 'skipped'
  const leaseUntil = new Date(deps.clock.now().getTime() + FINALIZE_LEASE_MS).toISOString()
  if (!(await deps.store.updateAttempt(attemptId, { leaseUntil }, 'finishing'))) return 'skipped'
  const a = { ...a0, leaseUntil }

  try {
    const job = await deps.store.getJob(a.jobId)
    const version = await deps.store.getVersion(a.jobId, a.versionN)
    if (!job || !version) throw new Invalid('artifacts_missing', 'Video was removed.')
    if (job.deletedAt || a.cancelRequestedAt) return await finish(deps, a, 'cancelled', null, null)

    const manifest = await manifestFor(deps, a)
    if (!manifest) throw new NotYet('No manifest yet (no callback receipt and none in the final answer).')
    // Remotion's renders were reported to Remotion whatever happens next, so they're kept before any check can fail.
    if (manifest.engine?.renders !== undefined) {
      const renders = renderCounts(manifest.engine.renders)
      if (renders) {
        await deps.store.updateAttempt(a.id, { engineRenders: renders }, 'finishing')
        log.info('finalize.engine_renders', renders)
      } else
        log.warn('finalize.engine_renders_invalid', {
          got: JSON.stringify(manifest.engine.renders).slice(0, 200),
        })
    }

    const files = {} as Record<OutputFile, Uint8Array>
    for (const name of OUTPUT_FILES) {
      const bytes = await deps.blobs.get('uploads', `${a.id}/${name}`)
      if (!bytes) throw new NotYet(`Upload ${name} not found.`)
      const hash = sha256Hex(bytes)
      if (hash !== manifest.files[name].sha256)
        throw new NotYet(`Upload ${name} doesn't match the manifest hash.`)
      files[name] = bytes
    }
    // Files of the composition kept outside source.tar.gz (the narration bus, plan 2026-11-02 §6.2), checked the same.
    const references: { entry: BundleReference; bytes: Uint8Array }[] = []
    for (const r of manifest.references ?? []) {
      const name = REFERENCE_FILES[r.path] ?? ''
      const bytes = await deps.blobs.get('uploads', `${a.id}/${name}`)
      if (!bytes) throw new NotYet(`Upload ${name} not found.`)
      if (sha256Hex(bytes) !== r.sha256 || bytes.byteLength !== r.bytes)
        throw new NotYet(`Upload ${name} doesn't match the manifest hash.`)
      const key = referenceKey(a.jobId, a.versionN, r.path)
      references.push({ entry: { path: r.path, key, sha256: r.sha256, bytes: r.bytes }, bytes })
    }

    const video = files['video.mp4']
    if (video.byteLength > MAX_VIDEO_BYTES)
      throw new Invalid('invalid_output', 'The video is larger than 2 GB.')
    let info
    try {
      info = inspectMp4(video)
    } catch (e) {
      throw new Invalid(
        'invalid_output',
        `The MP4 is not valid: ${e instanceof Mp4Error ? e.message : String(e)}`,
      )
    }
    const want = ASPECTS[job.aspect]
    if (info.videoCodec !== 'avc1')
      throw new Invalid('invalid_output', `Expected H.264 video, got ${info.videoCodec}.`)
    if (info.width !== want.width || info.height !== want.height) {
      throw new Invalid(
        'invalid_output',
        `Expected ${want.width}x${want.height}, got ${info.width}x${info.height}.`,
      )
    }
    if (!(info.durationSec > 0)) throw new Invalid('invalid_output', 'The video has no duration.')
    // A video far from the length asked for is still kept (the run cost credits and it's better than nothing), with a
    // notice. With a voice-over the narration sets the length, so only a short one is noted.
    const notices: string[] = []
    if (version.targetDurationSec !== null) {
      const t = version.targetDurationSec
      const longest = version.voiceover ? Infinity : t * 1.25
      if (info.durationSec < t * 0.75 || info.durationSec > longest)
        notices.push(`Asked for about ${t} s; this video is ${info.durationSec.toFixed(1)} s.`)
    }
    if (sniff(files['poster.jpg']) !== 'jpeg')
      throw new Invalid('invalid_output', 'The poster is not a JPEG.')
    if (sniff(files['preview.gif']) !== 'gif')
      throw new Invalid('invalid_output', 'The preview is not a GIF.')
    if (sniff(files['captions.vtt']) !== 'vtt')
      throw new Invalid('invalid_output', 'The captions are not WebVTT.')
    // The saved composition, read once before anything is stored: its engine's shape, its credits, its beats and
    // whether it's editable.
    const source = readSource(deps, a.id, files['source.tar.gz'])
    // The engine twice (render-engines §4.2): the one the run says rendered it, and the shape of what it saved.
    const engine = engineOf(version)
    const got = manifest.engine?.id ?? 'hyperframes'
    // A bad archive is ensureBundle's to report (best effort, after ready), as before engines.
    const shape = got === engine && source.files ? bundleShapeProblems(engine, source.files) : []
    if (got !== engine || shape.length) {
      log.warn('finalize.engine_mismatch', { expected: engine, got, problems: shape })
      const name = isEngineId(got) ? engineInfo(got).name : got
      throw new Invalid(
        'engine_mismatch',
        got !== engine
          ? `The run produced a ${name} project for a ${engineInfo(engine).name} video.`
          : `The run didn't save a ${engineInfo(engine).name} project: ${shape.join(' ')}`,
      )
    }
    // A scoped revision (redo a scene): the saved composition must be exactly the splice of the parent.
    if (version.scope) await checkScope(deps, a, version, engine, source.files, info.durationSec)
    // A demo (screen-recording plan §5.2 check): the same recording check the run did, against the locked inputs.
    let recording: VersionRow['recording'] = null
    if (version.recording && source.files) {
      const r = await finalizeRecording(deps, a.jobId, a.versionN, version, source.files)
      if (r && !r.ok) {
        log.warn('finalize.recording_invalid', {
          jobId: a.jobId,
          n: a.versionN,
          code: r.code,
          scene: r.scene,
        })
        throw new Invalid('invalid_output', r.message)
      }
      recording = r?.recording ?? null
    }

    const prefix = `${a.jobId}/v${a.versionN}`
    const keys = {
      video: `${prefix}/video.mp4`,
      poster: `${prefix}/poster.jpg`,
      gif: `${prefix}/preview.gif`,
      captions: `${prefix}/captions.vtt`,
      source: `${a.jobId}/v${a.versionN}.tar.gz`,
    }
    await deps.blobs.set('videos', keys.video, video, {
      contentType: 'video/mp4',
      size: String(video.byteLength),
    })
    await deps.blobs.set('videos', keys.poster, files['poster.jpg'], {
      contentType: 'image/jpeg',
      size: String(files['poster.jpg'].byteLength),
    })
    await deps.blobs.set('videos', keys.gif, files['preview.gif'], {
      contentType: 'image/gif',
      size: String(files['preview.gif'].byteLength),
    })
    await deps.blobs.set('videos', keys.captions, files['captions.vtt'], {
      contentType: 'text/vtt',
      size: String(files['captions.vtt'].byteLength),
    })
    await deps.blobs.set('sources', keys.source, files['source.tar.gz'], { contentType: 'application/gzip' })

    const sha256: Record<string, string> = Object.fromEntries(
      OUTPUT_FILES.map((f) => [f, manifest.files[f].sha256]),
    )
    // The entries go next to the archive, pinned by their hash among the outputs, so restorers find them by key.
    if (references.length) {
      for (const r of references)
        await deps.blobs.set('videos', r.entry.key, r.bytes, {
          contentType: 'audio/wav',
          size: String(r.bytes.byteLength),
        })
      const list = JSON.stringify(references.map((r) => r.entry))
      await deps.blobs.set('sources', referencesKey(a.jobId, a.versionN), list, {
        contentType: 'application/json',
      })
      sha256[REFERENCES_FILE] = sha256Hex(list)
    }
    const previews = await storePreviews(deps, a.id, prefix, manifest, sha256)
    const runCredits = runCreditsOf(deps, a.id, source.files)
    // Editable and its scenes, stored with ready so `editable` never lags (redo a scene, plan §4.2, owner Q8): the same
    // inputs ensureBundle checks (bundleContract over the bundle's files and the reference files), and only for an
    // archive the bundle can hold, as before.
    const contract =
      source.files && source.bundleable
        ? bundleContract(
            engine,
            new Map([
              ...[...source.files].filter(([p]) => inBundle(p)),
              ...references.map((r) => [r.entry.path, r.bytes] as const),
            ]),
          )
        : null
    const beats = source.files ? beatsOf(source.files) : null
    if (contract && contract.version === null)
      log.info('finalize.not_editable', { reasons: contract.violations.slice(0, 5) })
    if (beats) log.info('finalize.beats', { count: beats.length })
    const narrated = version.frozen?.narration
      ? await storeNarrationOutputs(deps, a.id, prefix, manifest, sha256)
      : new Set<NarrationOutput>()
    const recorded = narrationMetadata(deps, a, version, manifest, references, narrated)
    // The same narration as the version it was made from keeps that version's caption corrections.
    if (recorded?.narration?.opHash && recorded.captions) {
      const baseN = version.editedFromN ?? version.parentN
      const base = baseN ? await deps.store.getVersion(a.jobId, baseN) : null
      const carried = await carriedCaptions(deps, a.jobId, a.versionN, base, {
        opHash: recorded.narration.opHash,
        captions: recorded.captions,
      })
      if (carried) recorded.captions = carried
    }
    const result = await finish(
      deps,
      a,
      'ready',
      null,
      {
        jobId: a.jobId,
        versionN: a.versionN,
        videoKey: keys.video,
        posterKey: keys.poster,
        gifKey: keys.gif,
        captionsKey: keys.captions,
        sourceKey: keys.source,
        sha256,
        bytes: video.byteLength,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        title: manifest.title.slice(0, 120),
        agentSummary: manifest.summary.slice(0, 4000),
        previews,
        runCredits,
        notices: notices.length ? notices : null,
      },
      { ...recorded, contract: contract?.version ?? null, beats, ...(recording ? { recording } : {}) },
    )
    // The preview bundle (plan v2 §7). Best effort: a version without one is still ready and is extracted later.
    if (result === 'ready') {
      try {
        const bundle = await ensureBundle(deps, a.jobId, a.versionN)
        // Both read the same files the same way; a difference would be a bug.
        if (bundle && (bundle.contract?.version ?? null) !== (contract?.version ?? null))
          log.warn('finalize.contract_mismatch', {
            version: a.versionN,
            stored: contract?.version ?? null,
            bundle: bundle.contract?.version ?? null,
          })
      } catch (e) {
        log.warn('finalize.bundle_failed', { error: e })
      }
    }
    return result
  } catch (e) {
    if (e instanceof NotYet) {
      log.warn('finalize.not_yet', { reason: e.message })
      const finishingSince = a.finishingAt ? new Date(a.finishingAt).getTime() : deps.clock.now().getTime()
      // A render-unchanged run that ends without a callback stopped on purpose (the edited composition failed
      // its check, plan v2 §8): say so soon, with the agent's reason, instead of waiting out the deadline.
      const version = await deps.store.getVersion(a.jobId, a.versionN)
      const edited = version?.mode === 'render_unchanged'
      const deadline = (edited ? 2 : deps.config.finalizeDeadlineMin) * MIN
      if (deps.clock.now().getTime() - finishingSince > deadline) {
        const reason = summarizeResult(a.resultText ?? null)
        return finish(
          deps,
          a,
          'failed',
          edited
            ? {
                category: 'check_failed',
                message: `The edited composition didn't pass its check, so nothing was rendered.${reason ? ` ${reason}` : ''} Edit it again or ask for a revision instead.`,
              }
            : {
                category: 'artifacts_missing',
                message: reason ? `The run ended without saving a video. ${reason}` : e.message,
              },
          null,
        )
      }
      await deps.store.updateAttempt(
        a.id,
        { leaseUntil: null, nextActionAt: new Date(deps.clock.now().getTime() + 30_000).toISOString() },
        'finishing',
      )
      return 'retry'
    }
    if (e instanceof Invalid) {
      log.warn('finalize.invalid', { category: e.category, reason: e.message })
      return finish(deps, a, 'failed', { category: e.category, message: e.message }, null)
    }
    await deps.store.updateAttempt(
      a.id,
      { leaseUntil: null, nextActionAt: new Date(deps.clock.now().getTime() + MIN).toISOString() },
      'finishing',
    )
    throw e
  }
}

/**
 * Copies the optional preview variants the manifest lists, each checked like the required files. One that is missing,
 * doesn't match or fails to copy is skipped: the version is still ready and falls back to poster.jpg/preview.gif.
 */
async function storePreviews(
  deps: Deps,
  attemptId: string,
  prefix: string,
  manifest: Manifest,
  sha256: Record<string, string>,
): Promise<Previews | null> {
  const out: Previews = { files: {}, lqip: isLqip(manifest.lqip) ? manifest.lqip : null }
  // What the run couldn't make: logged here because the run's own output isn't kept. Untrusted, so bounded strings.
  if (Array.isArray(manifest.previewsSkipped) && manifest.previewsSkipped.length)
    deps.log.warn('finalize.previews_skipped_in_run', {
      attemptId,
      skipped: manifest.previewsSkipped.slice(0, 12).map((s: { name?: unknown; reason?: unknown }) => ({
        name: typeof s.name === 'string' ? s.name.slice(0, 40) : '',
        reason: typeof s.reason === 'string' ? s.reason.slice(0, 300) : '',
      })),
    })
  for (const name of PREVIEW_NAMES) {
    const want = manifest.files[name]
    if (!want) continue
    try {
      const bytes = await deps.blobs.get('uploads', `${attemptId}/${name}`)
      if (!bytes) throw new Error('not uploaded')
      if (sha256Hex(bytes) !== want.sha256) throw new Error("doesn't match the manifest hash")
      if (bytes.byteLength > MAX_PREVIEW_BYTES || !sniffPreview(name, bytes))
        throw new Error('too large or not the right format')
      await deps.blobs.set('videos', `${prefix}/${name}`, bytes, {
        contentType: PREVIEW_FILES[name],
        size: String(bytes.byteLength),
      })
      out.files[name] = { bytes: bytes.byteLength }
      sha256[name] = want.sha256
    } catch (e) {
      deps.log.warn('finalize.preview_skipped', { attemptId, file: name, error: e })
    }
  }
  return Object.keys(out.files).length || out.lqip ? out : null
}

/** The longest transcript kept (about 15 minutes of speech is under 20 KB). */
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
/** The longest narration MP3 kept: 15 minutes at 192 kbps is about 21 MB. */
const MAX_NARRATION_MP3_BYTES = 64 * 1024 * 1024

/**
 * Recorded narration's outputs (plan 2026-11-02 §6.7), next to the version's other files: narration.mp3 and
 * transcript.txt, each checked like a preview variant (hash, size, format). One that fails is left out and logged:
 * the version is still ready, without that download. Returns what was stored; their hashes join `sha256`.
 */
async function storeNarrationOutputs(
  deps: Deps,
  attemptId: string,
  prefix: string,
  manifest: Manifest,
  sha256: Record<string, string>,
): Promise<Set<NarrationOutput>> {
  const stored = new Set<NarrationOutput>()
  for (const name of Object.keys(NARRATION_OUTPUTS) as NarrationOutput[]) {
    const want = manifest.files[name]
    if (!want) continue
    try {
      const bytes = await deps.blobs.get('uploads', `${attemptId}/${name}`)
      if (!bytes) throw new Error('not uploaded')
      if (sha256Hex(bytes) !== want.sha256) throw new Error("doesn't match the manifest hash")
      if (name === 'narration.mp3') {
        if (bytes.byteLength > MAX_NARRATION_MP3_BYTES || sniffAudio(bytes)?.format !== 'mp3')
          throw new Error('too large or not an MP3')
      } else if (bytes.byteLength > MAX_TRANSCRIPT_BYTES || !isUtf8Text(bytes))
        throw new Error('too large or not UTF-8 text')
      await deps.blobs.set('videos', `${prefix}/${name}`, bytes, {
        contentType: NARRATION_OUTPUTS[name],
        size: String(bytes.byteLength),
      })
      sha256[name] = want.sha256
      stored.add(name)
    } catch (e) {
      deps.log.warn('finalize.narration_output_skipped', { attemptId, file: name, error: e })
    }
  }
  deps.log.info('finalize.narration_outputs', { attemptId, stored: [...stored] })
  return stored
}

const isUtf8Text = (b: Uint8Array) => {
  try {
    // eslint-disable-next-line no-control-regex
    return !/[\u0000-\u0008\u000e-\u001f]/.test(new TextDecoder('utf-8', { fatal: true }).decode(b))
  } catch {
    return false
  }
}

// Reading a saved composition for its credits only: wider than the preview bundle's limits, so a large file the run
// made can't cost a CC BY work its credit, and still bounded.
const SOURCE_READ_LIMITS: TarLimits = {
  maxEntries: 5000,
  maxTotalBytes: 160 * 1024 * 1024,
  maxFileBytes: 60 * 1024 * 1024,
}

/** How far a scoped version's MP4 may be from its composition's length. */
const SCOPE_LENGTH_SLACK_SEC = 0.25

/**
 * A scoped revision's server-side check (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.9): the run checked
 * itself, but it runs this repo's scripts in its own checkout and could have changed them. So the parent's saved
 * archive is read again here, the engine's scope check runs on it and the upload, and the upload's index.html and
 * summary.json must be byte for byte the splice; the MP4 must last as long as the splice says. Anything else fails
 * the attempt before a single file is stored.
 */
async function checkScope(
  deps: Deps,
  a: AttemptRow,
  version: VersionRow,
  engine: EngineId,
  uploaded: Map<string, Uint8Array> | null,
  mp4Seconds: number,
) {
  const log = deps.log.child({ attemptId: a.id })
  const started = Date.now()
  const beats = version.scope?.beats ?? []
  const parentN = version.parentN
  const unavailable = () =>
    new Invalid(
      'source_unavailable',
      `Version ${parentN ?? '?'}'s saved composition is missing, so this scoped run can't be checked.`,
    )
  const parentOutput = parentN ? await deps.store.getOutput(a.jobId, parentN) : null
  const want = parentOutput?.sha256['source.tar.gz']
  const gz = parentOutput && want ? await deps.blobs.get('sources', parentOutput.sourceKey) : null
  if (!gz || sha256Hex(gz) !== want) throw unavailable()
  let parent: Map<string, Uint8Array>
  try {
    parent = readTarGz(gz, SOURCE_READ_LIMITS)
  } catch {
    throw unavailable()
  }
  const check = scopeCheckFor(engine)
  if (!check || !uploaded)
    throw new Invalid(
      'invalid_output',
      `${SCOPE_REFUSED_PREFIX}: ${!check ? `${engineInfo(engine).name} can't redo scenes one by one` : 'the saved composition is unreadable'}.`,
    )
  const r = check(parent, uploaded, [...beats])
  const problems = [...r.problems]
  if (!problems.length && r.files)
    for (const [name, bytes] of r.files) {
      const mine = uploaded.get(name)
      if (!mine || sha256Hex(mine) !== sha256Hex(bytes))
        problems.push(
          `${name} isn't the composition the scope allows (render-job writes it; run it unchanged)`,
        )
    }
  if (problems.length || !r.files) {
    if (!problems.length) problems.push("the scenes couldn't be put together")
    log.warn('finalize.scope_violated', { problems: problems.slice(0, 20) })
    const shown = problems.slice(0, 10).map((p) => p.replace(/\.$/, ''))
    throw new Invalid(
      'invalid_output',
      `${SCOPE_REFUSED_PREFIX}: ${shown.join('; ')}${problems.length > 10 ? ` and ${problems.length - 10} more` : ''}.`,
    )
  }
  const html = r.files.get('index.html')
  const total = html ? Number(attr(load(new TextDecoder().decode(html)).root, 'data-duration')) : NaN
  if (!(Math.abs(mp4Seconds - total) <= SCOPE_LENGTH_SLACK_SEC)) {
    log.warn('finalize.scope_duration_mismatch', { mp4: mp4Seconds, composition: total })
    throw new Invalid(
      'invalid_output',
      `The video is ${mp4Seconds.toFixed(2)} s long but its composition is ${total.toFixed(2)} s; render the composition render-job wrote.`,
    )
  }
  log.info('finalize.scope_ok', {
    beats,
    lengthDelta: (r as { lengthDelta?: number }).lengthDelta ?? null,
    ms: Date.now() - started,
  })
}

/**
 * The uploaded composition's files, read once. `bundleable`: within the preview bundle's limits, which an editable
 * version has to be (ensureBundle reads it with them). A larger archive is read with SOURCE_READ_LIMITS for its
 * credits only; an unreadable one gives no files.
 */
export function readSource(
  deps: Pick<Deps, 'log'>,
  attemptId: string,
  gz: Uint8Array,
): { files: Map<string, Uint8Array> | null; bundleable: boolean } {
  try {
    return { files: readTarGz(gz, BUNDLE_LIMITS), bundleable: true }
  } catch {
    try {
      return { files: readTarGz(gz, SOURCE_READ_LIMITS), bundleable: false }
    } catch (e) {
      deps.log.warn('finalize.source_unreadable', { attemptId, error: e })
      return { files: null, bundleable: false }
    }
  }
}

/**
 * Credits for the Openverse files the run fetched itself (scripts/openverse.ts records them in
 * video/assets/music/credits.json, saved with the composition). The file is the agent's, so it is checked strictly:
 * entries that fail are dropped and logged, and an unreadable archive or file gives none. Revisions and edits carry
 * the file in their source, so their credits are read the same way.
 */
export function runCreditsOf(
  deps: Pick<Deps, 'log'>,
  attemptId: string,
  files: Map<string, Uint8Array> | null,
): RunCredit[] | null {
  if (!files) return null
  const raw = files.get(RUN_CREDITS_FILE)
  if (!raw) return null
  const { credits, dropped } = readRunCredits(new TextDecoder().decode(raw), files)
  if (dropped) deps.log.warn('finalize.run_credits_dropped', { attemptId, dropped, kept: credits.length })
  return credits.length ? credits : null
}

async function finish(
  deps: Deps,
  a: AttemptRow,
  outcome: 'ready' | 'failed' | 'cancelled',
  error: { category: FailureCategory; message: string } | null,
  output: Parameters<Deps['store']['upsertOutput']>[0] | null,
  recorded: Pick<VersionRow, 'narration' | 'captions' | 'contract' | 'beats' | 'recording'> | null = null,
): Promise<FinalizeResult> {
  const now = deps.clock.now().toISOString()
  return deps.store.tx(async (repo) => {
    const fresh = await repo.getAttempt(a.id, { lock: true })
    const job = await repo.getJob(a.jobId, { lock: true })
    if (fresh?.stage !== 'finishing') return 'skipped'
    // Cancellation intent or a deletion during finalize wins: never publish files.
    const final = fresh.cancelRequestedAt || job?.deletedAt ? 'cancelled' : outcome
    if (final === 'ready' && output) {
      await repo.upsertOutput(output)
      // What was rendered, and the takes it played: the attempt's references become the version's, under the take
      // locks (a failed or cancelled attempt releases its own instead, in setStage).
      if (recorded) await repo.updateVersion(a.jobId, a.versionN, recorded)
      await promoteAttemptRefs(repo, deps, a.id, `${a.jobId}#${a.versionN}`)
      // A title still taken from the first prompt gives way to the agent's; a title someone chose (typed, renamed
      // or from the brief) is kept.
      const first = job && output.title ? await repo.getVersion(a.jobId, 1) : null
      if (
        job &&
        first &&
        output.title &&
        job.title === deriveTitle(first.prompt) &&
        output.title !== job.title
      )
        await repo.updateJob(job.id, { title: output.title, updatedAt: now, version: job.version + 1 })
      // Comments this version was asked to incorporate count as addressed only once it succeeds (plan v2 §5).
      const fed = await repo.listVersionComments(a.jobId, a.versionN)
      await repo.markCommentsAddressed(
        a.jobId,
        fed.map((c) => c.commentId),
        a.versionN,
      )
    }
    await setStage(
      repo,
      fresh,
      final,
      {
        endedAt: now,
        leaseUntil: null,
        nextActionAt: null,
        errorCategory: final === 'failed' ? (error?.category ?? null) : null,
        errorMessage: final === 'failed' ? (error?.message ?? null) : null,
      },
      now,
    )
    await emitTerminalEvent(repo, deps, a.id)
    deps.log.info('finalize.done', { attemptId: a.id, outcome: final })
    return final
  })
}

/**
 * versions.narration and versions.captions for a render of recorded narration (plan 2026-11-02 §6.1 Version fields,
 * §6.6): the frozen op, the recipe with ffmpeg's version from the run's receipt, the bus as finalize verified and
 * stored it, and the captions' transcription status and policy at rev 0. Null for every other version. The run's
 * report is untrusted: what fails its checks is left out (and logged), and the verified bus always wins.
 */
export function narrationMetadata(
  deps: Pick<Deps, 'log'>,
  a: Pick<AttemptRow, 'id' | 'jobId' | 'versionN'>,
  version: VersionRow,
  manifest: Manifest,
  references: { entry: BundleReference; bytes: Uint8Array }[],
  outputs: ReadonlySet<NarrationOutput> = new Set(),
): Pick<VersionRow, 'narration' | 'captions'> | null {
  const frozen = version.frozen?.narration
  if (!frozen) return null
  const bus = references.find((r) => r.entry.path === NARRATION_SRC)
  if (!bus) throw new Invalid('invalid_output', "The narration bus wasn't uploaded with the video.")
  const report = narrationReportOf(manifest.narration)
  if (manifest.narration !== undefined && !report)
    deps.log.warn('finalize.narration_report_invalid', { attemptId: a.id })
  if (report && report.bus.sha256 !== bus.entry.sha256)
    deps.log.warn('finalize.narration_report_mismatch', { attemptId: a.id, reported: report.bus.sha256 })
  const samples = wavSamples(bus.bytes) ?? report?.bus.samples ?? 0
  const narration: VersionNarration = {
    op: frozen.op,
    recipe: {
      pipeline: report?.pipeline ?? frozen.recipe.pipeline,
      ffmpegVersion: report?.ffmpeg ?? '',
      settings: { cleanup: report?.cleanup ?? frozen.recipe.cleanup },
    },
    bus: { key: bus.entry.key, sha256: bus.entry.sha256, samples },
    opHash: narrationOpHash(frozen.op),
  }
  // No report from the transcription stage: off when the render froze it off, a failure otherwise.
  const status: VersionCaptions['status'] =
    report?.stt?.status ?? (frozen.transcriptionProvider === 'off' ? 'off' : 'failed')
  const captions: VersionCaptions = {
    status,
    policy: frozen.captions,
    rev: 0,
    files: { vtt: 'captions.vtt', transcript: outputs.has('transcript.txt') ? 'transcript.txt' : null },
    sha256: {
      vtt: manifest.files['captions.vtt'].sha256,
      transcript: outputs.has('transcript.txt') ? (manifest.files['transcript.txt']?.sha256 ?? null) : null,
    },
    generation: 0,
  }
  deps.log.info('finalize.narration', {
    attemptId: a.id,
    jobId: a.jobId,
    versionN: a.versionN,
    bus: bus.entry.sha256,
    samples,
    captions: status,
    policy: frozen.captions,
  })
  return { narration, captions }
}

const STT_STATUSES = new Set(['ok', 'failed', 'off', 'timeout'])
const shortText = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null)

/** The run's narration report, checked field by field; null when it isn't one. */
export function narrationReportOf(v: unknown): NarrationReport | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const bus = r.bus as Record<string, unknown> | undefined
  const stt = r.stt as Record<string, unknown> | null | undefined
  if (!Number.isInteger(r.pipeline) || !(NARRATION_CLEANUP_PRESETS as readonly unknown[]).includes(r.cleanup))
    return null
  if (typeof r.ffmpeg !== 'string') return null
  if (!bus || typeof bus.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bus.sha256)) return null
  if (!Number.isInteger(bus.samples) || (bus.samples as number) < 0) return null
  if (stt !== null && (!stt || !STT_STATUSES.has(stt.status as string))) return null
  return {
    pipeline: r.pipeline as number,
    cleanup: r.cleanup as NarrationReport['cleanup'],
    ffmpeg: r.ffmpeg.slice(0, 200),
    bus: { sha256: bus.sha256, samples: bus.samples as number },
    stt: stt
      ? {
          status: stt.status as VersionCaptions['status'],
          provider: shortText(stt.provider, 40),
          model: shortText(stt.model, 80),
          words: Number.isInteger(stt.words) ? (stt.words as number) : 0,
        }
      : null,
  }
}

/** Samples per channel of a PCM16 WAV, from its chunk headers; null when it isn't one. */
export function wavSamples(b: Uint8Array): number | null {
  const id = (o: number) => String.fromCharCode(...b.subarray(o, o + 4))
  if (b.length < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let channels = 0
  for (let o = 12; o + 8 <= b.length;) {
    const size = v.getUint32(o + 4, true)
    if (id(o) === 'fmt ' && o + 24 <= b.length) {
      if (v.getUint16(o + 8, true) !== 1 || v.getUint16(o + 22, true) !== 16) return null
      channels = v.getUint16(o + 10, true)
    } else if (id(o) === 'data') {
      if (!channels) return null
      return Math.floor(Math.min(size, b.length - o - 8) / (2 * channels))
    }
    o += 8 + size + (size & 1)
  }
  return null
}

/** The agent's explanation, trimmed to its first sentences, for a failure message. */
export function summarizeResult(text: string | null): string | null {
  if (!text) return null
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return null
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain]
  const out = sentences.slice(0, 3).join(' ').trim()
  return out.length > 400 ? `${out.slice(0, 397)}...` : out
}
