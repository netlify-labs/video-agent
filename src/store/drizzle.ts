// Postgres store on Netlify Database through Drizzle. Tests run it against PGlite.
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  exists,
} from 'drizzle-orm'
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core/async/db'
import * as t from '../../db/schema.js'
import { SLOT_STAGES, TERMINAL_STAGES } from '../domain/types.js'
import type {
  ApiKeyRow,
  AttemptRow,
  CleanupRow,
  IdempotencyRow,
  JobRow,
  OutputRow,
  PublicationRow,
  ReceiptRow,
  SettingsRow,
  Stage,
  UserRow,
  VersionRow,
  WebhookEventRow,
  VerdictRow,
  NotificationRow,
  PlanRow,
  CommentRow,
  CheckpointRow,
  EditRow,
  MediaRow,
  MediaUploadRow,
  MediaUploadPartRow,
  VersionMediaRow,
  VersionProvenanceRow,
  GatewayCallRow,
  WebhookDeliveryRow,
  UserWebhookRow,
  OAuthClientRow,
  OAuthRequestRow,
  OAuthGrantRow,
  OAuthTokenRow,
  SessionRow,
  UserIdentityRow,
} from '../domain/types.js'
import { addUsage, type UsageRow } from './memory.js'
import type { Repo, Store } from './types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver-agnostic (netlify-db, pglite)
type Db = PgAsyncDatabase<any, any, any>

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the row type
const one = <T>(rows: unknown[]): T | null => (rows[0] as T | undefined) ?? null
const nonDue = [...TERMINAL_STAGES, 'queued', 'unresolved']

