// A screen recording's pointer trace (screen-recording plan §4.7): set and replaced by its uploader (or an admin)
// until a version uses the recording, then frozen, because it's a run input that changes the output. Stored
// normalized (page text scrubbed, src/lib/recording-trace.ts) at `<mediaId>/trace.json` in the media store, by key and
// sha256 like the media bytes. Writes share the recording upload budget (ROLES['screen-recording'].perHour).
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { parseTrace, TraceError, type Trace } from '../lib/recording-trace.js'
import { mediaDto } from './media.js'
import { ROLES } from './media-roles.js'
import { assertCan, type Principal } from './policy.js'
import type { MediaRow } from './types.js'

export const traceKey = (mediaId: string) => `${mediaId}/trace.json`

/** The item, when the principal is its uploader or an admin; anyone else gets not_found, like a missing item. */
async function ownRecording(deps: Pick<Deps, 'store'>, p: Principal, id: string): Promise<MediaRow> {
  const m = await deps.store.getMedia(id)
  if (!m || m.deletedAt || m.deletingAt || (m.uploaderId !== p.userId && p.role !== 'admin'))
    throw new ApiError('not_found', 'Media not found.')
  return m
}

const fmt = (w: number | null, h: number | null, s: number | null) =>
  `${w ?? '?'}x${h ?? '?'}, ${s === null ? '?' : Math.round(s * 10) / 10} s`

export async function setMediaTrace(deps: Deps, p: Principal, id: string, body: unknown) {
  assertCan(p, 'media:upload')
  const m = await ownRecording(deps, p, id)
  if (m.role !== 'screen-recording' || m.status !== 'ready')
    throw new ApiError('invalid_request', 'Only screen recordings have a pointer trace.')
  let trace: Trace
  try {
    trace = parseTrace(body)
  } catch (e) {
    if (e instanceof TraceError) throw new ApiError('invalid_request', e.message)
    throw e
  }
  const { width, height, duration } = trace.frame
  if (
    width !== m.width ||
    height !== m.height ||
    m.durationSec === null ||
    Math.abs(duration - m.durationSec) > 0.5
  )
    throw new ApiError(
      'invalid_request',
      `This pointer trace is for a different recording (${fmt(width, height, duration)}; this one is ${fmt(m.width, m.height, m.durationSec)}).`,
    )
  // One hourly budget for recording sessions and trace writes together.
  const now = deps.clock.now()
  const since = new Date(now.getTime() - 3600_000).toISOString()
  const sessions = await deps.store.countRoleUploads(p.userId, ['screen-recording'], since)
  const writes = await deps.store.recentTraceWrites(p.userId, since)
  const { perHour } = ROLES['screen-recording']
  if (sessions + writes.length >= perHour) {
    const oldest = writes[0] ?? since
    const retryAfterSec = Math.max(1, Math.ceil((Date.parse(oldest) + 3600_000 - now.getTime()) / 1000))
    deps.log.warn('media.trace_rate_limited', { mediaId: id, sessions, writes: writes.length })
    throw new ApiError(
      'rate_limited',
      `You've uploaded ${perHour} recordings or traces in the last hour. Wait a little, then try again.`,
      { retryAfterSec },
    )
  }
  const json = JSON.stringify(trace)
  const bytes = new TextEncoder().encode(json)
  const sha256 = sha256Hex(bytes)
  const updated = await deps.store.tx(async (repo) => {
    // Under the row lock: a create that adds the recording to a version (and freezes the trace) waits for this write,
    // or this write waits for it and then sees the version.
    const [row] = await repo.lockMedia([id])
    if (!row || row.deletedAt) throw new ApiError('not_found', 'Media not found.')
    if ((await repo.jobsUsingMedia(id)).length)
      throw new ApiError('trace_frozen', "This recording's pointer trace is frozen: a video already uses it.")
    await deps.blobs.set('media', traceKey(id), bytes, { contentType: 'application/json' })
    const traceWrites = [...(row.traceWrites ?? []).filter((t) => t >= since), now.toISOString()].slice(-10)
    await repo.updateMedia(id, { traceKey: traceKey(id), traceSha256: sha256, traceWrites })
    return { ...row, traceKey: traceKey(id), traceSha256: sha256, traceWrites }
  })
  deps.log.info('media.trace_set', { mediaId: id, bytes: bytes.byteLength, sha256 })
  return mediaDto(deps, p, updated)
}

/** The stored (normalized) trace, for its uploader and admins only: others get not_found even if they see the item. */
export async function getMediaTrace(deps: Deps, p: Principal, id: string): Promise<Trace> {
  const m = await ownRecording(deps, p, id)
  if (!m.traceKey) throw new ApiError('not_found', 'This recording has no pointer trace.')
  const bytes = await deps.blobs.get('media', m.traceKey)
  if (!bytes) throw new ApiError('not_found', 'This recording has no pointer trace.')
  return JSON.parse(new TextDecoder().decode(bytes)) as Trace
}
