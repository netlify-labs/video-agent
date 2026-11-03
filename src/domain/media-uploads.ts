// Upload sessions for media over 4 MB (plan v2 §9, §14 rule 24). The browser declares the file's size and sha256,
// sends parts of at most 4 MB (each with its own sha256), and completes. Assembly runs in a background function given
// only the session id: it joins the parts, checks the whole hash, verifies the file (MP4 checks included) and makes
// the library item ready, or rejected with the reason. Sessions are bound to their uploader, expire, and reserve
// quota when they're created. Narration takes have budgets of their own (voice-over plan §8): stored bytes per person
// (the takeQuotaBytes setting) and a rate limit, checked at create and again at complete.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { classify, LIMITS, MediaError } from '../lib/media/classify.js'
import { mediaDto, storeMedia } from './media.js'
import { narrationSettings } from './narration-settings.js'
import { assertCan, type Principal } from './policy.js'
import { NO_PROVENANCE, type MediaRole, type MediaRow, type MediaUploadRow } from './types.js'
import type { Repo } from '../store/types.js'

export const PART_SIZE = 4 * 1024 * 1024
export const UPLOAD_QUOTA_BYTES = 1024 * 1024 * 1024
/** Take uploads each person may start in an hour (voice-over plan §8). */
export const TAKE_UPLOADS_PER_HOUR = 30
const SESSION_TTL_MS = 24 * 3600_000
const ASSEMBLY_LEASE_MS = 15 * 60_000
const POSTER_MAX = 512 * 1024

const partKey = (uploadId: string, idx: number) => `uploads/${uploadId}/${idx}`
const posterKey = (uploadId: string) => `uploads/${uploadId}/poster`

function sessionDto(u: MediaUploadRow, uploaded: number[]) {
  return {
    id: u.id,
    filename: u.filename,
    size: u.size,
    partSize: u.partSize,
    partCount: u.partCount,
    uploaded,
    status: u.status,
    mediaId: u.mediaId,
    error: u.error,
    expiresAt: u.expiresAt,
  }
}

export const isTakeRole = (role: string | null | undefined): role is MediaRole =>
  role === 'narration-take' || role === 'narration-upload'

/**
 * The take role a session was started with. Sessions don't store one yet (va-2qq.2.6 adds media_uploads.role and
 * the create body's `role`); until then this is null and no session is held to the take budgets.
 */
const sessionRole = (u: MediaUploadRow): MediaRole | null => (u as { role?: MediaRole | null }).role ?? null

const sizeLabel = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round(n / 1024 ** 2))} MB`

/**
 * The person's storage for narration takes once `incomingBytes` more are added: ready and in-flight takes count, and
 * takes GC is deleting count as freed. Refuses with 413 quota_exceeded, and the bytes left, when they don't fit.
 */
export async function quotaForTakes(
  deps: Pick<Deps, 'store' | 'log'>,
  userId: string,
  incomingBytes: number,
  repo: Repo = deps.store,
) {
  const { takeQuotaBytes } = await narrationSettings(deps)
  const bytes = await repo.narrationTakeBytes(userId)
  const quota = {
    quotaBytes: takeQuotaBytes,
    usedBytes: bytes,
    remainingBytes: Math.max(0, takeQuotaBytes - bytes),
  }
  if (bytes + incomingBytes > takeQuotaBytes) {
    deps.log.warn('media.take_quota_exceeded', { userId, incomingBytes, ...quota })
    throw new ApiError(
      'quota_exceeded',
      `Your recordings have ${sizeLabel(quota.remainingBytes)} of ${sizeLabel(takeQuotaBytes)} left, not enough for this one (${sizeLabel(incomingBytes)}). Delete unused recordings to make room.`,
      { ...quota, incomingBytes },
    )
  }
  return { ...quota, remainingBytes: takeQuotaBytes - bytes - incomingBytes }
}

/** At most TAKE_UPLOADS_PER_HOUR take uploads per person in any hour. */
async function assertTakeRate(deps: Pick<Deps, 'store' | 'log' | 'clock'>, userId: string, repo: Repo) {
  const since = new Date(deps.clock.now().getTime() - 3600_000).toISOString()
  const started = await repo.countNarrationTakes(userId, since)
  if (started >= TAKE_UPLOADS_PER_HOUR) {
    deps.log.warn('media.take_rate_limited', { userId, started })
    throw new ApiError(
      'rate_limited',
      `You've uploaded ${TAKE_UPLOADS_PER_HOUR} recordings in the last hour. Wait a little, then try again.`,
    )
  }
}

