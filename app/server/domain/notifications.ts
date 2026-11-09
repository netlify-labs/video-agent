// In-app notifications for video owners (plan v2 §3, §14 rule 13): comments and verdicts on their videos. The
// feed has its own read watermark and is polled app-wide, independent of run polling. Visibility is enforced
// when the feed is read, so a video that went private (or changed owner) drops out of an old owner's feed.
import type { Deps } from '../deps.js'
import type { Repo } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
import type { NotificationType } from './types.js'
import { canSee, decodeCursor, nextCursor } from './videos.js'

/** Notifies the video's owner, unless they're the one who acted. Call inside the causing transaction. */
export async function notifyOwner(
  repo: Repo,
  deps: Pick<Deps, 'ids' | 'clock'>,
  n: { type: NotificationType; jobId: string; versionN?: number | null; actorId: string; summary: string },
) {
  const job = await repo.getJob(n.jobId)
  if (!job || job.deletedAt || job.ownerId === n.actorId) return
  await repo.insertNotification({
    id: deps.ids.uuid(),
    userId: job.ownerId,
    jobId: n.jobId,
    versionN: n.versionN ?? null,
    type: n.type,
    actorId: n.actorId,
    summary: n.summary.slice(0, 280),
    createdAt: deps.clock.now().toISOString(),
  })
}

export async function listNotifications(
  deps: Deps,
  p: Principal,
  q: { cursor?: string | undefined; limit?: number | undefined },
) {
  assertCan(p, 'video:read')
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50)
  const before = decodeCursor(q.cursor)
  const readAt = await deps.store.getNotificationReadAt(p.userId)
  const rows = await deps.store.listNotifications(p.userId, {
    ...(before ? { before } : {}),
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  const items = []
  for (const n of page) {
    const job = await deps.store.getJob(n.jobId)
    if (!job || job.deletedAt || !canSee(p, job)) continue
    const actor = await deps.store.getUser(n.actorId)
    items.push({
      id: n.id,
      type: n.type,
      video: { id: job.id, title: job.title },
      versionN: n.versionN,
      actor: { id: n.actorId, name: actor?.name ?? null, email: actor?.email ?? null },
      summary: n.summary,
      createdAt: n.createdAt,
      unread: readAt === null || n.createdAt > readAt,
    })
  }
  // Unread count over the newest 100, which is plenty for a badge ("99+").
  const recent = await deps.store.listNotifications(p.userId, { limit: 100 })
  let unreadCount = 0
  for (const n of recent) {
    if (readAt !== null && n.createdAt <= readAt) continue
    const job = await deps.store.getJob(n.jobId)
    if (job && !job.deletedAt && canSee(p, job)) unreadCount++
  }
  return { items, unreadCount, nextCursor: nextCursor(rows.length, limit, page) }
}

/** Marks everything up to now (or up to `upTo`) as read. */
export async function markNotificationsRead(deps: Deps, p: Principal, upTo?: string) {
  assertCan(p, 'video:read')
  await deps.store.setNotificationReadAt(p.userId, upTo ?? deps.clock.now().toISOString())
}
