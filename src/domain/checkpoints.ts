// Run checkpoints (plan v2 §6 A2, §14 rule 28): a running agent posts milestones ("Writing the end card"), render
// progress and, optionally, a snapshot of its composition. Hardened: the attempt's callback token, only while that
// attempt is the video's latest and running, sequence numbers so a late post never replaces a newer one, size and
// rate bounds, and server-chosen keys in their own store. It never touches receipts, leases or outcomes.
import type { Deps } from '../deps.js'
import { safeEqual, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import type { CheckpointRow } from './types.js'

export const CHECKPOINT_MESSAGE_MAX = 500
export const CHECKPOINT_BUNDLE_MAX = 2 * 1024 * 1024
export const CHECKPOINTS_PER_MIN = 10

export interface CheckpointInput {
  seq: number
  message?: string | undefined
  renderPercent?: number | undefined
  /** base64 of a .tar.gz of video/ */
  bundle?: string | undefined
}

export const checkpointBundleKey = (attemptId: string, seq: number) => `${attemptId}/${seq}.tar.gz`

export async function receiveCheckpoint(
  deps: Deps,
  attemptId: string,
  token: string | null,
  input: CheckpointInput,
): Promise<{ accepted: boolean; seq: number; reason?: string }> {
  const a = await deps.store.getAttempt(attemptId)
  if (!a || !token || !a.callbackTokenHash || !safeEqual(a.callbackTokenHash, sha256Hex(token)))
    throw new ApiError('unauthorized', 'Invalid callback token.')
  const job = await deps.store.getJob(a.jobId)
  if (!job || job.deletedAt || a.cancelRequestedAt)
    throw new ApiError('gone', 'This attempt was cancelled or removed. Stop sending checkpoints.')
  const newest = (await deps.store.listAttempts(a.jobId))
    .filter((x) => x.versionN === job.latestVersion)
    .sort((x, y) => y.queuedAt.localeCompare(x.queuedAt))[0]
  if (newest?.id !== a.id || a.stage !== 'running')
    throw new ApiError('gone', "This attempt isn't the video's running attempt. Stop sending checkpoints.")

  const message = input.message?.trim().slice(0, CHECKPOINT_MESSAGE_MAX) || null
  if (!message && input.renderPercent === undefined && !input.bundle)
    throw new ApiError('invalid_request', 'Send a message, renderPercent or a bundle.')
  let bundle: Buffer | null = null
  if (input.bundle) {
    bundle = Buffer.from(input.bundle, 'base64')
    if (bundle.byteLength > CHECKPOINT_BUNDLE_MAX)
      throw new ApiError('invalid_request', 'The bundle is over 2 MB. Send the message without it.')
    // gzip magic: anything else isn't a composition archive.
    if (bundle[0] !== 0x1f || bundle[1] !== 0x8b)
      throw new ApiError('invalid_request', 'The bundle must be a .tar.gz.')
  }

  return deps.store.tx(async (repo) => {
    const prev = await repo.getCheckpoint(attemptId, { lock: true })
    if (prev && input.seq <= prev.seq)
      return { accepted: false, seq: prev.seq, reason: 'older than the latest' }
    const now = deps.clock.now()
    const inWindow = prev && now.getTime() - new Date(prev.windowStart).getTime() < 60_000
    if (inWindow && prev.windowCount >= CHECKPOINTS_PER_MIN)
      throw new ApiError(
        'rate_limited',
        `At most ${CHECKPOINTS_PER_MIN} checkpoints a minute. Skip this one.`,
      )
    let bundleKey = prev?.bundleKey ?? null
    if (bundle) {
      bundleKey = checkpointBundleKey(attemptId, input.seq)
      await deps.blobs.set('checkpoints', bundleKey, new Uint8Array(bundle), {
        contentType: 'application/gzip',
      })
    }
    const row: CheckpointRow = {
      attemptId,
      jobId: a.jobId,
      seq: input.seq,
      // A render-progress post keeps the last milestone text.
      message: message ?? prev?.message ?? null,
      renderPercent: input.renderPercent ?? prev?.renderPercent ?? null,
      bundleKey,
      createdAt: now.toISOString(),
      windowStart: inWindow ? prev.windowStart : now.toISOString(),
      windowCount: inWindow ? prev.windowCount + 1 : 1,
    }
    await repo.putCheckpoint(row)
    // Only the latest bundle is kept.
    if (bundle && prev?.bundleKey && prev.bundleKey !== bundleKey)
      await deps.blobs.delete('checkpoints', prev.bundleKey)
    deps.log.info('checkpoint.received', { attemptId, seq: input.seq, bundle: Boolean(bundle) })
    return { accepted: true, seq: input.seq }
  })
}
