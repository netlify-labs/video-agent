// finalize-background: verify the agent's uploads against the authenticated manifest, validate the
// media, copy it to immutable keys and commit the version as ready. Idempotent; leased.
import type { Deps } from '../deps.js'
import { decrypt, sha256Hex } from '../lib/crypto.js'
import { inspectMp4, Mp4Error, sniff } from '../lib/media/mp4.js'
import { ensureBundle } from './bundles.js'
import { getSettings } from './settings.js'
import { setStage } from './videos.js'
import { emitTerminalEvent } from './webhooks.js'
import {
  ASPECTS,
  OUTPUT_FILES,
  type AttemptRow,
  type FailureCategory,
  type Manifest,
  type OutputFile,
} from './types.js'

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

export function isManifest(v: unknown, attemptId: string): v is Manifest {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  const files = m.files
  if (m.attemptId !== attemptId || typeof m.title !== 'string' || typeof m.summary !== 'string') return false
  if (!files || typeof files !== 'object') return false
  return OUTPUT_FILES.every((f) => {
    const e = (files as Record<string, unknown>)[f] as { sha256?: unknown; bytes?: unknown } | undefined
    return typeof e?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)
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

    const files = {} as Record<OutputFile, Uint8Array>
    for (const name of OUTPUT_FILES) {
      const bytes = await deps.blobs.get('uploads', `${a.id}/${name}`)
      if (!bytes) throw new NotYet(`Upload ${name} not found.`)
      const hash = sha256Hex(bytes)
      if (hash !== manifest.files[name].sha256)
        throw new NotYet(`Upload ${name} doesn't match the manifest hash.`)
      files[name] = bytes
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
    if (version.targetDurationSec !== null) {
      const t = version.targetDurationSec
      if (info.durationSec < t * 0.75 || info.durationSec > t * 1.25) {
        throw new Invalid('invalid_output', `Asked for about ${t}s, got ${info.durationSec.toFixed(1)}s.`)
      }
    }
    if (sniff(files['poster.jpg']) !== 'jpeg')
      throw new Invalid('invalid_output', 'The poster is not a JPEG.')
    if (sniff(files['preview.gif']) !== 'gif')
      throw new Invalid('invalid_output', 'The preview is not a GIF.')
    if (sniff(files['captions.vtt']) !== 'vtt')
      throw new Invalid('invalid_output', 'The captions are not WebVTT.')

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

    const sha256 = Object.fromEntries(OUTPUT_FILES.map((f) => [f, manifest.files[f].sha256]))
    const result = await finish(deps, a, 'ready', null, {
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
    })
    // The preview bundle (plan v2 §7). Best effort: a version without one is still ready and is extracted later.
    if (result === 'ready') {
      try {
        await ensureBundle(deps, a.jobId, a.versionN)
      } catch (e) {
        log.warn('finalize.bundle_failed', { error: e })
      }
    }
    return result
  } catch (e) {
    if (e instanceof NotYet) {
      log.warn('finalize.not_yet', { reason: e.message })
      const finishingSince = a.finishingAt ? new Date(a.finishingAt).getTime() : deps.clock.now().getTime()
      if (deps.clock.now().getTime() - finishingSince > deps.config.finalizeDeadlineMin * MIN) {
        return finish(deps, a, 'failed', { category: 'artifacts_missing', message: e.message }, null)
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

async function finish(
  deps: Deps,
  a: AttemptRow,
  outcome: 'ready' | 'failed' | 'cancelled',
  error: { category: FailureCategory; message: string } | null,
  output: Parameters<Deps['store']['upsertOutput']>[0] | null,
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