function repoFor(db: Db): Repo {
  return {
    getSettings: async () => one<SettingsRow>(await db.select().from(t.settings).where(eq(t.settings.id, 1))),
    insertSettingsIfAbsent: async (row) => {
      await db.insert(t.settings).values(row).onConflictDoNothing()
      return one<SettingsRow>(await db.select().from(t.settings).where(eq(t.settings.id, 1))) as SettingsRow
    },
    updateSettings: async (patch) => {
      await db.update(t.settings).set(patch).where(eq(t.settings.id, 1))
    },

    getUser: async (id) => one<UserRow>(await db.select().from(t.users).where(eq(t.users.id, id))),
    insertUserIfAbsent: async (row) => {
      await db.insert(t.users).values(row).onConflictDoNothing()
      return one<UserRow>(await db.select().from(t.users).where(eq(t.users.id, row.id))) as UserRow
    },
    updateUser: async (id, patch) => {
      await db.update(t.users).set(patch).where(eq(t.users.id, id))
    },
    listUsers: async () => (await db.select().from(t.users).orderBy(asc(t.users.createdAt))) as UserRow[],

    insertKey: async (row) => {
      await db.insert(t.apiKeys).values(row)
    },
    getKey: async (id) => one<ApiKeyRow>(await db.select().from(t.apiKeys).where(eq(t.apiKeys.id, id))),
    listKeys: async (ownerId) =>
      await db
        .select()
        .from(t.apiKeys)
        .where(eq(t.apiKeys.ownerId, ownerId))
        .orderBy(desc(t.apiKeys.createdAt)),
    updateKey: async (id, patch) => {
      await db.update(t.apiKeys).set(patch).where(eq(t.apiKeys.id, id))
    },

    insertJob: async (row) => {
      await db.insert(t.jobs).values(row)
    },
    getJob: async (id, opts) => {
      const q = db.select().from(t.jobs).where(eq(t.jobs.id, id))
      return one<JobRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateJob: async (id, patch) => {
      await db.update(t.jobs).set(patch).where(eq(t.jobs.id, id))
    },
    listJobs: async (q) => {
      const conds = [isNull(t.jobs.deletedAt)]
      if (q.ownerId) conds.push(eq(t.jobs.ownerId, q.ownerId))
      if (q.visibleTo && !q.visibleTo.all) {
        const visible = or(eq(t.jobs.private, false), eq(t.jobs.ownerId, q.visibleTo.userId))
        if (visible) conds.push(visible)
      }
      if (q.status) conds.push(eq(t.jobs.status, q.status))
      const livePub = db
        .select({ one: sql`1` })
        .from(t.publications)
        .where(and(eq(t.publications.jobId, t.jobs.id), isNull(t.publications.unpublishedAt)))
      if (q.published === true) conds.push(exists(livePub))
      if (q.published === false) conds.push(sql`not ${exists(livePub)}`)
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
        const promptMatch = db
          .select({ one: sql`1` })
          .from(t.versions)
          .where(and(eq(t.versions.jobId, t.jobs.id), ilike(t.versions.prompt, like)))
        const titleOrPrompt = or(ilike(t.jobs.title, like), exists(promptMatch))
        if (titleOrPrompt) conds.push(titleOrPrompt)
      }
      if (q.cursor) {
        const c = q.cursor
        const before = or(
          lt(t.jobs.createdAt, c.createdAt),
          and(eq(t.jobs.createdAt, c.createdAt), lt(t.jobs.id, c.id)),
        )
        if (before) conds.push(before)
      }
      return (await db
        .select()
        .from(t.jobs)
        .where(and(...conds))
        .orderBy(desc(t.jobs.createdAt), desc(t.jobs.id))
        .limit(q.limit)) as JobRow[]
    },
    insertVersion: async (row) => {
      await db.insert(t.versions).values(row)
    },
    getVersion: async (jobId, n) =>
      one<VersionRow>(
        await db
          .select()
          .from(t.versions)
          .where(and(eq(t.versions.jobId, jobId), eq(t.versions.n, n))),
      ),
    listVersions: async (jobId) =>
      (await db
        .select()
        .from(t.versions)
        .where(eq(t.versions.jobId, jobId))
        .orderBy(desc(t.versions.n))) as VersionRow[],
    updateVersion: async (jobId, n, patch) => {
      await db
        .update(t.versions)
        .set(patch)
        .where(and(eq(t.versions.jobId, jobId), eq(t.versions.n, n)))
    },

    insertAttempt: async (row) => {
      await db.insert(t.attempts).values(row)
    },
    getAttempt: async (id, opts) => {
      const q = db.select().from(t.attempts).where(eq(t.attempts.id, id))
      return one<AttemptRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateAttempt: async (id, patch, expectStage) => {
      const where = expectStage
        ? and(eq(t.attempts.id, id), eq(t.attempts.stage, expectStage))
        : eq(t.attempts.id, id)
      const rows = await db.update(t.attempts).set(patch).where(where).returning({ id: t.attempts.id })
      return rows.length > 0
    },
    leaseAttempt: async (id, stage, now, until) =>
      (
        await db
          .update(t.attempts)
          .set({ leaseUntil: until })
          .where(
            and(
              eq(t.attempts.id, id),
              eq(t.attempts.stage, stage),
              or(isNull(t.attempts.leaseUntil), lte(t.attempts.leaseUntil, now)),
            ),
          )
          .returning({ id: t.attempts.id })
      ).length > 0,
    latestAttempt: async (jobId, versionN) =>
      one<AttemptRow>(
        await db
          .select()
          .from(t.attempts)
          .where(and(eq(t.attempts.jobId, jobId), eq(t.attempts.versionN, versionN)))
          .orderBy(desc(t.attempts.queuedAt))
          .limit(1),
      ),
    listAttempts: async (jobId) =>
      (await db
        .select()
        .from(t.attempts)
        .where(eq(t.attempts.jobId, jobId))
        .orderBy(desc(t.attempts.queuedAt))) as AttemptRow[],
    listDueAttempts: async (now, limit) =>
      (await db
        .select()
        .from(t.attempts)
        .where(
          and(
            notInArray(t.attempts.stage, nonDue),
            lte(t.attempts.nextActionAt, now),
            or(isNull(t.attempts.leaseUntil), lte(t.attempts.leaseUntil, now)),
          ),
        )
        .orderBy(asc(t.attempts.nextActionAt))
        .limit(limit)) as AttemptRow[],
    countSlotHolders: async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.attempts)
        .where(inArray(t.attempts.stage, [...SLOT_STAGES]))
      return row?.n ?? 0
    },
    claimOldestQueued: async (now) =>
      one<AttemptRow>(
        await db
          .select()
          .from(t.attempts)
          .where(
            and(
              eq(t.attempts.stage, 'queued'),
              or(isNull(t.attempts.nextActionAt), lte(t.attempts.nextActionAt, now)),
            ),
          )
          .orderBy(asc(t.attempts.queuedAt))
          .limit(1)
          .for('update', { skipLocked: true }),
      ),
    lockQueueControl: async () => {
      await db.insert(t.queueControl).values({ id: 1 }).onConflictDoNothing()
      await db.select().from(t.queueControl).where(eq(t.queueControl.id, 1)).for('update')
    },
    listAttemptsByStage: async (stages, limit) =>
      (await db
        .select()
        .from(t.attempts)
        .where(inArray(t.attempts.stage, stages))
        .limit(limit)) as AttemptRow[],

    upsertOutput: async (row) => {
      await db
        .insert(t.outputs)
        .values(row)
        .onConflictDoUpdate({ target: [t.outputs.jobId, t.outputs.versionN], set: row })
    },
    getOutput: async (jobId, n) =>
      one<OutputRow>(
        await db
          .select()
          .from(t.outputs)
          .where(and(eq(t.outputs.jobId, jobId), eq(t.outputs.versionN, n))),
      ),
    insertPublication: async (row) => {
      await db.insert(t.publications).values(row)
    },
    getPublication: async (slug) =>
      one<PublicationRow>(await db.select().from(t.publications).where(eq(t.publications.slug, slug))),
    listPublications: async (jobId) =>
      await db
        .select()
        .from(t.publications)
        .where(eq(t.publications.jobId, jobId))
        .orderBy(desc(t.publications.publishedAt)),
    updatePublication: async (slug, patch) => {
      await db.update(t.publications).set(patch).where(eq(t.publications.slug, slug))
    },

    getReceipt: async (id) =>
      one<ReceiptRow>(await db.select().from(t.callbackReceipts).where(eq(t.callbackReceipts.attemptId, id))),
    insertReceipt: async (row) => {
      await db.insert(t.callbackReceipts).values(row)
    },
    getIdempotency: async (p, op, key) =>
      one<IdempotencyRow>(
        await db
          .select()
          .from(t.idempotencyKeys)
          .where(
            and(
              eq(t.idempotencyKeys.principalId, p),
              eq(t.idempotencyKeys.operation, op),
              eq(t.idempotencyKeys.key, key),
            ),
          ),
      ),
    insertIdempotency: async (row) => {
      await db.insert(t.idempotencyKeys).values(row)
    },
    deleteExpiredPlans: async (now) =>
      (await db.delete(t.plans).where(lte(t.plans.expiresAt, now)).returning({ id: t.plans.id })).length,
    deleteExpiredIdempotency: async (now) =>
      (
        await db
          .delete(t.idempotencyKeys)
          .where(lte(t.idempotencyKeys.expiresAt, now))
          .returning({ k: t.idempotencyKeys.key })
      ).length,

    insertComment: async (row) => {
      await db.insert(t.comments).values(row)
    },
    getComment: async (id) =>
      one<CommentRow>(await db.select().from(t.comments).where(eq(t.comments.id, id))),
    updateComment: async (id, patch) => {
      await db.update(t.comments).set(patch).where(eq(t.comments.id, id))
    },
    listComments: async (jobId, n) =>
      await db
        .select()
        .from(t.comments)
        .where(
          and(
            eq(t.comments.jobId, jobId),
            isNull(t.comments.deletedAt),
            n === undefined ? undefined : eq(t.comments.versionN, n),
          ),
        )
        .orderBy(asc(t.comments.createdAt), asc(t.comments.id)),
    insertPlan: async (row) => {
      await db.insert(t.plans).values(row)
    },
    getPlan: async (id, opts) => {
      const q = db.select().from(t.plans).where(eq(t.plans.id, id))
      return one<PlanRow>(opts?.lock ? await q.for('update') : await q)
    },
    updatePlan: async (id, patch) => {
      await db.update(t.plans).set(patch).where(eq(t.plans.id, id))
    },
    insertGatewayCall: async (row) => {
      await db.insert(t.gatewayCalls).values(row)
    },
    listGatewayCalls: async (q) =>
      (await db
        .select()
        .from(t.gatewayCalls)
        .where(
          and(
            gte(t.gatewayCalls.at, q.since),
            q.callerId ? eq(t.gatewayCalls.callerId, q.callerId) : undefined,
          ),
        )) as GatewayCallRow[],
    insertNotification: async (row) => {
      await db.insert(t.notifications).values(row)
    },
    listNotifications: async (userId, q) => {
      const n = t.notifications
      const conds = [eq(n.userId, userId)]
      if (q.before) {
        const older = or(
          lt(n.createdAt, q.before.createdAt),
          and(eq(n.createdAt, q.before.createdAt), lt(n.id, q.before.id)),
        )
        if (older) conds.push(older)
      }
      return (await db
        .select()
        .from(n)
        .where(and(...conds))
        .orderBy(desc(n.createdAt), desc(n.id))
        .limit(q.limit)) as NotificationRow[]
    },
    getNotificationReadAt: async (userId) =>
      (await db.select().from(t.notificationReads).where(eq(t.notificationReads.userId, userId)))[0]
        ?.readAt ?? null,
    setNotificationReadAt: async (userId, readAt) => {
      await db
        .insert(t.notificationReads)
        .values({ userId, readAt })
        .onConflictDoUpdate({ target: t.notificationReads.userId, set: { readAt } })
    },
    commentCounts: async (jobIds, userId) => {
      if (jobIds.length === 0) return {}
      const c = t.comments
      const r = t.commentReads
      const rows = await db
        .select({
          jobId: c.jobId,
          count: sql<number>`count(*)::int`,
          unread: userId
            ? sql<number>`count(*) filter (where ${c.authorId} <> ${userId} and (${r.readAt} is null or ${c.createdAt} > ${r.readAt}))::int`
            : sql<number>`0`,
        })
        .from(c)
        .leftJoin(r, and(eq(r.jobId, c.jobId), eq(r.userId, userId ?? '')))
        .where(and(inArray(c.jobId, jobIds), isNull(c.deletedAt)))
        .groupBy(c.jobId, r.readAt)
      return Object.fromEntries(rows.map((x) => [x.jobId, { count: x.count, unread: x.unread }]))
    },
    insertMedia: async (row) => {
      await db.insert(t.media).values(row)
    },
    getMedia: async (id) => one<MediaRow>(await db.select().from(t.media).where(eq(t.media.id, id))),
    updateMedia: async (id, patch) => {
      await db.update(t.media).set(patch).where(eq(t.media.id, id))
    },
    listMedia: async (q) => {
      const m = t.media
      const visible = q.includePendingOf
        ? or(eq(m.status, 'ready'), eq(m.uploaderId, q.includePendingOf))
        : eq(m.status, 'ready')
      return (await db
        .select()
        .from(m)
        .where(
          and(
            isNull(m.deletedAt),
            visible,
            q.kind ? eq(m.kind, q.kind) : undefined,
            q.before
              ? or(
                  lt(m.createdAt, q.before.createdAt),
                  and(eq(m.createdAt, q.before.createdAt), lt(m.id, q.before.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(m.createdAt), desc(m.id))
        .limit(q.limit)) as MediaRow[]
    },
    insertUpload: async (row) => {
      await db.insert(t.mediaUploads).values(row)
    },
    getUpload: async (id, opts) => {
      const q = db.select().from(t.mediaUploads).where(eq(t.mediaUploads.id, id))
      return one<MediaUploadRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateUpload: async (id, patch) => {
      await db.update(t.mediaUploads).set(patch).where(eq(t.mediaUploads.id, id))
    },
    deleteUpload: async (id) => {
      await db.delete(t.mediaUploads).where(eq(t.mediaUploads.id, id))
    },
    reservedUploadBytes: async (uploaderId) => {
      const u = t.mediaUploads
      const rows = await db
        // bigint sums come back as strings from Postgres.
        .select({ total: sql<string | number>`coalesce(sum(${u.size}), 0)::bigint` })
        .from(u)
        .where(and(eq(u.uploaderId, uploaderId), inArray(u.status, ['open', 'assembling'])))
      return Number(rows[0]?.total ?? 0)
    },
    listStaleUploads: async (now, limit) => {
      const u = t.mediaUploads
      return (await db
        .select()
        .from(u)
        .where(
          or(
            and(eq(u.status, 'open'), lt(u.expiresAt, now)),
            and(eq(u.status, 'assembling'), lt(u.leaseUntil, now)),
            and(inArray(u.status, ['done', 'failed']), lt(u.expiresAt, now)),
          ),
        )
        .limit(limit)) as MediaUploadRow[]
    },
    getUploadPart: async (uploadId, idx) =>
      one<MediaUploadPartRow>(
        await db
          .select()
          .from(t.mediaUploadParts)
          .where(and(eq(t.mediaUploadParts.uploadId, uploadId), eq(t.mediaUploadParts.idx, idx))),
      ),
    insertUploadPart: async (row) => {
      await db.insert(t.mediaUploadParts).values(row).onConflictDoNothing()
    },
    listUploadParts: async (uploadId) =>
      await db
        .select()
        .from(t.mediaUploadParts)
        .where(eq(t.mediaUploadParts.uploadId, uploadId))
        .orderBy(asc(t.mediaUploadParts.idx)),
    deleteUploadParts: async (uploadId) => {
      await db.delete(t.mediaUploadParts).where(eq(t.mediaUploadParts.uploadId, uploadId))
    },
    insertVersionMedia: async (rows) => {
      if (rows.length) await db.insert(t.versionMedia).values(rows)
    },
    listVersionMedia: async (jobId, n) =>
      (await db
        .select()
        .from(t.versionMedia)
        .where(and(eq(t.versionMedia.jobId, jobId), eq(t.versionMedia.versionN, n)))
        .orderBy(asc(t.versionMedia.position))) as VersionMediaRow[],
    mediaUsage: async (ids) => {
      if (ids.length === 0) return {}
      const rows = await db
        .selectDistinct({ mediaId: t.versionMedia.mediaId, jobId: t.versionMedia.jobId })
        .from(t.versionMedia)
        .where(inArray(t.versionMedia.mediaId, ids))
      const out: Record<string, string[]> = {}
      for (const r of rows) (out[r.mediaId] ??= []).push(r.jobId)
      return out
    },
    mediaBySource: async (source, ids) => {
      if (!ids.length) return []
      const m = t.media
      return (await db
        .select()
        .from(m)
        .where(and(eq(m.source, source), inArray(m.sourceId, ids), isNull(m.deletedAt)))
        .orderBy(desc(m.createdAt))) as MediaRow[]
    },
    versionProvenance: async (jobId) => {
      const v = t.versionMedia
      const m = t.media
      return (await db
        .select({
          versionN: v.versionN,
          mediaId: v.mediaId,
          position: v.position,
          kind: v.kind,
          source: m.source,
          sourceId: m.sourceId,
          sourceUrl: m.sourceUrl,
          sourceTitle: m.sourceTitle,
          license: m.license,
          licenseVersion: m.licenseVersion,
          licenseUrl: m.licenseUrl,
          creator: m.creator,
          creatorUrl: m.creatorUrl,
          attribution: m.attribution,
        })
        .from(v)
        .innerJoin(m, eq(m.id, v.mediaId))
        .where(and(eq(v.jobId, jobId), isNotNull(m.source)))
        .orderBy(asc(v.versionN), asc(v.position))) as VersionProvenanceRow[]
    },
    insertEdit: async (row) => {
      await db.insert(t.edits).values(row)
    },
    getEdit: async (id, opts) => {
      const q = db.select().from(t.edits).where(eq(t.edits.id, id))
      return one<EditRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateEdit: async (id, patch) => {
      await db.update(t.edits).set(patch).where(eq(t.edits.id, id))
    },
    deleteEdit: async (id) => {
      await db.delete(t.edits).where(eq(t.edits.id, id))
    },
    findEdit: async (authorId, jobId, baseN, now) =>
      one<EditRow>(
        await db
          .select()
          .from(t.edits)
          .where(
            and(
              eq(t.edits.authorId, authorId),
              eq(t.edits.jobId, jobId),
              eq(t.edits.baseN, baseN),
              isNull(t.edits.renderedN),
              gte(t.edits.expiresAt, now),
            ),
          )
          .orderBy(desc(t.edits.updatedAt))
          .limit(1),
      ),
    listExpiredEdits: async (now, limit) =>
      (await db
        .select()
        .from(t.edits)
        .where(lt(t.edits.expiresAt, now))
        .orderBy(asc(t.edits.expiresAt))
        .limit(limit)) as EditRow[],
    getCheckpoint: async (attemptId, opts) => {
      const q = db.select().from(t.checkpoints).where(eq(t.checkpoints.attemptId, attemptId))
      return one<CheckpointRow>(opts?.lock ? await q.for('update') : await q)
    },
    putCheckpoint: async (row) => {
      // Even two racing first posts keep the highest seq.
      await db
        .insert(t.checkpoints)
        .values(row)
        .onConflictDoUpdate({
          target: t.checkpoints.attemptId,
          set: row,
          setWhere: sql`${t.checkpoints.seq} < ${row.seq}`,
        })
    },
    insertVersionComments: async (rows) => {
      if (rows.length) await db.insert(t.versionComments).values(rows)
    },
    listVersionComments: async (jobId, n) =>
      await db
        .select()
        .from(t.versionComments)
        .where(
          and(
            eq(t.versionComments.jobId, jobId),
            n === undefined ? undefined : eq(t.versionComments.versionN, n),
          ),
        )
        .orderBy(asc(t.versionComments.versionN), asc(t.versionComments.position)),
    markCommentsAddressed: async (jobId, ids, n) => {
      if (ids.length === 0) return
      await db
        .update(t.comments)
        .set({ addressedInN: n })
        .where(and(eq(t.comments.jobId, jobId), inArray(t.comments.id, ids), isNull(t.comments.deletedAt)))
    },
    getCommentReadAt: async (userId, jobId) =>
      (
        await db
          .select()
          .from(t.commentReads)
          .where(and(eq(t.commentReads.userId, userId), eq(t.commentReads.jobId, jobId)))
      )[0]?.readAt ?? null,
    setCommentReadAt: async (userId, jobId, readAt) => {
      await db
        .insert(t.commentReads)
        .values({ userId, jobId, readAt })
        .onConflictDoUpdate({ target: [t.commentReads.userId, t.commentReads.jobId], set: { readAt } })
    },
    insertOwnershipTransfer: async (row) => {
      await db.insert(t.ownershipTransfers).values(row)
    },
    listOwnershipTransfers: async (jobId) =>
      await db
        .select()
        .from(t.ownershipTransfers)
        .where(eq(t.ownershipTransfers.jobId, jobId))
        .orderBy(asc(t.ownershipTransfers.at)),
    putVerdict: async (row) => {
      await db
        .insert(t.verdicts)
        .values(row)
        .onConflictDoUpdate({
          target: [t.verdicts.jobId, t.verdicts.versionN, t.verdicts.userId],
          set: { verdict: row.verdict, note: row.note, updatedAt: row.updatedAt },
        })
    },
    deleteVerdict: async (jobId, n, userId) => {
      await db
        .delete(t.verdicts)
        .where(and(eq(t.verdicts.jobId, jobId), eq(t.verdicts.versionN, n), eq(t.verdicts.userId, userId)))
    },
    listVerdicts: async (jobIds) =>
      jobIds.length === 0
        ? []
        : ((await db.select().from(t.verdicts).where(inArray(t.verdicts.jobId, jobIds))) as VerdictRow[]),
    insertWebhookEvent: async (row) => {
      await db.insert(t.webhookEvents).values(row)
    },
    getWebhookEvent: async (id) =>
      one<WebhookEventRow>(await db.select().from(t.webhookEvents).where(eq(t.webhookEvents.eventId, id))),
    insertWebhookDelivery: async (row) => {
      await db.insert(t.webhookDeliveries).values(row).onConflictDoNothing()
    },
    claimDueWebhookDeliveries: async (now, leaseUntil, limit) => {
      const d = t.webhookDeliveries
      const due = db
        .select({ id: d.id })
        .from(d)
        .where(
          and(
            isNull(d.deliveredAt),
            isNull(d.droppedAt),
            lte(d.nextRetryAt, now),
            or(isNull(d.leaseUntil), lte(d.leaseUntil, now)),
          ),
        )
        .orderBy(asc(d.nextRetryAt))
        .limit(limit)
        .for('update', { skipLocked: true })
      return (await db
        .update(d)
        .set({ leaseUntil })
        .where(inArray(d.id, due))
        .returning()) as WebhookDeliveryRow[]
    },
    updateWebhookDelivery: async (id, patch) => {
      await db.update(t.webhookDeliveries).set(patch).where(eq(t.webhookDeliveries.id, id))
    },
    getUserWebhook: async (userId) =>
      one<UserWebhookRow>(await db.select().from(t.userWebhooks).where(eq(t.userWebhooks.userId, userId))),
    putUserWebhook: async (row) => {
      await db
        .insert(t.userWebhooks)
        .values(row)
        .onConflictDoUpdate({
          target: t.userWebhooks.userId,
          set: { url: row.url, secretEnc: row.secretEnc, updatedAt: row.updatedAt },
        })
    },
    deleteUserWebhook: async (userId) => {
      await db.delete(t.userWebhooks).where(eq(t.userWebhooks.userId, userId))
    },
    insertCleanup: async (row) => {
      await db.insert(t.cleanup).values(row).onConflictDoNothing()
    },
    listDueCleanup: async (now, limit) =>
      (await db
        .select()
        .from(t.cleanup)
        .where(and(isNull(t.cleanup.doneAt), lte(t.cleanup.nextActionAt, now)))
        .limit(limit)) as CleanupRow[],
    updateCleanup: async (id, patch) => {
      await db.update(t.cleanup).set(patch).where(eq(t.cleanup.id, id))
    },

    insertOAuthClient: async (row) => {
      await db.insert(t.oauthClients).values(row)
    },
    getOAuthClient: async (id) =>
      one<OAuthClientRow>(await db.select().from(t.oauthClients).where(eq(t.oauthClients.id, id))),
    insertOAuthRequest: async (row) => {
      await db.insert(t.oauthRequests).values(row)
    },
    getOAuthRequest: async (id) =>
      one<OAuthRequestRow>(await db.select().from(t.oauthRequests).where(eq(t.oauthRequests.id, id))),
    findOAuthRequest: async (by, opts) => {
      const where =
        'consentHash' in by
          ? eq(t.oauthRequests.consentHash, by.consentHash)
          : eq(t.oauthRequests.codeHash, by.codeHash)
      const q = db.select().from(t.oauthRequests).where(where)
      return one<OAuthRequestRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateOAuthRequest: async (id, patch) => {
      await db.update(t.oauthRequests).set(patch).where(eq(t.oauthRequests.id, id))
    },
    insertOAuthGrant: async (row) => {
      await db.insert(t.oauthGrants).values(row)
    },
    getOAuthGrant: async (id) =>
      one<OAuthGrantRow>(await db.select().from(t.oauthGrants).where(eq(t.oauthGrants.id, id))),
    listOAuthGrants: async (userId, now) =>
      await db
        .select()
        .from(t.oauthGrants)
        .where(
          and(
            eq(t.oauthGrants.userId, userId),
            isNull(t.oauthGrants.revokedAt),
            sql`${t.oauthGrants.expiresAt} > ${now}`,
          ),
        )
        .orderBy(desc(t.oauthGrants.createdAt), desc(t.oauthGrants.id)),
    updateOAuthGrant: async (id, patch) => {
      await db.update(t.oauthGrants).set(patch).where(eq(t.oauthGrants.id, id))
    },
    revokeOAuthGrants: async (userId, at) => {
      await db
        .update(t.oauthGrants)
        .set({ revokedAt: at })
        .where(and(eq(t.oauthGrants.userId, userId), isNull(t.oauthGrants.revokedAt)))
    },
    insertOAuthToken: async (row) => {
      await db.insert(t.oauthTokens).values(row)
    },
    getOAuthToken: async (hash, opts) => {
      const q = db.select().from(t.oauthTokens).where(eq(t.oauthTokens.hash, hash))
      return one<OAuthTokenRow>(opts?.lock ? await q.for('update') : await q)
    },
    updateOAuthToken: async (hash, patch) => {
      await db.update(t.oauthTokens).set(patch).where(eq(t.oauthTokens.hash, hash))
    },
    deleteExpiredOAuth: async (now, clientsBefore) => {
      const count = (rows: unknown[]) => rows.length
      let n = count(
        await db
          .delete(t.oauthRequests)
          .where(lte(t.oauthRequests.expiresAt, now))
          .returning({ id: t.oauthRequests.id }),
      )
      n += count(
        await db
          .delete(t.oauthGrants)
          .where(or(sql`${t.oauthGrants.revokedAt} is not null`, lte(t.oauthGrants.expiresAt, now)))
          .returning({ id: t.oauthGrants.id }),
      )
      const liveGrant = db
        .select({ one: sql`1` })
        .from(t.oauthGrants)
        .where(eq(t.oauthGrants.id, t.oauthTokens.grantId))
      n += count(
        await db
          .delete(t.oauthTokens)
          .where(or(lte(t.oauthTokens.expiresAt, now), sql`not ${exists(liveGrant)}`))
          .returning({ hash: t.oauthTokens.hash }),
      )
      const grantUses = db
        .select({ one: sql`1` })
        .from(t.oauthGrants)
        .where(eq(t.oauthGrants.clientId, t.oauthClients.id))
      const requestUses = db
        .select({ one: sql`1` })
        .from(t.oauthRequests)
        .where(eq(t.oauthRequests.clientId, t.oauthClients.id))
      n += count(
        await db
          .delete(t.oauthClients)
          .where(
            and(
              lt(t.oauthClients.createdAt, clientsBefore),
              sql`not ${exists(grantUses)}`,
              sql`not ${exists(requestUses)}`,
            ),
          )
          .returning({ id: t.oauthClients.id }),
      )
      return n
    },

    getUserIdentity: async (provider, subject) =>
      one<UserIdentityRow>(
        await db
          .select()
          .from(t.userIdentities)
          .where(and(eq(t.userIdentities.provider, provider), eq(t.userIdentities.subject, subject))),
      ),
    insertUserIdentityIfAbsent: async (row) => {
      await db.insert(t.userIdentities).values(row).onConflictDoNothing()
      return one<UserIdentityRow>(
        await db
          .select()
          .from(t.userIdentities)
          .where(and(eq(t.userIdentities.provider, row.provider), eq(t.userIdentities.subject, row.subject))),
      ) as UserIdentityRow
    },
    updateUserIdentity: async (provider, subject, patch) => {
      await db
        .update(t.userIdentities)
        .set(patch)
        .where(and(eq(t.userIdentities.provider, provider), eq(t.userIdentities.subject, subject)))
    },
    listUserIdentities: async () => await db.select().from(t.userIdentities),
    insertSession: async (row) => {
      await db.insert(t.sessions).values(row)
    },
    getSession: async (id) =>
      one<SessionRow>(await db.select().from(t.sessions).where(eq(t.sessions.id, id))),
    updateSession: async (id, patch) => {
      await db.update(t.sessions).set(patch).where(eq(t.sessions.id, id))
    },
    revokeUserSessions: async (userId, at) => {
      await db
        .update(t.sessions)
        .set({ revokedAt: at })
        .where(and(eq(t.sessions.userId, userId), isNull(t.sessions.revokedAt)))
    },
    deleteExpiredSessions: async (now) =>
      (
        await db
          .delete(t.sessions)
          .where(or(sql`${t.sessions.revokedAt} is not null`, lte(t.sessions.expiresAt, now)))
          .returning({ id: t.sessions.id })
      ).length,
    mergeUser: async (from, into) => {
      // Rows keyed by the user id: drop the ones `into` already has a row for, then move the rest.
      await db.execute(sql`delete from idempotency_keys f where principal_id = ${from} and exists
        (select 1 from idempotency_keys i where i.principal_id = ${into} and i.operation = f.operation and i.key = f.key)`)
      await db.execute(sql`delete from comment_reads f where user_id = ${from} and exists
        (select 1 from comment_reads i where i.user_id = ${into} and i.job_id = f.job_id)`)
      await db.execute(sql`delete from verdicts f where user_id = ${from} and exists
        (select 1 from verdicts i where i.user_id = ${into} and i.job_id = f.job_id and i.version_n = f.version_n)`)
      await db.execute(sql`delete from notification_reads where user_id = ${from} and exists
        (select 1 from notification_reads i where i.user_id = ${into})`)
      await db.execute(sql`delete from user_webhooks where user_id = ${from} and exists
        (select 1 from user_webhooks i where i.user_id = ${into})`)
      const moves: [string, string][] = [
        ['api_keys', 'owner_id'],
        ['jobs', 'owner_id'],
        ['versions', 'author_id'],
        ['publications', 'published_by'],
        ['idempotency_keys', 'principal_id'],
        ['plans', 'user_id'],
        ['gateway_calls', 'caller_id'],
        ['comments', 'author_id'],
        ['comments', 'resolved_by'],
        ['media', 'uploader_id'],
        ['media_uploads', 'uploader_id'],
        ['edits', 'author_id'],
        ['version_comments', 'author_id'],
        ['comment_reads', 'user_id'],
        ['notifications', 'user_id'],
        ['notifications', 'actor_id'],
        ['notification_reads', 'user_id'],
        ['ownership_transfers', 'from_user_id'],
        ['ownership_transfers', 'to_user_id'],
        ['ownership_transfers', 'by_user_id'],
        ['verdicts', 'user_id'],
        ['user_webhooks', 'user_id'],
        ['oauth_requests', 'user_id'],
        ['oauth_grants', 'user_id'],
        ['sessions', 'user_id'],
        ['user_identities', 'user_id'],
      ]
      for (const [table, col] of moves)
        await db.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(col)} = ${into} where ${sql.identifier(col)} = ${from}`,
        )
      await db.execute(
        sql`update webhook_deliveries set dest_ref = ${into} where dest_kind = 'personal' and dest_ref = ${from}`,
      )
      await db.delete(t.users).where(eq(t.users.id, from))
    },

    usageSince: async (since) => {
      const rows = await db
        .select({
          authorId: t.versions.authorId,
          queuedAt: t.attempts.queuedAt,
          usage: t.attempts.usage,
          stage: t.attempts.stage,
        })
        .from(t.attempts)
        .innerJoin(
          t.versions,
          and(eq(t.versions.jobId, t.attempts.jobId), eq(t.versions.n, t.attempts.versionN)),
        )
        .where(gte(t.attempts.queuedAt, since))
      const out = new Map<string, UsageRow>()
      for (const r of rows) {
        const c = (r.usage as { totalCreditsCost?: number } | null)?.totalCreditsCost
        addUsage(out, r.authorId, r.queuedAt, r.stage as Stage, c)
      }
      return [...out.values()]
    },
    failuresSince: async (since) =>
      (
        await db
          .select({ category: t.attempts.errorCategory, count: sql<number>`count(*)::int` })
          .from(t.attempts)
          .where(and(gte(t.attempts.endedAt, since), sql`${t.attempts.errorCategory} is not null`))
          .groupBy(t.attempts.errorCategory)
      ).map((r) => ({ category: r.category ?? 'unknown', count: r.count })),
  }
}

export function createDrizzleStore(db: Db): Store {
  const base = repoFor(db)
  return {
    ...base,
    tx: (fn) => db.transaction((tx) => fn(repoFor(tx as unknown as Db))),
  }
}
