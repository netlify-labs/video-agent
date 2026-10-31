// In-memory store with the same semantics as Postgres: transactions are serialized and roll back
// on error. Used by tests and by OpenAPI generation.
import { SLOT_STAGES, isTerminal } from '../domain/types.js'
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
  VerdictRow,
  OwnershipTransferRow,
  WebhookDeliveryRow,
  UserWebhookRow,
} from '../domain/types.js'
import type { JobQuery, Repo, Store } from './types.js'

interface State {
  settings: SettingsRow | null
  users: Map<string, UserRow>
  keys: Map<string, ApiKeyRow>
  jobs: Map<string, JobRow>
  versions: Map<string, VersionRow>
  attempts: Map<string, AttemptRow>
  outputs: Map<string, OutputRow>
  publications: Map<string, PublicationRow>
  receipts: Map<string, ReceiptRow>
  idem: Map<string, IdempotencyRow>
  events: Map<string, WebhookEventRow>
  deliveries: Map<string, WebhookDeliveryRow>
  verdicts: Map<string, VerdictRow>
  transfers: OwnershipTransferRow[]
  userWebhooks: Map<string, UserWebhookRow>
  cleanup: Map<string, CleanupRow>
}

const empty = (): State => ({
  settings: null,
  users: new Map(),
  keys: new Map(),
  jobs: new Map(),
  versions: new Map(),
  attempts: new Map(),
  outputs: new Map(),
  publications: new Map(),
  receipts: new Map(),
  idem: new Map(),
  events: new Map(),
  deliveries: new Map(),
  verdicts: new Map(),
  transfers: [],
  userWebhooks: new Map(),
  cleanup: new Map(),
})

const clone = <T>(v: T): T => structuredClone(v)
const vkey = (jobId: string, n: number) => `${jobId}#${n}`
const live = (leaseUntil: string | null, now: string) => leaseUntil !== null && leaseUntil > now