export async function createUpload(
  deps: Deps,
  p: Principal,
  input: {
    filename: string
    size: number
    sha256: string
    caption?: string | undefined
    /** A narration take (not yet accepted by the API: va-2qq.2.6); takes are held to the take budgets. */
    role?: MediaRole | null | undefined
  },
) {
  assertCan(p, 'media:upload')
  if (!Number.isInteger(input.size) || input.size <= 0)
    throw new ApiError('invalid_request', 'size must be positive.')
  if (input.size > LIMITS.videoBytes)
    throw new ApiError('invalid_request', 'Files must be 100 MB or smaller.')
  if (!/^[0-9a-f]{64}$/.test(input.sha256))
    throw new ApiError('invalid_request', 'sha256 must be 64 hex characters.')
  return deps.store.tx(async (repo) => {
    // Quota is reserved now, so parallel sessions can't overrun it.
    const reserved = await repo.reservedUploadBytes(p.userId)
    if (reserved + input.size > UPLOAD_QUOTA_BYTES)
      throw new ApiError(
        'rate_limited',
        'You have too many uploads in progress. Finish or wait for them first.',
      )
    if (isTakeRole(input.role)) {
      await assertTakeRate(deps, p.userId, repo)
      await quotaForTakes(deps, p.userId, input.size, repo)
    }
    const now = deps.clock.now()
    const row: MediaUploadRow = {
      id: `upl_${deps.ids.uuid().replaceAll('-', '').slice(0, 24)}`,
      uploaderId: p.userId,
      filename: input.filename.slice(0, 200),
      caption: input.caption?.trim().slice(0, 500) || null,
      size: input.size,
      sha256: input.sha256,
      partSize: PART_SIZE,
      partCount: Math.ceil(input.size / PART_SIZE),
      status: 'open',
      mediaId: null,
      error: null,
      leaseUntil: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    }
    await repo.insertUpload(row)
    return sessionDto(row, [])
  })
}

/** Only the uploader sees a session; to anyone else it doesn't exist. */
async function loadUpload(deps: Deps, p: Principal, id: string) {
  const u = await deps.store.getUpload(id)
  if (!u || u.uploaderId !== p.userId) throw new ApiError('not_found', 'Upload not found.')
  return u
}

export async function getUpload(deps: Deps, p: Principal, id: string) {
  const u = await loadUpload(deps, p, id)
  return sessionDto(
    u,
    (await deps.store.listUploadParts(id)).map((x) => x.idx),
  )
}

