// Postgres store on Netlify Database through Drizzle. Tests run it against PGlite.
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
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
  UserRow,
  VersionRow,
  WebhookEventRow,
} from '../domain/types.js'
import { isoWeek } from './memory.js'
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
    deleteExpiredIdempotency: async (now) =>
      (
        await db
          .delete(t.idempotencyKeys)
          .where(lte(t.idempotencyKeys.expiresAt, now))
          .returning({ k: t.idempotencyKeys.key })
      ).length,

    insertWebhookEvent: async (row) => {
      await db.insert(t.webhookEvents).values(row)
    },
    listDueWebhookEvents: async (now, limit) =>
      (await db
        .select()
        .from(t.webhookEvents)
        .where(
          and(
            isNull(t.webhookEvents.deliveredAt),
            lte(t.webhookEvents.nextRetryAt, now),
            or(isNull(t.webhookEvents.leaseUntil), lte(t.webhookEvents.leaseUntil, now)),
          ),
        )
        .orderBy(asc(t.webhookEvents.nextRetryAt))
        .limit(limit)) as WebhookEventRow[],
    updateWebhookEvent: async (id, patch) => {
      await db.update(t.webhookEvents).set(patch).where(eq(t.webhookEvents.eventId, id))
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
      const out = new Map<string, { userId: string; week: string; credits: number | null; videos: number }>()
      for (const r of rows) {
        const week = isoWeek(r.queuedAt)
        const k = `${r.authorId}|${week}`
        const row = out.get(k) ?? { userId: r.authorId, week, credits: 0, videos: 0 }
        const c = (r.usage as { totalCreditsCost?: number } | null)?.totalCreditsCost
        if (row.credits !== null)
          row.credits =
            c === undefined
              ? TERMINAL_STAGES.includes(r.stage as never)
                ? null
                : row.credits
              : row.credits + c
        row.videos += 1
        out.set(k, row)
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