export function createMemoryStore(): Store & { reset(): void; dump(): State } {
  let state = empty()
  let chain: Promise<unknown> = Promise.resolve()
  let inTx = false

  const repo: Repo = {
    getSettings: async () => clone(state.settings),
    insertSettingsIfAbsent: async (row) => {
      state.settings ??= clone(row)
      return clone(state.settings)
    },
    updateSettings: async (patch) => {
      if (state.settings) Object.assign(state.settings, clone(patch))
    },

    getUser: async (id) => clone(state.users.get(id) ?? null),
    insertUserIfAbsent: async (row) => {
      if (!state.users.has(row.id)) state.users.set(row.id, clone(row))
      return clone(state.users.get(row.id) as UserRow)
    },
    updateUser: async (id, patch) => {
      const u = state.users.get(id)
      if (u) Object.assign(u, clone(patch))
    },
    listUsers: async () =>
      clone([...state.users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),

    insertKey: async (row) => {
      state.keys.set(row.id, clone(row))
    },
    getKey: async (id) => clone(state.keys.get(id) ?? null),
    listKeys: async (ownerId) =>
      clone(
        [...state.keys.values()]
          .filter((k) => k.ownerId === ownerId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    updateKey: async (id, patch) => {
      const k = state.keys.get(id)
      if (k) Object.assign(k, clone(patch))
    },

    insertJob: async (row) => {
      if (state.jobs.has(row.id)) throw new Error(`duplicate job ${row.id}`)
      state.jobs.set(row.id, clone(row))
    },
    getJob: async (id) => clone(state.jobs.get(id) ?? null),
    updateJob: async (id, patch) => {
      const j = state.jobs.get(id)
      if (j) Object.assign(j, clone(patch))
    },
    listJobs: async (q: JobQuery) => {
      const published = new Set(
        [...state.publications.values()].filter((p) => p.unpublishedAt === null).map((p) => p.jobId),
      )
      const needle = q.q?.toLowerCase()
      let rows = [...state.jobs.values()].filter((j) => j.deletedAt === null)
      if (q.ownerId) rows = rows.filter((j) => j.ownerId === q.ownerId)
      const vis = q.visibleTo
      if (vis && !vis.all) rows = rows.filter((j) => !j.private || j.ownerId === vis.userId)
      if (q.status) rows = rows.filter((j) => j.status === q.status)
      if (q.published !== undefined) rows = rows.filter((j) => published.has(j.id) === q.published)
      if (needle) {
        rows = rows.filter(
          (j) =>
            j.title.toLowerCase().includes(needle) ||
            [...state.versions.values()].some(
              (v) => v.jobId === j.id && v.prompt.toLowerCase().includes(needle),
            ),
        )
      }
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      if (q.cursor) {
        const c = q.cursor
        rows = rows.filter((j) => j.createdAt < c.createdAt || (j.createdAt === c.createdAt && j.id < c.id))
      }
      return clone(rows.slice(0, q.limit))
    },
    insertVersion: async (row) => {
      const k = vkey(row.jobId, row.n)
      if (state.versions.has(k)) throw new Error(`duplicate version ${k}`)
      state.versions.set(k, clone(row))
    },
    getVersion: async (jobId, n) => clone(state.versions.get(vkey(jobId, n)) ?? null),
    listVersions: async (jobId) =>
      clone([...state.versions.values()].filter((v) => v.jobId === jobId).sort((a, b) => b.n - a.n)),
    updateVersion: async (jobId, n, patch) => {
      const v = state.versions.get(vkey(jobId, n))
      if (v) Object.assign(v, clone(patch))
    },

    insertAttempt: async (row) => {
      state.attempts.set(row.id, clone(row))
    },
    getAttempt: async (id) => clone(state.attempts.get(id) ?? null),
    updateAttempt: async (id, patch, expectStage) => {
      const a = state.attempts.get(id)
      if (!a) return false
      if (expectStage && a.stage !== expectStage) return false
      Object.assign(a, clone(patch))
      return true
    },
    leaseAttempt: async (id, stage, now, until) => {
      const a = state.attempts.get(id)
      if (!a || a.stage !== stage || live(a.leaseUntil, now)) return false
      a.leaseUntil = until
      return true
    },
    latestAttempt: async (jobId, versionN) => {
      const rows = [...state.attempts.values()]
        .filter((a) => a.jobId === jobId && a.versionN === versionN)
        .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      return clone(rows[0] ?? null)
    },
    listAttempts: async (jobId) =>
      clone(
        [...state.attempts.values()]
          .filter((a) => a.jobId === jobId)
          .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
      ),
    listDueAttempts: async (now, limit) =>
      clone(
        [...state.attempts.values()]
          .filter(
            (a) =>
              !isTerminal(a.stage) &&
              a.stage !== 'queued' &&
              a.stage !== 'unresolved' &&
              a.nextActionAt !== null &&
              a.nextActionAt <= now &&
              !live(a.leaseUntil, now),
          )
          .sort((a, b) => (a.nextActionAt ?? '').localeCompare(b.nextActionAt ?? ''))
          .slice(0, limit),
      ),
    countSlotHolders: async () =>
      [...state.attempts.values()].filter((a) => SLOT_STAGES.includes(a.stage)).length,
    claimOldestQueued: async (now) => {
      const rows = [...state.attempts.values()]
        .filter((a) => a.stage === 'queued' && (a.nextActionAt === null || a.nextActionAt <= now))
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      return clone(rows[0] ?? null)
    },
    lockQueueControl: async () => undefined,
    listAttemptsByStage: async (stages, limit) =>
      clone([...state.attempts.values()].filter((a) => stages.includes(a.stage)).slice(0, limit)),

    upsertOutput: async (row) => {
      state.outputs.set(vkey(row.jobId, row.versionN), clone(row))
    },
    getOutput: async (jobId, n) => clone(state.outputs.get(vkey(jobId, n)) ?? null),
    insertPublication: async (row) => {
      if (state.publications.has(row.slug)) throw new Error('duplicate slug')
      state.publications.set(row.slug, clone(row))
    },
    getPublication: async (slug) => clone(state.publications.get(slug) ?? null),
    listPublications: async (jobId) =>
      clone(
        [...state.publications.values()]
          .filter((p) => p.jobId === jobId)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
      ),
    updatePublication: async (slug, patch) => {
      const p = state.publications.get(slug)
      if (p) Object.assign(p, clone(patch))
    },

    getReceipt: async (id) => clone(state.receipts.get(id) ?? null),
    insertReceipt: async (row) => {
      if (state.receipts.has(row.attemptId)) throw new Error('duplicate receipt')
      state.receipts.set(row.attemptId, clone(row))
    },
    getIdempotency: async (p, op, key) => clone(state.idem.get(`${p}|${op}|${key}`) ?? null),
    insertIdempotency: async (row) => {
      state.idem.set(`${row.principalId}|${row.operation}|${row.key}`, clone(row))
    },
    deleteExpiredIdempotency: async (now) => {
      let n = 0
      for (const [k, v] of state.idem) {
        if (v.expiresAt <= now) {
          state.idem.delete(k)
          n++
        }
      }
      return n
    },

    insertOwnershipTransfer: async (row) => {
      state.transfers.push(clone(row))
    },
    listOwnershipTransfers: async (jobId) => clone(state.transfers.filter((t) => t.jobId === jobId)),
    putVerdict: async (row) => {
      state.verdicts.set(`${row.jobId}:${row.versionN}:${row.userId}`, clone(row))
    },
    deleteVerdict: async (jobId, n, userId) => {
      state.verdicts.delete(`${jobId}:${n}:${userId}`)
    },
    listVerdicts: async (jobIds) =>
      clone([...state.verdicts.values()].filter((v) => jobIds.includes(v.jobId))),
    insertWebhookEvent: async (row) => {
      state.events.set(row.eventId, clone(row))
    },
    getWebhookEvent: async (id) => clone(state.events.get(id) ?? null),
    insertWebhookDelivery: async (row) => {
      const dup = [...state.deliveries.values()].some(
        (d) => d.eventId === row.eventId && d.destKind === row.destKind && d.destRef === row.destRef,
      )
      if (!dup) state.deliveries.set(row.id, clone(row))
    },
    claimDueWebhookDeliveries: async (now, leaseUntil, limit) => {
      const due = [...state.deliveries.values()]
        .filter(
          (d) =>
            d.deliveredAt === null &&
            d.droppedAt === null &&
            d.nextRetryAt !== null &&
            d.nextRetryAt <= now &&
            !live(d.leaseUntil, now),
        )
        .sort((a, b) => (a.nextRetryAt ?? '').localeCompare(b.nextRetryAt ?? ''))
        .slice(0, limit)
      for (const d of due) d.leaseUntil = leaseUntil
      return clone(due)
    },
    updateWebhookDelivery: async (id, patch) => {
      const d = state.deliveries.get(id)
      if (d) Object.assign(d, clone(patch))
    },
    getUserWebhook: async (userId) => clone(state.userWebhooks.get(userId) ?? null),
    putUserWebhook: async (row) => {
      state.userWebhooks.set(row.userId, clone(row))
    },
    deleteUserWebhook: async (userId) => {
      state.userWebhooks.delete(userId)
    },
    insertCleanup: async (row) => {
      if ([...state.cleanup.values()].some((c) => c.store === row.store && c.prefix === row.prefix)) return
      state.cleanup.set(row.id, clone(row))
    },
    listDueCleanup: async (now, limit) =>
      clone(
        [...state.cleanup.values()].filter((c) => c.doneAt === null && c.nextActionAt <= now).slice(0, limit),
      ),
    updateCleanup: async (id, patch) => {
      const c = state.cleanup.get(id)
      if (c) Object.assign(c, clone(patch))
    },

    usageSince: async (since) => {
      const out = new Map<string, { userId: string; week: string; credits: number | null; videos: number }>()
      for (const a of state.attempts.values()) {
        if (a.queuedAt < since) continue
        const v = state.versions.get(vkey(a.jobId, a.versionN))
        if (!v) continue
        const week = isoWeek(a.queuedAt)
        const k = `${v.authorId}|${week}`
        const row = out.get(k) ?? { userId: v.authorId, week, credits: 0, videos: 0 }
        const c = a.usage?.totalCreditsCost
        row.credits =
          row.credits === null || c === undefined
            ? isTerminal(a.stage)
              ? null
              : row.credits
            : row.credits + c
        row.videos += 1
        out.set(k, row)
      }
      return [...out.values()]
    },
    failuresSince: async (since) => {
      const counts = new Map<string, number>()
      for (const a of state.attempts.values()) {
        if (a.endedAt && a.endedAt >= since && a.errorCategory)
          counts.set(a.errorCategory, (counts.get(a.errorCategory) ?? 0) + 1)
      }
      return [...counts].map(([category, count]) => ({ category, count }))
    },
  }

  const store = {
    ...repo,
    tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
      if (inTx) return fn(repo)
      const run = async () => {
        const snapshot = clone(state)
        inTx = true
        try {
          return await fn(repo)
        } catch (e) {
          state = snapshot
          throw e
        } finally {
          inTx = false
        }
      }
      const p = chain.then(run, run)
      chain = p.catch(() => undefined)
      return p
    },
    reset() {
      state = empty()
    },
    dump() {
      return state
    },
  }
  return store
}

export function isoWeek(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}