/** Stores one part. Re-sending the same bytes is fine; different bytes for a received part conflict. */
export async function putPart(
  deps: Deps,
  p: Principal,
  id: string,
  idx: number,
  bytes: Uint8Array,
  declaredSha256: string | undefined,
) {
  const u = await loadUpload(deps, p, id)
  if (u.status !== 'open') throw new ApiError('conflict', 'This upload is already complete.')
  if (u.expiresAt < deps.clock.now().toISOString())
    throw new ApiError('gone', 'This upload expired. Start again.')
  if (!Number.isInteger(idx) || idx < 0 || idx >= u.partCount)
    throw new ApiError('invalid_request', `Part index must be 0 to ${u.partCount - 1}.`)
  const expected = idx === u.partCount - 1 ? u.size - u.partSize * (u.partCount - 1) : u.partSize
  if (bytes.byteLength !== expected)
    throw new ApiError('invalid_request', `Part ${idx} must be ${expected} bytes (got ${bytes.byteLength}).`)
  const sha = sha256Hex(bytes)
  if (declaredSha256 && declaredSha256 !== sha)
    throw new ApiError(
      'invalid_request',
      `Part ${idx} doesn't match its sha256: it was corrupted on the way.`,
    )
  const prior = await deps.store.getUploadPart(id, idx)
  if (prior) {
    if (prior.sha256 !== sha)
      throw new ApiError('conflict', `Part ${idx} was already received with different bytes.`)
    return { idx, sha256: sha, duplicate: true }
  }
  await deps.blobs.set('media', partKey(id, idx), bytes)
  await deps.store.insertUploadPart({ uploadId: id, idx, size: bytes.byteLength, sha256: sha })
  return { idx, sha256: sha, duplicate: false }
}

/**
 * Finishes the upload: takes the completion lease, shows the item in the library as being checked, and dispatches
 * assembly. Completing again while it assembles returns the same state without a second assembly.
 */
export async function completeUpload(
  deps: Deps,
  p: Principal,
  id: string,
  input: { poster?: string | undefined } = {},
) {
  const u0 = await loadUpload(deps, p, id)
  if (u0.status === 'assembling' || u0.status === 'done' || u0.status === 'failed')
    return getUpload(deps, p, id)
  const parts = await deps.store.listUploadParts(id)
  const missing = Array.from({ length: u0.partCount }, (_, i) => i).filter(
    (i) => !parts.some((x) => x.idx === i),
  )
  if (missing.length)
    throw new ApiError(
      'conflict',
      `Parts still missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}.`,
    )
  if (input.poster) {
    const poster = Buffer.from(input.poster, 'base64')
    if (poster.byteLength > POSTER_MAX)
      throw new ApiError('invalid_request', 'The poster must be 512 KB or smaller.')
    await deps.blobs.set('media', posterKey(id), new Uint8Array(poster))
  }
  const started = await deps.store.tx(async (repo) => {
    const u = await repo.getUpload(id, { lock: true })
    if (!u || u.status !== 'open') return false
    // Other takes may have finished since this one started; check the quota again with its bytes.
    const role = sessionRole(u)
    if (isTakeRole(role)) await quotaForTakes(deps, u.uploaderId, u.size, repo)
    const now = deps.clock.now()
    const mediaId = `med_${deps.ids.uuid().replaceAll('-', '').slice(0, 24)}`
    // Visible to the uploader as "being checked" until assembly finishes.
    const pending: MediaRow = {
      id: mediaId,
      uploaderId: u.uploaderId,
      kind: 'video',
      status: 'verifying',
      rejectReason: null,
      filename: u.filename,
      title: null,
      caption: u.caption,
      mime: 'application/octet-stream',
      ext: 'bin',
      bytes: u.size,
      originalKey: '',
      originalSha256: u.sha256,
      cleanKey: '',
      cleanSha256: u.sha256,
      width: null,
      height: null,
      durationSec: null,
      posterKey: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deletedAt: null,
      role,
      scopeJobId: null,
      retainUntil: null,
      deletingAt: null,
      ...NO_PROVENANCE,
    }
    await repo.insertMedia(pending)
    await repo.updateUpload(id, {
      status: 'assembling',
      mediaId,
      leaseUntil: new Date(now.getTime() + ASSEMBLY_LEASE_MS).toISOString(),
    })
    return true
  })
  if (started) await deps.platform.dispatchMediaAssembly(id)
  return getUpload(deps, p, id)
}

