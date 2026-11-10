// Postgres store on Netlify Database through Drizzle. Tests run it against PGlite.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
  exists,
  type Column,
  type SQL,
} from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core/async/db'
import * as t from './schema.js'
import { SLOT_STAGES, TERMINAL_STAGES } from '../domain/types.js'
import type {
  ApiKeyRow,
  AttemptRow,
  CleanupRow,
  CliLoginRow,
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
  OpenverseJobRow,
  OpenverseSearchRow,
  VersionMediaRow,
  MediaRefRow,
  NarrationLockRow,
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
  DestinationRow,
  DestinationConnectionRow,
  DestinationPublicationRow,
} from '../domain/types.js'
import { addUsage, byVersion, withoutJob, type UsageRow } from './memory.js'
import type { Repo, Store } from './types.js'
import { searchWords } from '../lib/search.js'
import { ApiError } from '../lib/errors.js'
import { TAKE_ROLES } from '../domain/media-roles.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver-agnostic (netlify-db, pglite)
type Db = PgAsyncDatabase<any, any, any>

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the row type
const one = <T>(rows: unknown[]): T | null => (rows[0] as T | undefined) ?? null
/** A select, as `select … for update` when the caller locks the row. */
const lockIf = <R>(
  q: PromiseLike<R> & { for(strength: 'update'): PromiseLike<R> },
  opts?: { lock?: boolean },
) => (opts?.lock ? q.for('update') : q)
/** Keyset paging: rows after cursor `c`, newest first. */
const olderThan = (table: { createdAt: Column; id: Column }, c: { createdAt: string; id: string }) =>
  or(lt(table.createdAt, c.createdAt), and(eq(table.createdAt, c.createdAt), lt(table.id, c.id)))
const nonDue = [...TERMINAL_STAGES, 'queued', 'unresolved']
/** A version's credited media: the version_media row and the media item's source and licence. */
const MEDIA_PROVENANCE = {
  source: t.media.source,
  sourceId: t.media.sourceId,
  sourceUrl: t.media.sourceUrl,
  sourceTitle: t.media.sourceTitle,
  license: t.media.license,
  licenseVersion: t.media.licenseVersion,
  licenseUrl: t.media.licenseUrl,
  creator: t.media.creator,
  creatorUrl: t.media.creatorUrl,
  attribution: t.media.attribution,
}
const PROVENANCE_COLUMNS = {
  versionN: t.versionMedia.versionN,
  mediaId: t.versionMedia.mediaId,
  position: t.versionMedia.position,
  kind: t.versionMedia.kind,
  ...MEDIA_PROVENANCE,
}
/**
 * Library items versions' recorded narration plays (media_refs `version` references, owner `<job>#<n>`), with their
 * provenance: credits and usage union these with version_media (plan 2026-11-02 §6.1). Recordings are the user's
 * own (a take role, no source) and are left out.
 */
async function narrationProvenance(db: Db, jobIds: string[]) {
  if (!jobIds.length) return []
  const r = t.mediaRefs
  const m = t.media
  const rows = await db
    .select({ jobId: r.jobId, ownerId: r.ownerId, mediaId: m.id, kind: m.kind, ...MEDIA_PROVENANCE })
    .from(r)
    .innerJoin(m, eq(m.id, r.mediaId))
    .where(and(inArray(r.jobId, jobIds), eq(r.ownerKind, 'version'), notTakeCol(m.role), isNotNull(m.source)))
    .orderBy(asc(r.ownerId), asc(r.mediaId))
  return rows.map(({ ownerId, ...row }) => ({
    ...row,
    versionN: Number(ownerId.slice(ownerId.lastIndexOf('#') + 1)),
    position: 0,
    narration: true,
  })) as (VersionProvenanceRow & { jobId: string })[]
}

/** A narration take (recorded or uploaded voice-over); other roles are library items like any other. */
const isTakeCol = (role: typeof t.media.role | typeof t.mediaUploads.role) => inArray(role, [...TAKE_ROLES])
const notTakeCol = (role: typeof t.media.role) => or(isNull(role), notInArray(role, [...TAKE_ROLES]))

/** Library queries leave narration takes out, except `takesOf`'s own that GC isn't deleting. */
const takeVisible = (takesOf: string | undefined) =>
  takesOf
    ? or(notTakeCol(t.media.role), and(eq(t.media.uploaderId, takesOf), isNull(t.media.deletingAt)))
    : notTakeCol(t.media.role)

