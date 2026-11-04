// Comments on a version, optionally pinned to a moment and a spot (plan v2 §5, §14 rules 3, 13). Anyone who can
// see the video reads them; Reviewers and up write; authors edit and delete their own; the owner and admins resolve
// or delete any. Private videos hide their comments with the video (404). A new comment emits comment.created into
// the webhook outbox and notifies the owner in the same transaction.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { notifyOwner } from './notifications.js'
import { assertCan, can, type Principal } from './policy.js'
import type { CommentRow, JobRow } from './types.js'
import { decodeCursor, loadJob, nextCursor } from './videos.js'
import { emitEvent } from './webhooks.js'

export const COMMENT_MAX = 2000
const PAGE_MAX = 200
/** Notes in one posted review block. */
export const NOTES_MAX = 20

export interface CommentInput {
  versionN: number
  body: string
  timeSec?: number | null | undefined
  x?: number | null | undefined
  y?: number | null | undefined
}

async function person(repo: Repo, id: string | null) {
  if (!id) return null
  const u = await repo.getUser(id)
  return { id, name: u?.name ?? null, email: u?.email ?? null }
}

async function commentDto(repo: Repo, p: Principal, job: JobRow, c: CommentRow) {
  const mine = c.authorId === p.userId
  const moderate = can(p, 'comment:moderate', { ownerId: job.ownerId })
  return {
    id: c.id,
    videoId: c.jobId,
    versionN: c.versionN,
    author: (await person(repo, c.authorId)) ?? { id: c.authorId, name: null, email: null },
    body: c.body,
    timeSec: c.timeSec,
    x: c.x,
    y: c.y,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    resolvedAt: c.resolvedAt,
    resolvedBy: await person(repo, c.resolvedBy),
    addressedInN: c.addressedInN,
    groupId: c.groupId ?? null,
    can: {
      edit: mine && can(p, 'comment:create'),
      delete: mine || moderate,
      resolve: moderate,
    },
  }
}

function cleanBody(body: string) {
  const b = body.trim()
  if (!b) throw new ApiError('invalid_request', 'Write something first.')
  if (b.length > COMMENT_MAX)
    throw new ApiError('invalid_request', `Keep comments under ${COMMENT_MAX} characters.`)
  return b
}

/** x/y are 0–1 within the displayed video and come as a pair; a spot needs a moment. */
function cleanPin(i: CommentInput, durationSec: number | null) {
  const timeSec = i.timeSec ?? null
  const x = i.x ?? null
  const y = i.y ?? null
  if ((x === null) !== (y === null)) throw new ApiError('invalid_request', 'Send x and y together.')
  if (x !== null && timeSec === null)
    throw new ApiError('invalid_request', 'A pinned spot needs timeSec too.')
  for (const [k, v] of [
    ['x', x],
    ['y', y],
  ] as const)
    if (v !== null && !(v >= 0 && v <= 1))
      throw new ApiError('invalid_request', `${k} must be between 0 and 1.`)
  if (timeSec !== null) {
    if (!(timeSec >= 0)) throw new ApiError('invalid_request', 'timeSec must be 0 or more.')
    if (durationSec !== null && timeSec > durationSec + 0.5)
      throw new ApiError('invalid_request', `timeSec is past the end of the video (${durationSec}s).`)
  }
  return { timeSec, x, y }
}

export async function listComments(
  deps: Deps,
  p: Principal,
  jobId: string,
  q: { versionN?: number | undefined; cursor?: string | undefined; limit?: number | undefined },
) {
  const job = await loadJob(deps.store, p, jobId)
  assertCan(p, 'video:read')
  const limit = Math.min(Math.max(q.limit ?? 100, 1), PAGE_MAX)
  const after = decodeCursor(q.cursor)
  const all = await deps.store.listComments(jobId, q.versionN)
  const rest = after
    ? all.filter((c) => c.createdAt > after.createdAt || (c.createdAt === after.createdAt && c.id > after.id))
    : all
  const page = rest.slice(0, limit)
  const readAt = await deps.store.getCommentReadAt(p.userId, jobId)
  const unreadCount = (q.versionN === undefined ? all : await deps.store.listComments(jobId)).filter(
    (c) => c.authorId !== p.userId && (readAt === null || c.createdAt > readAt),
  ).length
  return {
    items: await Promise.all(page.map((c) => commentDto(deps.store, p, job, c))),
    unreadCount,
    readAt,
    nextCursor: nextCursor(rest.length, limit, page),
  }
}

/** One comment on a version, optionally pinned to a moment and a spot. */
export async function addComment(deps: Deps, p: Principal, jobId: string, input: CommentInput) {
  const [dto] = await addNotes(deps, p, jobId, input.versionN, [input], null)
  if (!dto) throw new Error('no comment created')
  return dto
}

/**
 * Several timestamped notes posted together as one review block (a pass through the video): one comment per note, so
 * each keeps its own moment, spot, still, resolve and Incorporate feedback, sharing a group id. One notification for
 * the block; one comment.created event per note (webhook consumers see comments either way).
 */
export async function addComments(
  deps: Deps,
  p: Principal,
  jobId: string,
  input: { versionN: number; notes: Omit<CommentInput, 'versionN'>[] },
) {
  if (input.notes.length === 0) throw new ApiError('invalid_request', 'Add at least one note.')
  if (input.notes.length > NOTES_MAX)
    throw new ApiError('invalid_request', `Post at most ${NOTES_MAX} notes at once.`)
  const items = await addNotes(
    deps,
    p,
    jobId,
    input.versionN,
    input.notes.map((n) => ({ ...n, versionN: input.versionN })),
    input.notes.length > 1 ? deps.ids.uuid() : null,
  )
  return { items }
}