/** The background step: join, verify and store. Idempotent: a finished session is left alone. */
export async function assembleUpload(deps: Deps, id: string) {
  const u = await deps.store.getUpload(id)
  if (!u || u.status !== 'assembling' || !u.mediaId) return 'skipped'
  const fail = async (reason: string) => {
    const now = deps.clock.now().toISOString()
    await deps.store.updateMedia(u.mediaId ?? '', {
      status: 'rejected',
      rejectReason: reason,
      updatedAt: now,
    })
    await deps.store.updateUpload(id, { status: 'failed', error: reason, leaseUntil: null })
    await dropParts(deps, u)
    deps.log.warn('media.assembly_rejected', { uploadId: id, reason })
    return 'rejected' as const
  }
  const parts = await deps.store.listUploadParts(id)
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    const b = await deps.blobs.get('media', partKey(id, part.idx))
    if (!b || sha256Hex(b) !== part.sha256)
      return fail(`Part ${part.idx} is missing or damaged. Upload the file again.`)
    chunks.push(b)
  }
  const bytes = new Uint8Array(Buffer.concat(chunks))
  if (bytes.byteLength !== u.size || sha256Hex(bytes) !== u.sha256)
    return fail("The assembled file doesn't match the size and sha256 declared when the upload started.")
  let c
  try {
    c = classify(bytes)
  } catch (e) {
    if (!(e instanceof MediaError)) deps.log.error('media.classify_failed', { uploadId: id, error: e })
    return fail(e instanceof MediaError ? e.message : "The file couldn't be read.")
  }
  const poster = await deps.blobs.get('media', posterKey(id))
  const row = await storeMedia(deps, { userId: u.uploaderId }, bytes, c, {
    id: u.mediaId,
    filename: u.filename,
    caption: u.caption ?? undefined,
    poster,
  })
  // Everything verified about the file; the item keeps its id, uploader and creation time.
  await deps.store.updateMedia(u.mediaId, {
    kind: row.kind,
    status: row.status,
    filename: row.filename,
    mime: row.mime,
    ext: row.ext,
    bytes: row.bytes,
    originalKey: row.originalKey,
    originalSha256: row.originalSha256,
    cleanKey: row.cleanKey,
    cleanSha256: row.cleanSha256,
    width: row.width,
    height: row.height,
    durationSec: row.durationSec,
    posterKey: row.posterKey,
    updatedAt: row.updatedAt,
  })
  await deps.store.updateUpload(id, { status: 'done', leaseUntil: null })
  await dropParts(deps, u)
  deps.log.info('media.assembled', {
    uploadId: id,
    mediaId: u.mediaId,
    kind: c.kind,
    bytes: bytes.byteLength,
  })
  return 'ready'
}

async function dropParts(deps: Deps, u: MediaUploadRow) {
  for (const k of await deps.blobs.list('media', `uploads/${u.id}/`)) await deps.blobs.delete('media', k)
  await deps.store.deleteUploadParts(u.id)
}

/** Cancels an unfinished upload: its parts and quota are freed at once. */
export async function cancelUpload(deps: Deps, p: Principal, id: string) {
  const u = await loadUpload(deps, p, id)
  if (u.status === 'assembling')
    throw new ApiError('conflict', "This upload is being checked; it can't be cancelled now.")
  await dropParts(deps, u)
  await deps.store.deleteUpload(id)
}

/** Sweep: abandoned sessions free their parts and quota; a stuck assembly is dispatched again. */
export async function sweepUploads(deps: Deps, limit = 20) {
  const now = deps.clock.now()
  for (const u of await deps.store.listStaleUploads(now.toISOString(), limit)) {
    if (u.status === 'assembling') {
      await deps.store.updateUpload(u.id, {
        leaseUntil: new Date(now.getTime() + ASSEMBLY_LEASE_MS).toISOString(),
      })
      await deps.platform.dispatchMediaAssembly(u.id).catch((e: unknown) => {
        deps.log.warn('media.redispatch_failed', { uploadId: u.id, error: e })
      })
      continue
    }
    await dropParts(deps, u)
    await deps.store.deleteUpload(u.id)
  }
}

export { mediaDto }