function repoFor(db: Db): Repo {
  /** `select 1 from table where …`, for exists() and notExists(). */
  const anyRow = (table: PgTable, where: SQL | undefined) =>
    db
      .select({ one: sql`1` })
      .from(table)
      .where(where)
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
    getJob: async (id, opts) =>
      one<JobRow>(await lockIf(db.select().from(t.jobs).where(eq(t.jobs.id, id)), opts)),
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
      if (q.externalRef !== undefined) conds.push(eq(t.jobs.externalRef, q.externalRef))
      // && is overlap: the video carries at least one of them (the GIN index on tags serves it).
      const tagArray = (tags: string[]) =>
        sql`array[${sql.join(
          tags.map((x) => sql`${x}`),
          sql`, `,
        )}]::text[]`
      if (q.tags?.length) conds.push(sql`${t.jobs.tags} && ${tagArray(q.tags)}`)
      if (q.withoutTags?.length) conds.push(sql`not (${t.jobs.tags} && ${tagArray(q.withoutTags)})`)
      const livePub = anyRow(
        t.publications,
        and(eq(t.publications.jobId, t.jobs.id), isNull(t.publications.unpublishedAt)),
      )
      const liveDest = anyRow(
        t.destinationPublications,
        and(eq(t.destinationPublications.jobId, t.jobs.id), eq(t.destinationPublications.status, 'live')),
      )
      if (q.published === true) conds.push(or(exists(livePub), exists(liveDest)) as SQL)
      if (q.published === false) conds.push(sql`not ${exists(livePub)} and not ${exists(liveDest)}`)
      if (q.favoriteOf) {
        const starred = and(eq(t.favorites.jobId, t.jobs.id), eq(t.favorites.userId, q.favoriteOf))
        conds.push(exists(anyRow(t.favorites, starred)))
      }
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
        const promptMatch = anyRow(
          t.versions,
          and(eq(t.versions.jobId, t.jobs.id), ilike(t.versions.prompt, like)),
        )
        const titleOrPrompt = or(ilike(t.jobs.title, like), exists(promptMatch))
        if (titleOrPrompt) conds.push(titleOrPrompt)
      }
      if (q.cursor) {
        const before = olderThan(t.jobs, q.cursor)
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
    getAttempt: async (id, opts) =>
      one<AttemptRow>(await lockIf(db.select().from(t.attempts).where(eq(t.attempts.id, id)), opts)),
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
    replaceReceipt: async (row) => {
      await db
        .update(t.callbackReceipts)
        .set({ manifest: row.manifest, manifestHash: row.manifestHash, receivedAt: row.receivedAt })
        .where(eq(t.callbackReceipts.attemptId, row.attemptId))
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
    getPlan: async (id, opts) =>
      one<PlanRow>(await lockIf(db.select().from(t.plans).where(eq(t.plans.id, id)), opts)),
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
        const older = olderThan(n, q.before)
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
    lockMedia: async (ids) => {
      if (ids.length === 0) return []
      // Rows are locked in the order they're returned, so every locker takes them in the same order.
      return (await db
        .select()
        .from(t.media)
        .where(inArray(t.media.id, ids))
        .orderBy(asc(t.media.id))
        .for('update')) as MediaRow[]
    },
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
            takeVisible(q.takesOf),
            q.recordings === 'only'
              ? isTakeCol(m.role)
              : q.recordings === 'exclude'
                ? notTakeCol(m.role)
                : undefined,
            q.kind ? eq(m.kind, q.kind) : undefined,
            ...searchWords(q.search).map((w) => {
              const like = `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
              return or(
                ilike(m.title, like),
                ilike(m.filename, like),
                ilike(m.caption, like),
                ilike(m.sourceTitle, like),
                ilike(m.creator, like),
              )
            }),
            q.before && (q.sort ?? 'newest') === 'newest' ? olderThan(m, q.before) : undefined,
          ),
        )
        .orderBy(
          ...(q.sort === 'oldest'
            ? [asc(m.createdAt), asc(m.id)]
            : q.sort === 'name'
              ? [sql`lower(coalesce(${m.title}, ${m.filename}))`, asc(m.id)]
              : [desc(m.createdAt), desc(m.id)]),
        )
        .limit(q.limit)) as MediaRow[]
    },
    findMediaMatches: async (q) => {
      const m = t.media
      if (!q.sha256s.length && !q.filenames.length) return []
      return (await db
        .select()
        .from(m)
        .where(
          and(
            isNull(m.deletedAt),
            or(eq(m.status, 'ready'), eq(m.uploaderId, q.includePendingOf)),
            takeVisible(q.takesOf),
            or(
              q.sha256s.length ? inArray(m.originalSha256, q.sha256s) : undefined,
              q.filenames.length ? inArray(m.filename, q.filenames) : undefined,
            ),
          ),
        )
        .orderBy(desc(m.createdAt))
        .limit(100)) as MediaRow[]
    },
    insertUpload: async (row) => {
      await db.insert(t.mediaUploads).values(row)
    },
    getUpload: async (id, opts) =>
      one<MediaUploadRow>(
        await lockIf(db.select().from(t.mediaUploads).where(eq(t.mediaUploads.id, id)), opts),
      ),
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
    countOpenUploads: async (uploaderId) => {
      const u = t.mediaUploads
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(u)
        .where(and(eq(u.uploaderId, uploaderId), inArray(u.status, ['open', 'assembling'])))
      return rows[0]?.n ?? 0
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
    insertOpenverseJobIfAbsent: async (row) => {
      // A clash with the in-flight index means an identical job is queued or running: return that one.
      const j = t.openverseJobs
      const inserted = await db.insert(j).values(row).onConflictDoNothing().returning()
      if (inserted[0]) return inserted[0] as OpenverseJobRow
      return one<OpenverseJobRow>(
        await db
          .select()
          .from(j)
          .where(
            and(
              eq(j.userId, row.userId),
              eq(j.kind, row.kind),
              eq(j.key, row.key),
              inArray(j.status, ['queued', 'running']),
            ),
          ),
      ) as OpenverseJobRow
    },
    getOpenverseJob: async (id) =>
      one<OpenverseJobRow>(await db.select().from(t.openverseJobs).where(eq(t.openverseJobs.id, id))),
    findOpenverseJob: async (q) => {
      const j = t.openverseJobs
      return one<OpenverseJobRow>(
        await db
          .select()
          .from(j)
          .where(
            and(
              eq(j.kind, q.kind),
              eq(j.key, q.key),
              inArray(j.status, q.statuses),
              gte(j.updatedAt, q.since),
              q.userId ? eq(j.userId, q.userId) : undefined,
            ),
          )
          .orderBy(desc(j.updatedAt))
          .limit(1),
      )
    },
    countOpenverseJobs: async (userId, since) => {
      const j = t.openverseJobs
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(j)
        .where(and(eq(j.userId, userId), gte(j.createdAt, since)))
      return rows[0]?.n ?? 0
    },
    claimOpenverseJob: async (id, now) => {
      const j = t.openverseJobs
      const rows = await db
        .update(j)
        .set({ status: 'running', updatedAt: now })
        .where(and(eq(j.id, id), eq(j.status, 'queued')))
        .returning({ id: j.id })
      return rows.length > 0
    },
    updateOpenverseJob: async (id, patch) => {
      await db.update(t.openverseJobs).set(patch).where(eq(t.openverseJobs.id, id))
    },
    listStaleOpenverseJobs: async (q) => {
      const j = t.openverseJobs
      return (await db
        .select()
        .from(j)
        .where(
          or(
            and(eq(j.status, 'queued'), lt(j.updatedAt, q.queuedBefore)),
            and(eq(j.status, 'running'), lt(j.updatedAt, q.runningBefore)),
          ),
        )
        .limit(q.limit)) as OpenverseJobRow[]
    },
    deleteExpiredOpenverseJobs: async (now) =>
      (
        await db
          .delete(t.openverseJobs)
          .where(lte(t.openverseJobs.expiresAt, now))
          .returning({ id: t.openverseJobs.id })
      ).length,
    getOpenverseSearch: async (key) =>
      one<OpenverseSearchRow>(
        await db.select().from(t.openverseSearches).where(eq(t.openverseSearches.key, key)),
      ),
    putOpenverseSearch: async (row) => {
      await db
        .insert(t.openverseSearches)
        .values(row)
        .onConflictDoUpdate({
          target: t.openverseSearches.key,
          set: { result: row.result, fetchedAt: row.fetchedAt },
        })
    },
    deleteOldOpenverseSearches: async (q) => {
      const s = t.openverseSearches
      const old = await db.delete(s).where(lt(s.fetchedAt, q.fetchedBefore)).returning({ key: s.key })
      // Over the cap: keep the most recently fetched.
      const over = await db
        .select({ key: s.key })
        .from(s)
        .orderBy(desc(s.fetchedAt), asc(s.key))
        .offset(q.keep)
        .limit(1000)
      if (over.length)
        await db.delete(s).where(
          inArray(
            s.key,
            over.map((r) => r.key),
          ),
        )
      return old.length + over.length
    },
    addOpenverseSearchUse: async (key, day) => {
      const u = t.openverseSearchUses
      await db
        .insert(u)
        .values({ key, day, count: 1 })
        .onConflictDoUpdate({ target: [u.key, u.day], set: { count: sql`${u.count} + 1` } })
    },
    topOpenverseSearches: async (sinceDay, limit) => {
      const u = t.openverseSearchUses
      const total = sql<number>`sum(${u.count})::int`
      return await db
        .select({ key: u.key, count: total })
        .from(u)
        .where(gte(u.day, sinceDay))
        .groupBy(u.key)
        .orderBy(desc(total), asc(u.key))
        .limit(limit)
    },
    deleteOpenverseSearchUses: async (beforeDay) =>
      (
        await db
          .delete(t.openverseSearchUses)
          .where(lt(t.openverseSearchUses.day, beforeDay))
          .returning({ key: t.openverseSearchUses.key })
      ).length,
    insertVersionMedia: async (rows) => {
      if (rows.length) await db.insert(t.versionMedia).values(rows)
    },
    listVersionMedia: async (jobId, n) =>
      (await db
        .select()
        .from(t.versionMedia)
        .where(and(eq(t.versionMedia.jobId, jobId), eq(t.versionMedia.versionN, n)))
        .orderBy(asc(t.versionMedia.position))) as VersionMediaRow[],
    insertMediaRefs: async (rows) => {
      if (rows.length) await db.insert(t.mediaRefs).values(rows).onConflictDoNothing()
    },
    deleteMediaRefs: async (ownerKind, ownerId, mediaIds) => {
      const r = t.mediaRefs
      if (mediaIds?.length === 0) return 0
      return (
        await db
          .delete(r)
          .where(
            and(
              eq(r.ownerKind, ownerKind),
              eq(r.ownerId, ownerId),
              mediaIds ? inArray(r.mediaId, mediaIds) : undefined,
            ),
          )
          .returning({ mediaId: r.mediaId })
      ).length
    },
    listMediaRefsByMedia: async (ids) => {
      if (ids.length === 0) return []
      const r = t.mediaRefs
      return (await db
        .select()
        .from(r)
        .where(inArray(r.mediaId, ids))
        .orderBy(asc(r.createdAt), asc(r.mediaId), asc(r.ownerKind), asc(r.ownerId))) as MediaRefRow[]
    },
    listMediaRefsByOwner: async (ownerKind, ownerId) => {
      const r = t.mediaRefs
      return (await db
        .select()
        .from(r)
        .where(and(eq(r.ownerKind, ownerKind), eq(r.ownerId, ownerId)))
        .orderBy(asc(r.createdAt), asc(r.mediaId))) as MediaRefRow[]
    },
    listVideoTakes: async (jobId, limit) => {
      const m = t.media
      const r = t.mediaRefs
      return (await db
        .select()
        .from(m)
        .where(
          and(
            isTakeCol(m.role),
            isNull(m.deletedAt),
            isNull(m.deletingAt),
            or(eq(m.scopeJobId, jobId), exists(anyRow(r, and(eq(r.mediaId, m.id), eq(r.jobId, jobId))))),
          ),
        )
        .orderBy(desc(m.createdAt), desc(m.id))
        .limit(limit)) as MediaRow[]
    },
    listUnreferencedTakes: async (q) => {
      const m = t.media
      return (await db
        .select()
        .from(m)
        .where(
          and(
            isTakeCol(m.role),
            isNull(m.deletingAt),
            notExists(anyRow(t.mediaRefs, eq(t.mediaRefs.mediaId, m.id))),
            q.uploaderId ? eq(m.uploaderId, q.uploaderId) : undefined,
            q.due
              ? or(
                  lte(m.retainUntil, q.due.now),
                  and(isNull(m.retainUntil), lte(m.createdAt, q.due.createdBefore)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(m.createdAt), asc(m.id))
        .limit(q.limit)) as MediaRow[]
    },
    getNarrationLock: async (jobId, opts) =>
      one<NarrationLockRow>(
        await lockIf(db.select().from(t.narrationLocks).where(eq(t.narrationLocks.jobId, jobId)), opts),
      ),
    acquireNarrationLock: async (row, staleBefore) => {
      const l = t.narrationLocks
      const rows = await db
        .insert(l)
        .values(row)
        .onConflictDoUpdate({
          target: l.jobId,
          set: {
            holderId: row.holderId,
            draftId: row.draftId,
            // A heartbeat keeps when the holder took it; a new holder's starts now.
            acquiredAt: sql`case when ${l.holderId} = ${row.holderId} then ${l.acquiredAt} else excluded.acquired_at end`,
            heartbeatAt: row.heartbeatAt,
          },
          setWhere: sql`${l.heartbeatAt} < ${staleBefore} or ${l.holderId} = ${row.holderId}`,
        })
        .returning({ jobId: l.jobId })
      return rows.length > 0
    },
    releaseNarrationLock: async (jobId, holderId) => {
      const l = t.narrationLocks
      return (
        (
          await db
            .delete(l)
            .where(and(eq(l.jobId, jobId), eq(l.holderId, holderId)))
            .returning({ jobId: l.jobId })
        ).length > 0
      )
    },
    upsertNarrationLock: async (row) => {
      await db
        .insert(t.narrationLocks)
        .values(row)
        .onConflictDoUpdate({
          target: t.narrationLocks.jobId,
          set: {
            holderId: row.holderId,
            draftId: row.draftId,
            acquiredAt: row.acquiredAt,
            heartbeatAt: row.heartbeatAt,
          },
        })
    },
    deleteNarrationLock: async (jobId) => {
      await db.delete(t.narrationLocks).where(eq(t.narrationLocks.jobId, jobId))
    },
    deleteStaleNarrationLocks: async (before) =>
      (
        await db
          .delete(t.narrationLocks)
          .where(lt(t.narrationLocks.heartbeatAt, before))
          .returning({ jobId: t.narrationLocks.jobId })
      ).length,
    mediaUsage: async (ids) => {
      if (ids.length === 0) return {}
      const r = t.mediaRefs
      const rows = await db
        .selectDistinct({ mediaId: t.versionMedia.mediaId, jobId: t.versionMedia.jobId })
        .from(t.versionMedia)
        .where(inArray(t.versionMedia.mediaId, ids))
        .union(
          db
            .selectDistinct({ mediaId: r.mediaId, jobId: r.jobId })
            .from(r)
            .where(and(inArray(r.mediaId, ids), eq(r.ownerKind, 'version'))),
        )
      const out: Record<string, string[]> = {}
      for (const r of rows) (out[r.mediaId] ??= []).push(r.jobId)
      return out
    },
    listUnusedRecordings: async (q) => {
      const m = t.media
      const vm = t.versionMedia
      const live = and(
        eq(vm.mediaId, m.id),
        notExists(anyRow(t.jobs, and(eq(t.jobs.id, vm.jobId), isNotNull(t.jobs.deletedAt)))),
      )
      const rows = (await db
        .select()
        .from(m)
        .where(
          and(
            eq(m.role, 'screen-recording'),
            isNull(m.deletedAt),
            isNull(m.deletingAt),
            q.uploaderId ? eq(m.uploaderId, q.uploaderId) : undefined,
            notExists(anyRow(vm, live)),
          ),
        )
        .orderBy(asc(m.createdAt), asc(m.id))
        .limit(q.limit)) as MediaRow[]
      if (!rows.length) return []
      const used = new Set(
        (
          await db
            .selectDistinct({ mediaId: vm.mediaId })
            .from(vm)
            .where(
              inArray(
                vm.mediaId,
                rows.map((r) => r.id),
              ),
            )
        ).map((r) => r.mediaId),
      )
      return rows.map((row) => ({ row, everUsed: used.has(row.id) }))
    },
    screenRecordingBytes: async (uploaderId) => {
      const m = t.media
      const rows = await db
        .select({ total: sql<string | number>`coalesce(sum(${m.bytes}), 0)::bigint` })
        .from(m)
        .where(
          and(
            eq(m.uploaderId, uploaderId),
            eq(m.role, 'screen-recording'),
            sql`${m.status} <> 'rejected'`,
            isNull(m.deletingAt),
            isNull(m.deletedAt),
          ),
        )
      const u = t.mediaUploads
      const open = await db
        .select({ total: sql<string | number>`coalesce(sum(${u.size}), 0)::bigint` })
        .from(u)
        .where(and(eq(u.uploaderId, uploaderId), eq(u.status, 'open'), eq(u.role, 'screen-recording')))
      return Number(rows[0]?.total ?? 0) + Number(open[0]?.total ?? 0)
    },
    recentTraceWrites: async (uploaderId, since) => {
      const rows = await db
        .select({ writes: t.media.traceWrites })
        .from(t.media)
        .where(and(eq(t.media.uploaderId, uploaderId), isNotNull(t.media.traceWrites)))
      return rows
        .flatMap((r) => (r.writes as string[] | null) ?? [])
        .filter((w) => w >= since)
        .sort()
    },
    jobsUsingMedia: async (mediaId) => {
      const vm = t.versionMedia
      return db
        .select({ jobId: vm.jobId, versionN: vm.versionN })
        .from(vm)
        .innerJoin(t.jobs, eq(t.jobs.id, vm.jobId))
        .where(and(eq(vm.mediaId, mediaId), isNull(t.jobs.deletedAt)))
        .orderBy(asc(vm.jobId), asc(vm.versionN))
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
      const [media, narration] = await Promise.all([
        db
          .select(PROVENANCE_COLUMNS)
          .from(v)
          .innerJoin(m, eq(m.id, v.mediaId))
          .where(and(eq(v.jobId, jobId), isNotNull(m.source)))
          .orderBy(asc(v.versionN), asc(v.position)) as Promise<VersionProvenanceRow[]>,
        narrationProvenance(db, [jobId]),
      ])
      return byVersion([...media, ...narration.map(withoutJob)])
    },
    videoPage: async (jobIds) => {
      if (jobIds.length === 0)
        return {
          jobs: [],
          versions: [],
          attempts: [],
          publications: [],
          outputs: [],
          versionComments: [],
          provenance: [],
          owners: [],
          destinationPublications: [],
        }
      const v = t.versionMedia
      const m = t.media
      const [jobs, versions, attempts, publications, outputs, versionComments, provenance, narration, dpubs] =
        await Promise.all([
          db.select().from(t.jobs).where(inArray(t.jobs.id, jobIds)),
          db.select().from(t.versions).where(inArray(t.versions.jobId, jobIds)).orderBy(desc(t.versions.n)),
          db
            .select()
            .from(t.attempts)
            .where(inArray(t.attempts.jobId, jobIds))
            .orderBy(desc(t.attempts.queuedAt)),
          db
            .select()
            .from(t.publications)
            .where(inArray(t.publications.jobId, jobIds))
            .orderBy(desc(t.publications.publishedAt)),
          db.select().from(t.outputs).where(inArray(t.outputs.jobId, jobIds)),
          db
            .select()
            .from(t.versionComments)
            .where(inArray(t.versionComments.jobId, jobIds))
            .orderBy(asc(t.versionComments.versionN), asc(t.versionComments.position)),
          db
            .select({ jobId: v.jobId, ...PROVENANCE_COLUMNS })
            .from(v)
            .innerJoin(m, eq(m.id, v.mediaId))
            .where(and(inArray(v.jobId, jobIds), isNotNull(m.source)))
            .orderBy(asc(v.versionN), asc(v.position)),
          narrationProvenance(db, jobIds),
          db
            .select()
            .from(t.destinationPublications)
            .where(inArray(t.destinationPublications.jobId, jobIds))
            .orderBy(asc(t.destinationPublications.createdAt), asc(t.destinationPublications.id)),
        ])
      const ownerIds = [...new Set(jobs.map((j) => j.ownerId))]
      const owners = ownerIds.length
        ? await db.select().from(t.users).where(inArray(t.users.id, ownerIds))
        : []
      return {
        jobs: jobs as JobRow[],
        versions: versions as VersionRow[],
        attempts: attempts as AttemptRow[],
        publications,
        outputs: outputs as OutputRow[],
        versionComments,
        provenance: byVersion([
          ...(provenance as (VersionProvenanceRow & { jobId: string })[]),
          ...narration,
        ]),
        owners: owners as UserRow[],
        destinationPublications: dpubs as DestinationPublicationRow[],
      }
    },
    insertEdit: async (row) => {
      await db.insert(t.edits).values(row)
    },
    getEdit: async (id, opts) =>
      one<EditRow>(await lockIf(db.select().from(t.edits).where(eq(t.edits.id, id)), opts)),
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
    getCheckpoint: async (attemptId, opts) =>
      one<CheckpointRow>(
        await lockIf(db.select().from(t.checkpoints).where(eq(t.checkpoints.attemptId, attemptId)), opts),
      ),
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
    setFavorite: async (userId, jobId, on, at) => {
      if (on) await db.insert(t.favorites).values({ userId, jobId, createdAt: at }).onConflictDoNothing()
      else
        await db.delete(t.favorites).where(and(eq(t.favorites.userId, userId), eq(t.favorites.jobId, jobId)))
    },
    tagCounts: async (vis) => {
      // Tagged videos are few, so their tag lists are read and counted here rather than unnested in SQL.
      const conds = [isNull(t.jobs.deletedAt), sql`cardinality(${t.jobs.tags}) > 0`]
      if (!vis.all) {
        const visible = or(eq(t.jobs.private, false), eq(t.jobs.ownerId, vis.userId))
        if (visible) conds.push(visible)
      }
      const rows = await db
        .select({ tags: t.jobs.tags })
        .from(t.jobs)
        .where(and(...conds))
      const counts = new Map<string, number>()
      for (const r of rows) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      return [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((x, y) => y.count - x.count || (x.tag < y.tag ? -1 : 1))
    },
    favoriteJobIds: async (userId, jobIds) => {
      if (jobIds.length === 0) return []
      const rows = await db
        .select({ jobId: t.favorites.jobId })
        .from(t.favorites)
        .where(and(eq(t.favorites.userId, userId), inArray(t.favorites.jobId, jobIds)))
      return rows.map((r) => r.jobId)
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
    listDestinations: async () =>
      (await db.select().from(t.destinations).orderBy(asc(t.destinations.createdAt))) as DestinationRow[],
    getDestination: async (id) =>
      one<DestinationRow>(await db.select().from(t.destinations).where(eq(t.destinations.id, id))),
    insertDestination: async (row) => {
      await db.insert(t.destinations).values(row)
    },
    updateDestination: async (id, patch) => {
      await db.update(t.destinations).set(patch).where(eq(t.destinations.id, id))
    },
    deleteDestination: async (id) => {
      await db.delete(t.destinations).where(eq(t.destinations.id, id))
    },
    getDestinationConnection: async (id) =>
      one<DestinationConnectionRow>(
        await db.select().from(t.destinationConnections).where(eq(t.destinationConnections.id, id)),
      ),
    getUserConnection: async (userId, kind) =>
      one<DestinationConnectionRow>(
        await db
          .select()
          .from(t.destinationConnections)
          .where(and(eq(t.destinationConnections.userId, userId), eq(t.destinationConnections.kind, kind))),
      ),
    listUserConnections: async (userId) =>
      (await db
        .select()
        .from(t.destinationConnections)
        .where(eq(t.destinationConnections.userId, userId))) as DestinationConnectionRow[],
    putDestinationConnection: async (row) => {
      await db
        .delete(t.destinationConnections)
        .where(
          and(eq(t.destinationConnections.userId, row.userId), eq(t.destinationConnections.kind, row.kind)),
        )
      await db.insert(t.destinationConnections).values(row)
    },
    updateDestinationConnection: async (id, patch) => {
      await db.update(t.destinationConnections).set(patch).where(eq(t.destinationConnections.id, id))
    },
    deleteDestinationConnection: async (id) => {
      await db.delete(t.destinationConnections).where(eq(t.destinationConnections.id, id))
    },
    insertDestinationPublication: async (row) => {
      const done = await db
        .insert(t.destinationPublications)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: t.destinationPublications.id })
      if (!done.length) throw new ApiError('conflict', 'This version is already published there.')
    },
    getDestinationPublication: async (id, opts) =>
      one<DestinationPublicationRow>(
        await lockIf(
          db.select().from(t.destinationPublications).where(eq(t.destinationPublications.id, id)),
          opts,
        ),
      ),
    listDestinationPublications: async (jobId) =>
      (await db
        .select()
        .from(t.destinationPublications)
        .where(eq(t.destinationPublications.jobId, jobId))
        .orderBy(
          asc(t.destinationPublications.createdAt),
          asc(t.destinationPublications.id),
        )) as DestinationPublicationRow[],
    listDestinationPublicationsFor: async (destinationId) =>
      (await db
        .select()
        .from(t.destinationPublications)
        .where(eq(t.destinationPublications.destinationId, destinationId))) as DestinationPublicationRow[],
    findActiveDestinationPublication: async (k) => {
      const d = t.destinationPublications
      return one<DestinationPublicationRow>(
        await db
          .select()
          .from(d)
          .where(
            and(
              eq(d.desired, 'published'),
              eq(d.jobId, k.jobId),
              eq(d.versionN, k.versionN),
              eq(d.kind, k.kind),
              sql`coalesce(${d.destinationId}, '') = ${k.destinationId ?? ''}`,
              eq(d.targetKey, k.targetKey),
            ),
          ),
      )
    },
    updateDestinationPublication: async (id, patch) => {
      await db.update(t.destinationPublications).set(patch).where(eq(t.destinationPublications.id, id))
    },
    claimDestinationPublication: async (id, now, leaseUntil) => {
      const d = t.destinationPublications
      return one<DestinationPublicationRow>(
        await db
          .update(d)
          .set({ leaseUntil, leaseFence: sql`${d.leaseFence} + 1` })
          .where(and(eq(d.id, id), or(isNull(d.leaseUntil), lte(d.leaseUntil, now))))
          .returning(),
      )
    },
    commitDestinationPublication: async (id, f, patch) => {
      const d = t.destinationPublications
      const done = await db
        .update(d)
        .set(patch)
        .where(
          and(
            eq(d.id, id),
            eq(d.leaseFence, f.fence),
            eq(d.generation, f.generation),
            eq(d.desired, f.desired),
          ),
        )
        .returning({ id: d.id })
      return done.length > 0
    },
    listDueDestinationPublications: async (now, limit) => {
      const d = t.destinationPublications
      return (await db
        .select()
        .from(d)
        .where(
          and(
            inArray(d.status, ['queued', 'running', 'waiting', 'removing']),
            or(isNull(d.leaseUntil), lte(d.leaseUntil, now)),
            or(and(isNotNull(d.nextRunAt), lte(d.nextRunAt, now)), lte(d.deadlineAt, now)),
          ),
        )
        .orderBy(asc(d.nextRunAt))
        .limit(limit)) as DestinationPublicationRow[]
    },
    listExpiredSecrets: async (now, limit) => {
      const d = t.destinationPublications
      return (await db
        .select()
        .from(d)
        .where(
          and(isNotNull(d.secretOnceEnc), isNotNull(d.secretOnceExpiresAt), lte(d.secretOnceExpiresAt, now)),
        )
        .limit(limit)) as DestinationPublicationRow[]
    },
    consumeSecretOnce: async (id, userId, now) => {
      const d = t.destinationPublications
      // Marking it consumed is the atomic step (one winner); the ciphertext is cleared right after.
      const won = await db
        .update(d)
        .set({ secretOnceConsumedAt: now })
        .where(
          and(
            eq(d.id, id),
            eq(d.publishedBy, userId),
            isNotNull(d.secretOnceEnc),
            isNull(d.secretOnceConsumedAt),
            sql`${d.secretOnceExpiresAt} > ${now}`,
          ),
        )
        .returning({ enc: d.secretOnceEnc, label: d.secretOnceLabel })
      const w = won[0]
      if (!w?.enc) return null
      await db.update(d).set({ secretOnceEnc: null }).where(eq(d.id, id))
      return { label: w.label ?? 'Secret', valueEnc: w.enc }
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

    insertCliLogin: async (row) => {
      await db.insert(t.cliLogins).values(row)
    },
    getCliLogin: async (id, opts) =>
      one<CliLoginRow>(await lockIf(db.select().from(t.cliLogins).where(eq(t.cliLogins.id, id)), opts)),
    findPendingCliLogin: async (userCode, now) =>
      one<CliLoginRow>(
        await db
          .select()
          .from(t.cliLogins)
          .where(
            and(
              eq(t.cliLogins.userCode, userCode),
              eq(t.cliLogins.status, 'pending'),
              gt(t.cliLogins.expiresAt, now),
            ),
          ),
      ),
    updateCliLogin: async (id, patch) => {
      await db.update(t.cliLogins).set(patch).where(eq(t.cliLogins.id, id))
    },
    countPendingCliLogins: async (now, clientIp) => {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.cliLogins)
        .where(
          and(
            eq(t.cliLogins.status, 'pending'),
            gt(t.cliLogins.expiresAt, now),
            clientIp === undefined ? undefined : eq(t.cliLogins.clientIp, clientIp),
          ),
        )
      return r?.n ?? 0
    },
    countCliLoginApprovals: async (userId, since) => {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.cliLogins)
        .where(and(eq(t.cliLogins.userId, userId), gte(t.cliLogins.approvedAt, since)))
      return r?.n ?? 0
    },
    insertCliLoginFailure: async (row) => {
      await db.insert(t.cliLoginFailures).values(row)
    },
    countCliLoginFailures: async (userId, since) => {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.cliLoginFailures)
        .where(and(eq(t.cliLoginFailures.userId, userId), gte(t.cliLoginFailures.createdAt, since)))
      return r?.n ?? 0
    },
    sweepCliLogins: async (now, deleteBefore, failuresBefore) => {
      const marked = await db
        .update(t.cliLogins)
        .set({ status: 'expired' })
        .where(and(eq(t.cliLogins.status, 'pending'), lte(t.cliLogins.expiresAt, now)))
        .returning({ id: t.cliLogins.id })
      const gone = await db
        .delete(t.cliLogins)
        .where(lt(t.cliLogins.expiresAt, deleteBefore))
        .returning({ id: t.cliLogins.id })
      const failures = await db
        .delete(t.cliLoginFailures)
        .where(lt(t.cliLoginFailures.createdAt, failuresBefore))
        .returning({ id: t.cliLoginFailures.id })
      return marked.length + gone.length + failures.length
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
      return one<OAuthRequestRow>(await lockIf(db.select().from(t.oauthRequests).where(where), opts))
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
    getOAuthToken: async (hash, opts) =>
      one<OAuthTokenRow>(
        await lockIf(db.select().from(t.oauthTokens).where(eq(t.oauthTokens.hash, hash)), opts),
      ),
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
      const liveGrant = anyRow(t.oauthGrants, eq(t.oauthGrants.id, t.oauthTokens.grantId))
      n += count(
        await db
          .delete(t.oauthTokens)
          .where(or(lte(t.oauthTokens.expiresAt, now), sql`not ${exists(liveGrant)}`))
          .returning({ hash: t.oauthTokens.hash }),
      )
      const grantUses = anyRow(t.oauthGrants, eq(t.oauthGrants.clientId, t.oauthClients.id))
      const requestUses = anyRow(t.oauthRequests, eq(t.oauthRequests.clientId, t.oauthClients.id))
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
      await db.execute(sql`delete from favorites f where user_id = ${from} and exists
        (select 1 from favorites i where i.user_id = ${into} and i.job_id = f.job_id)`)
      await db.execute(sql`delete from verdicts f where user_id = ${from} and exists
        (select 1 from verdicts i where i.user_id = ${into} and i.job_id = f.job_id and i.version_n = f.version_n)`)
      await db.execute(sql`delete from notification_reads where user_id = ${from} and exists
        (select 1 from notification_reads i where i.user_id = ${into})`)
      await db.execute(sql`delete from user_webhooks where user_id = ${from} and exists
        (select 1 from user_webhooks i where i.user_id = ${into})`)
      await db.execute(sql`delete from destination_connections f where user_id = ${from} and exists
        (select 1 from destination_connections i where i.user_id = ${into} and i.kind = f.kind)`)
      await db.execute(sql`delete from openverse_jobs f where user_id = ${from} and status in ('queued', 'running')
        and exists (select 1 from openverse_jobs i where i.user_id = ${into} and i.kind = f.kind and i.key = f.key
        and i.status in ('queued', 'running'))`)
      const moves: [string, string][] = [
        ['api_keys', 'owner_id'],
        ['jobs', 'owner_id'],
        ['versions', 'author_id'],
        ['publications', 'published_by'],
        ['destination_publications', 'published_by'],
        ['destination_connections', 'user_id'],
        ['idempotency_keys', 'principal_id'],
        ['plans', 'user_id'],
        ['gateway_calls', 'caller_id'],
        ['comments', 'author_id'],
        ['comments', 'resolved_by'],
        ['media', 'uploader_id'],
        ['media_uploads', 'uploader_id'],
        ['openverse_jobs', 'user_id'],
        ['edits', 'author_id'],
        ['version_comments', 'author_id'],
        ['comment_reads', 'user_id'],
        ['favorites', 'user_id'],
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
        ['narration_locks', 'holder_id'],
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

    engineRendersSince: async (since) =>
      (
        await db
          .select({ renders: t.attempts.engineRenders })
          .from(t.attempts)
          .where(and(gte(t.attempts.endedAt, since), isNotNull(t.attempts.engineRenders)))
      ).map((r) => r.renders as { video: number; stills: number; audio: number }),
    latestEngineAttempt: async (engine) => {
      const [row] = await db
        .select({
          stage: t.attempts.stage,
          errorCategory: t.attempts.errorCategory,
          endedAt: t.attempts.endedAt,
        })
        .from(t.attempts)
        .innerJoin(
          t.versions,
          and(eq(t.versions.jobId, t.attempts.jobId), eq(t.versions.n, t.attempts.versionN)),
        )
        .where(and(eq(t.versions.engine, engine), isNotNull(t.attempts.endedAt)))
        .orderBy(desc(t.attempts.endedAt))
        .limit(1)
      return row?.endedAt
        ? { stage: row.stage, errorCategory: row.errorCategory, endedAt: row.endedAt }
        : null
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

    narrationTakeBytes: async (uploaderId) => {
      const m = t.media
      const rows = await db
        // bigint sums come back as strings from Postgres.
        .select({ total: sql<string | number>`coalesce(sum(${m.bytes}), 0)::bigint` })
        .from(m)
        .where(
          and(
            eq(m.uploaderId, uploaderId),
            isTakeCol(m.role),
            sql`${m.status} <> 'rejected'`,
            isNull(m.deletingAt),
          ),
        )
      // Open take sessions have no media row yet; their declared size is held until completion.
      const u = t.mediaUploads
      const open = await db
        .select({ total: sql<string | number>`coalesce(sum(${u.size}), 0)::bigint` })
        .from(u)
        .where(and(eq(u.uploaderId, uploaderId), eq(u.status, 'open'), isTakeCol(u.role)))
      return Number(rows[0]?.total ?? 0) + Number(open[0]?.total ?? 0)
    },
    countRoleUploads: async (uploaderId, roles, since) => {
      if (!roles.length) return 0
      const m = t.media
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(m)
        .where(and(eq(m.uploaderId, uploaderId), inArray(m.role, [...roles]), gte(m.createdAt, since)))
      const u = t.mediaUploads
      const open = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(u)
        .where(
          and(
            eq(u.uploaderId, uploaderId),
            eq(u.status, 'open'),
            inArray(u.role, [...roles]),
            gte(u.createdAt, since),
          ),
        )
      return (rows[0]?.n ?? 0) + (open[0]?.n ?? 0)
    },
  }
}

export function createDrizzleStore(db: Db): Store {
  const base = repoFor(db)
  return {
    ...base,
    tx: (fn) => db.transaction((tx) => fn(repoFor(tx as unknown as Db))),
  }
}