async function addNotes(
  deps: Deps,
  p: Principal,
  jobId: string,
  versionN: number,
  notes: CommentInput[],
  groupId: string | null,
) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, p, jobId)
    assertCan(p, 'comment:create')
    const v = await repo.getVersion(jobId, versionN)
    if (!v) throw new ApiError('not_found', 'Version not found.')
    const durationSec = (await repo.getOutput(jobId, versionN))?.durationSec ?? null
    const cleaned = notes.map((n) => {
      const body = cleanBody(n.body)
      const pin = cleanPin(n, durationSec)
      if (pin.timeSec !== null && v.status !== 'ready')
        throw new ApiError('conflict', 'Pins need a ready version. Leave timeSec out to comment on this one.')
      return { body, pin }
    })
    // A millisecond apart, so the notes list in the order they were posted.
    const now = deps.clock.now().getTime()
    const dtos = []
    for (const [i, { body, pin }] of cleaned.entries()) {
      const row: CommentRow = {
        id: deps.ids.uuid(),
        jobId,
        versionN,
        authorId: p.userId,
        body,
        ...pin,
        createdAt: new Date(now + i).toISOString(),
        editedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        addressedInN: null,
        deletedAt: null,
        groupId,
      }
      await repo.insertComment(row)
      const dto = await commentDto(repo, p, job, row)
      dtos.push(dto)
      await emitEvent(repo, deps, {
        type: 'comment.created',
        jobId,
        versionN,
        data: {
          comment: {
            id: row.id,
            body,
            author: dto.author,
            timeSec: pin.timeSec,
            x: pin.x,
            y: pin.y,
          },
        },
      })
    }
    const first = cleaned[0]
    if (first) {
      const at = first.pin.timeSec !== null ? ` at ${first.pin.timeSec.toFixed(1)}s` : ''
      const who = p.name ?? p.email
      await notifyOwner(repo, deps, {
        type: 'comment.created',
        jobId,
        versionN,
        actorId: p.userId,
        summary:
          cleaned.length > 1
            ? `${who} left ${cleaned.length} notes on v${versionN}${at}: ${first.body}`
            : `${who} commented on v${versionN}${at}: ${first.body}`,
      })
    }
    // Your own comments count as read.
    const last = dtos.at(-1)
    if (last) await repo.setCommentReadAt(p.userId, jobId, last.createdAt)
    return dtos
  })
}

async function loadComment(repo: Repo, p: Principal, commentId: string, lock = false) {
  const c = await repo.getComment(commentId)
  if (!c || c.deletedAt) throw new ApiError('not_found', 'Comment not found.')
  // Hides comments on private videos (and deleted videos) behind the same 404 as the video.
  const job = await loadJob(repo, p, c.jobId, lock)
  return { c, job }
}

/** Authors edit the text; the owner and admins resolve or reopen. */
export async function updateComment(
  deps: Deps,
  p: Principal,
  commentId: string,
  patch: { body?: string | undefined; resolved?: boolean | undefined },
) {
  return deps.store.tx(async (repo) => {
    const { c, job } = await loadComment(repo, p, commentId, true)
    const now = deps.clock.now().toISOString()
    const next: Partial<CommentRow> = {}
    if (patch.body !== undefined) {
      if (c.authorId !== p.userId) throw new ApiError('forbidden', 'Only the author can edit a comment.')
      assertCan(p, 'comment:create')
      const body = cleanBody(patch.body)
      if (body !== c.body) Object.assign(next, { body, editedAt: now })
    }
    if (patch.resolved !== undefined) {
      assertCan(p, 'comment:moderate', { ownerId: job.ownerId })
      if (patch.resolved && !c.resolvedAt) Object.assign(next, { resolvedAt: now, resolvedBy: p.userId })
      if (!patch.resolved && c.resolvedAt) Object.assign(next, { resolvedAt: null, resolvedBy: null })
    }
    if (Object.keys(next).length) await repo.updateComment(commentId, next)
    return commentDto(repo, p, job, { ...c, ...next })
  })
}

export async function deleteComment(deps: Deps, p: Principal, commentId: string) {
  await deps.store.tx(async (repo) => {
    const { c, job } = await loadComment(repo, p, commentId, true)
    if (c.authorId !== p.userId) assertCan(p, 'comment:moderate', { ownerId: job.ownerId })
    await repo.updateComment(commentId, { deletedAt: deps.clock.now().toISOString() })
  })
}

/** Moves your read watermark for this video's comments (to now, or to `upTo`). Never moves it back. */
export async function markCommentsRead(deps: Deps, p: Principal, jobId: string, upTo?: string) {
  await loadJob(deps.store, p, jobId)
  const now = deps.clock.now().toISOString()
  let at = now
  if (upTo) {
    if (Number.isNaN(Date.parse(upTo)))
      throw new ApiError('invalid_request', 'upTo must be an ISO timestamp.')
    at = new Date(upTo).toISOString() < now ? new Date(upTo).toISOString() : now
  }
  const prev = await deps.store.getCommentReadAt(p.userId, jobId)
  if (!prev || at > prev) await deps.store.setCommentReadAt(p.userId, jobId, at)
}
