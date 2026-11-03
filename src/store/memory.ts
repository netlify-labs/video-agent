// In-memory store with the same semantics as Postgres: transactions are serialized and roll back
// on error. Used by tests and by OpenAPI generation.
import { AsyncLocalStorage } from 'node:async_hooks'
import { NARRATION_SETTING_DEFAULTS, SLOT_STAGES, isTerminal } from '../domain/types.js'
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
  OwnershipTransferRow,
  NotificationRow,
  PlanRow,
  CommentRow,
  VersionCommentRow,
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
} from '../domain/types.js'
import type { JobQuery, Repo, Store } from './types.js'
import { searchWords } from '../lib/search.js'

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
  notifications: NotificationRow[]
  plans: Map<string, PlanRow>
  comments: Map<string, CommentRow>
  gatewayCalls: GatewayCallRow[]
  notificationReads: Map<string, string>
  commentReads: Map<string, string>
  versionComments: VersionCommentRow[]
  checkpoints: Map<string, CheckpointRow>
  edits: Map<string, EditRow>
  media: Map<string, MediaRow>
  uploads: Map<string, MediaUploadRow>
  uploadParts: Map<string, MediaUploadPartRow>
  openverseJobs: Map<string, OpenverseJobRow>
  openverseSearches: Map<string, OpenverseSearchRow>
  openverseSearchUses: Map<string, { key: string; day: string; count: number }>
  versionMedia: VersionMediaRow[]
  mediaRefs: Map<string, MediaRefRow>
  narrationLocks: Map<string, NarrationLockRow>
  userWebhooks: Map<string, UserWebhookRow>
  cleanup: Map<string, CleanupRow>
  oauthClients: Map<string, OAuthClientRow>
  oauthRequests: Map<string, OAuthRequestRow>
  oauthGrants: Map<string, OAuthGrantRow>
  oauthTokens: Map<string, OAuthTokenRow>
  identities: Map<string, UserIdentityRow>
  sessions: Map<string, SessionRow>
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
  notifications: [],
  plans: new Map(),
  comments: new Map(),
  gatewayCalls: [],
  notificationReads: new Map(),
  commentReads: new Map(),
  versionComments: [],
  checkpoints: new Map(),
  edits: new Map(),
  media: new Map(),
  uploads: new Map(),
  uploadParts: new Map(),
  openverseJobs: new Map(),
  openverseSearches: new Map(),
  openverseSearchUses: new Map(),
  versionMedia: [],
  mediaRefs: new Map(),
  narrationLocks: new Map(),
  userWebhooks: new Map(),
  cleanup: new Map(),
  oauthClients: new Map(),
  oauthRequests: new Map(),
  oauthGrants: new Map(),
  oauthTokens: new Map(),
  identities: new Map(),
  sessions: new Map(),
})

const clone = <T>(v: T): T => structuredClone(v)
const vkey = (jobId: string, n: number) => `${jobId}#${n}`
const rkey = (r: Pick<MediaRefRow, 'mediaId' | 'ownerKind' | 'ownerId'>) =>
  `${r.mediaId}\n${r.ownerKind}\n${r.ownerId}`
const byCreated = (a: MediaRefRow, b: MediaRefRow) =>
  a.createdAt.localeCompare(b.createdAt) || rkey(a).localeCompare(rkey(b))
/** Library queries leave narration takes out, except `takesOf`'s own that GC isn't deleting. */
const takeVisible = (m: MediaRow, takesOf: string | undefined) =>
  m.role === null || (m.uploaderId === takesOf && m.deletingAt === null)
const ikey = (provider: string, subject: string) => `${provider}\n${subject}`
const live = (leaseUntil: string | null, now: string) => leaseUntil !== null && leaseUntil > now

export function createMemoryStore(): Store & { reset(): void; dump(): State } {
  let state = empty()
  let chain: Promise<unknown> = Promise.resolve()
  // Which transaction a call runs in: a nested call joins it, while a concurrent one (another request, sweep or GC)
  // waits its turn, the way a row lock would make it wait on Postgres.
  const txScope = new AsyncLocalStorage<{ open: boolean }>()

  const repo: Repo = {
    getSettings: async () => clone(state.settings),
    insertSettingsIfAbsent: async (row) => {
      // The database fills the voice-over settings' defaults.
      state.settings ??= { ...NARRATION_SETTING_DEFAULTS, ...clone(row) }
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
    replaceReceipt: async (row) => {
      state.receipts.set(row.attemptId, clone(row))
    },
    getIdempotency: async (p, op, key) => clone(state.idem.get(`${p}|${op}|${key}`) ?? null),
    insertIdempotency: async (row) => {
      state.idem.set(`${row.principalId}|${row.operation}|${row.key}`, clone(row))
    },
    deleteExpiredPlans: async (now) => {
      let n = 0
      for (const [id, p] of state.plans)
        if (p.expiresAt <= now) {
          state.plans.delete(id)
          n++
        }
      return n
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

    insertComment: async (row) => {
      state.comments.set(row.id, clone(row))
    },
    getComment: async (id) => clone(state.comments.get(id) ?? null),
    updateComment: async (id, patch) => {
      const c = state.comments.get(id)
      if (c) Object.assign(c, clone(patch))
    },
    listComments: async (jobId, n) =>
      clone(
        [...state.comments.values()]
          .filter((c) => c.jobId === jobId && c.deletedAt === null && (n === undefined || c.versionN === n))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      ),
    insertPlan: async (row) => {
      state.plans.set(row.id, clone(row))
    },
    getPlan: async (id) => clone(state.plans.get(id) ?? null),
    updatePlan: async (id, patch) => {
      const p = state.plans.get(id)
      if (p) Object.assign(p, clone(patch))
    },
    insertGatewayCall: async (row) => {
      state.gatewayCalls.push(clone(row))
    },
    listGatewayCalls: async (q) =>
      clone(state.gatewayCalls.filter((c) => c.at >= q.since && (!q.callerId || c.callerId === q.callerId))),
    insertNotification: async (row) => {
      state.notifications.push(clone(row))
    },
    listNotifications: async (userId, q) => {
      const b = q.before
      return clone(
        state.notifications
          .filter((n) => n.userId === userId)
          .sort((a, c) => c.createdAt.localeCompare(a.createdAt) || c.id.localeCompare(a.id))
          .filter((n) => !b || n.createdAt < b.createdAt || (n.createdAt === b.createdAt && n.id < b.id))
          .slice(0, q.limit),
      )
    },
    commentCounts: async (jobIds, userId) => {
      const out: Record<string, { count: number; unread: number }> = {}
      for (const c of state.comments.values()) {
        if (!jobIds.includes(c.jobId) || c.deletedAt) continue
        const readAt = userId ? (state.commentReads.get(`${userId}/${c.jobId}`) ?? null) : null
        const o = (out[c.jobId] ??= { count: 0, unread: 0 })
        o.count++
        if (userId && c.authorId !== userId && (readAt === null || c.createdAt > readAt)) o.unread++
      }
      return out
    },
    insertMedia: async (row) => {
      state.media.set(row.id, clone(row))
    },
    getMedia: async (id) => clone(state.media.get(id) ?? null),
    // Transactions here run one at a time (a global lock), so the row lock is the order they're queued in.
    lockMedia: async (ids) =>
      clone(
        [...new Set(ids)].sort().flatMap((id) => {
          const m = state.media.get(id)
          return m ? [m] : []
        }),
      ),
    updateMedia: async (id, patch) => {
      const m = state.media.get(id)
      if (m) Object.assign(m, clone(patch))
    },
    findMediaMatches: async (q) =>
      clone(
        [...state.media.values()]
          .filter(
            (m) =>
              !m.deletedAt &&
              (m.status === 'ready' || m.uploaderId === q.includePendingOf) &&
              takeVisible(m, q.takesOf) &&
              (q.sha256s.includes(m.originalSha256) || q.filenames.includes(m.filename)),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100),
      ),
    listMedia: async (q) =>
      clone(
        [...state.media.values()]
          .filter(
            (m) =>
              !m.deletedAt &&
              (m.status === 'ready' || m.uploaderId === q.includePendingOf) &&
              takeVisible(m, q.takesOf) &&
              (!q.kind || m.kind === q.kind) &&
              searchWords(q.search).every((w) =>
                [m.title, m.filename, m.caption, m.sourceTitle, m.creator].some((f) =>
                  f?.toLowerCase().includes(w.toLowerCase()),
                ),
              ) &&
              (!q.before ||
                (q.sort ?? 'newest') !== 'newest' ||
                m.createdAt < q.before.createdAt ||
                (m.createdAt === q.before.createdAt && m.id < q.before.id)),
          )
          .sort((a, b) =>
            q.sort === 'oldest'
              ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
              : q.sort === 'name'
                ? (a.title ?? a.filename)
                    .toLowerCase()
                    .localeCompare((b.title ?? b.filename).toLowerCase()) || a.id.localeCompare(b.id)
                : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
          )
          .slice(0, q.limit),
      ),
    insertUpload: async (row) => {
      state.uploads.set(row.id, clone(row))
    },
    getUpload: async (id) => clone(state.uploads.get(id) ?? null),
    updateUpload: async (id, patch) => {
      const u = state.uploads.get(id)
      if (u) Object.assign(u, clone(patch))
    },
    deleteUpload: async (id) => {
      state.uploads.delete(id)
    },
    reservedUploadBytes: async (uploaderId) =>
      [...state.uploads.values()]
        .filter((u) => u.uploaderId === uploaderId && (u.status === 'open' || u.status === 'assembling'))
        .reduce((s, u) => s + u.size, 0),
    listStaleUploads: async (now, limit) =>
      clone(
        [...state.uploads.values()]
          .filter(
            (u) =>
              (u.status === 'open' && u.expiresAt < now) ||
              (u.status === 'assembling' && (u.leaseUntil ?? '') < now) ||
              ((u.status === 'done' || u.status === 'failed') && u.expiresAt < now),
          )
          .slice(0, limit),
      ),
    getUploadPart: async (uploadId, idx) => clone(state.uploadParts.get(`${uploadId}/${idx}`) ?? null),
    insertUploadPart: async (row) => {
      const k = `${row.uploadId}/${row.idx}`
      if (!state.uploadParts.has(k)) state.uploadParts.set(k, clone(row))
    },
    listUploadParts: async (uploadId) =>
      clone(
        [...state.uploadParts.values()].filter((p) => p.uploadId === uploadId).sort((a, b) => a.idx - b.idx),
      ),
    deleteUploadParts: async (uploadId) => {
      for (const k of [...state.uploadParts.keys()])
        if (k.startsWith(`${uploadId}/`)) state.uploadParts.delete(k)
    },
    insertOpenverseJobIfAbsent: async (row) => {
      const inflight = (j: OpenverseJobRow) => j.status === 'queued' || j.status === 'running'
      const live = [...state.openverseJobs.values()].find(
        (j) =>
          inflight(row) && j.userId === row.userId && j.kind === row.kind && j.key === row.key && inflight(j),
      )
      if (live) return clone(live)
      state.openverseJobs.set(row.id, clone(row))
      return clone(row)
    },
    getOpenverseJob: async (id) => clone(state.openverseJobs.get(id) ?? null),
    findOpenverseJob: async (q) =>
      clone(
        [...state.openverseJobs.values()]
          .filter(
            (j) =>
              j.kind === q.kind &&
              j.key === q.key &&
              q.statuses.includes(j.status) &&
              j.updatedAt >= q.since &&
              (!q.userId || j.userId === q.userId),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
      ),
    countOpenverseJobs: async (userId, since) =>
      [...state.openverseJobs.values()].filter((j) => j.userId === userId && j.createdAt >= since).length,
    claimOpenverseJob: async (id, now) => {
      const j = state.openverseJobs.get(id)
      if (!j || j.status !== 'queued') return false
      Object.assign(j, { status: 'running', updatedAt: now })
      return true
    },
    updateOpenverseJob: async (id, patch) => {
      const j = state.openverseJobs.get(id)
      if (j) Object.assign(j, clone(patch))
    },
    listStaleOpenverseJobs: async (q) =>
      clone(
        [...state.openverseJobs.values()]
          .filter(
            (j) =>
              (j.status === 'queued' && j.updatedAt < q.queuedBefore) ||
              (j.status === 'running' && j.updatedAt < q.runningBefore),
          )
          .slice(0, q.limit),
      ),
    deleteExpiredOpenverseJobs: async (now) => {
      let n = 0
      for (const [id, j] of state.openverseJobs)
        if (j.expiresAt <= now) {
          state.openverseJobs.delete(id)
          n++
        }
      return n
    },
    getOpenverseSearch: async (key) => clone(state.openverseSearches.get(key) ?? null),
    putOpenverseSearch: async (row) => {
      state.openverseSearches.set(row.key, clone(row))
    },
    deleteOldOpenverseSearches: async (q) => {
      const rows = [...state.openverseSearches.values()].sort((a, b) =>
        b.fetchedAt.localeCompare(a.fetchedAt),
      )
      const gone = rows.filter((r, i) => r.fetchedAt < q.fetchedBefore || i >= q.keep)
      for (const r of gone) state.openverseSearches.delete(r.key)
      return gone.length
    },
    addOpenverseSearchUse: async (key, day) => {
      const k = `${day}/${key}`
      const u = state.openverseSearchUses.get(k)
      if (u) u.count++
      else state.openverseSearchUses.set(k, { key, day, count: 1 })
    },
    topOpenverseSearches: async (sinceDay, limit) => {
      const counts = new Map<string, number>()
      for (const u of state.openverseSearchUses.values())
        if (u.day >= sinceDay) counts.set(u.key, (counts.get(u.key) ?? 0) + u.count)
      return [...counts]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, limit)
    },
    deleteOpenverseSearchUses: async (beforeDay) => {
      let n = 0
      for (const [k, u] of state.openverseSearchUses)
        if (u.day < beforeDay) {
          state.openverseSearchUses.delete(k)
          n++
        }
      return n
    },
    insertVersionMedia: async (rows) => {
      state.versionMedia.push(...clone(rows))
    },
    listVersionMedia: async (jobId, n) =>
      clone(
        state.versionMedia
          .filter((r) => r.jobId === jobId && r.versionN === n)
          .sort((a, b) => a.position - b.position),
      ),
    insertMediaRefs: async (rows) => {
      for (const r of rows) if (!state.mediaRefs.has(rkey(r))) state.mediaRefs.set(rkey(r), clone(r))
    },
    deleteMediaRefs: async (ownerKind, ownerId, mediaIds) => {
      let n = 0
      for (const [k, r] of state.mediaRefs)
        if (
          r.ownerKind === ownerKind &&
          r.ownerId === ownerId &&
          (!mediaIds || mediaIds.includes(r.mediaId))
        ) {
          state.mediaRefs.delete(k)
          n++
        }
      return n
    },
    listMediaRefsByMedia: async (ids) =>
      clone([...state.mediaRefs.values()].filter((r) => ids.includes(r.mediaId)).sort(byCreated)),
    listMediaRefsByOwner: async (ownerKind, ownerId) =>
      clone(
        [...state.mediaRefs.values()]
          .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
          .sort(byCreated),
      ),
    listUnreferencedTakes: async (q) => {
      const held = new Set([...state.mediaRefs.values()].map((r) => r.mediaId))
      return clone(
        [...state.media.values()]
          .filter(
            (m) =>
              m.role !== null &&
              m.deletingAt === null &&
              !held.has(m.id) &&
              (!q.uploaderId || m.uploaderId === q.uploaderId) &&
              (!q.due ||
                (m.retainUntil !== null ? m.retainUntil <= q.due.now : m.createdAt <= q.due.createdBefore)),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, q.limit),
      )
    },
    getNarrationLock: async (jobId) => clone(state.narrationLocks.get(jobId) ?? null),
    upsertNarrationLock: async (row) => {
      state.narrationLocks.set(row.jobId, clone(row))
    },
    deleteNarrationLock: async (jobId) => {
      state.narrationLocks.delete(jobId)
    },
    deleteStaleNarrationLocks: async (before) => {
      let n = 0
      for (const [k, l] of state.narrationLocks)
        if (l.heartbeatAt < before) {
          state.narrationLocks.delete(k)
          n++
        }
      return n
    },
    mediaUsage: async (ids) => {
      const out: Record<string, string[]> = {}
      for (const r of state.versionMedia)
        if (ids.includes(r.mediaId) && !(out[r.mediaId] ??= []).includes(r.jobId))
          out[r.mediaId]?.push(r.jobId)
      return out
    },
    mediaBySource: async (source, ids) =>
      clone(
        [...state.media.values()]
          .filter(
            (m) => m.source === source && m.sourceId !== null && ids.includes(m.sourceId) && !m.deletedAt,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    versionProvenance: async (jobId) =>
      state.versionMedia
        .filter((r) => r.jobId === jobId)
        .sort((a, b) => a.versionN - b.versionN || a.position - b.position)
        .flatMap((r) => {
          const m = state.media.get(r.mediaId)
          if (!m?.source) return []
          const { versionN, mediaId, position, kind } = r
          return [{ versionN, mediaId, position, kind, ...pickProvenance(m) }]
        }),
    insertEdit: async (row) => {
      state.edits.set(row.id, clone(row))
    },
    getEdit: async (id) => clone(state.edits.get(id) ?? null),
    updateEdit: async (id, patch) => {
      const e = state.edits.get(id)
      if (e) Object.assign(e, clone(patch))
    },
    deleteEdit: async (id) => {
      state.edits.delete(id)
    },
    findEdit: async (authorId, jobId, baseN, now) =>
      clone(
        [...state.edits.values()]
          .filter(
            (e) =>
              e.authorId === authorId &&
              e.jobId === jobId &&
              e.baseN === baseN &&
              e.renderedN === null &&
              e.expiresAt >= now,
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
      ),
    listExpiredEdits: async (now, limit) =>
      clone(
        [...state.edits.values()]
          .filter((e) => e.expiresAt < now)
          .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
          .slice(0, limit),
      ),
    getCheckpoint: async (attemptId) => clone(state.checkpoints.get(attemptId) ?? null),
    putCheckpoint: async (row) => {
      state.checkpoints.set(row.attemptId, clone(row))
    },
    insertVersionComments: async (rows) => {
      state.versionComments.push(...clone(rows))
    },
    videoPage: async (jobIds) => {
      const has = (id: string) => jobIds.includes(id)
      const jobs = clone([...state.jobs.values()].filter((j) => has(j.id)))
      const owners = [...new Set(jobs.map((j) => j.ownerId))].flatMap((id) => {
        const u = state.users.get(id)
        return u ? [clone(u)] : []
      })
      return {
        jobs,
        versions: clone([...state.versions.values()].filter((v) => has(v.jobId)).sort((a, b) => b.n - a.n)),
        attempts: clone(
          [...state.attempts.values()]
            .filter((a) => has(a.jobId))
            .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
        ),
        publications: clone(
          [...state.publications.values()]
            .filter((p) => has(p.jobId))
            .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
        ),
        outputs: clone([...state.outputs.values()].filter((o) => has(o.jobId))),
        versionComments: clone(
          state.versionComments
            .filter((r) => has(r.jobId))
            .sort((a, b) => a.versionN - b.versionN || a.position - b.position),
        ),
        provenance: state.versionMedia
          .filter((r) => has(r.jobId))
          .sort((a, b) => a.versionN - b.versionN || a.position - b.position)
          .flatMap((r) => {
            const m = state.media.get(r.mediaId)
            if (!m?.source) return []
            const { jobId, versionN, mediaId, position, kind } = r
            return [{ jobId, versionN, mediaId, position, kind, ...pickProvenance(m) }]
          }),
        owners,
      }
    },
    listVersionComments: async (jobId, n) =>
      clone(
        state.versionComments
          .filter((r) => r.jobId === jobId && (n === undefined || r.versionN === n))
          .sort((a, b) => a.versionN - b.versionN || a.position - b.position),
      ),
    markCommentsAddressed: async (jobId, ids, n) => {
      for (const c of state.comments.values())
        if (c.jobId === jobId && ids.includes(c.id) && !c.deletedAt) c.addressedInN = n
    },
    getCommentReadAt: async (userId, jobId) => state.commentReads.get(`${userId}/${jobId}`) ?? null,
    setCommentReadAt: async (userId, jobId, readAt) => {
      state.commentReads.set(`${userId}/${jobId}`, readAt)
    },
    getNotificationReadAt: async (userId) => state.notificationReads.get(userId) ?? null,
    setNotificationReadAt: async (userId, readAt) => {
      state.notificationReads.set(userId, readAt)
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
      const out = new Map<string, UsageRow>()
      for (const a of state.attempts.values()) {
        if (a.queuedAt < since) continue
        const v = state.versions.get(vkey(a.jobId, a.versionN))
        if (v) addUsage(out, v.authorId, a.queuedAt, a.stage, a.usage?.totalCreditsCost)
      }
      return [...out.values()]
    },
    insertOAuthClient: async (row) => {
      state.oauthClients.set(row.id, clone(row))
    },
    getOAuthClient: async (id) => clone(state.oauthClients.get(id) ?? null),
    insertOAuthRequest: async (row) => {
      state.oauthRequests.set(row.id, clone(row))
    },
    getOAuthRequest: async (id) => clone(state.oauthRequests.get(id) ?? null),
    findOAuthRequest: async (by) => {
      const hit = [...state.oauthRequests.values()].find((r) =>
        'consentHash' in by ? r.consentHash === by.consentHash : r.codeHash === by.codeHash,
      )
      return clone(hit ?? null)
    },
    updateOAuthRequest: async (id, patch) => {
      const r = state.oauthRequests.get(id)
      if (r) Object.assign(r, clone(patch))
    },
    insertOAuthGrant: async (row) => {
      state.oauthGrants.set(row.id, clone(row))
    },
    getOAuthGrant: async (id) => clone(state.oauthGrants.get(id) ?? null),
    listOAuthGrants: async (userId, now) =>
      clone(
        [...state.oauthGrants.values()]
          .filter((g) => g.userId === userId && g.revokedAt === null && g.expiresAt > now)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      ),
    updateOAuthGrant: async (id, patch) => {
      const g = state.oauthGrants.get(id)
      if (g) Object.assign(g, clone(patch))
    },
    revokeOAuthGrants: async (userId, at) => {
      for (const g of state.oauthGrants.values())
        if (g.userId === userId && g.revokedAt === null) g.revokedAt = at
    },
    insertOAuthToken: async (row) => {
      state.oauthTokens.set(row.hash, clone(row))
    },
    getOAuthToken: async (hash) => clone(state.oauthTokens.get(hash) ?? null),
    updateOAuthToken: async (hash, patch) => {
      const t = state.oauthTokens.get(hash)
      if (t) Object.assign(t, clone(patch))
    },
    deleteExpiredOAuth: async (now, clientsBefore) => {
      let n = 0
      const del = <T>(m: Map<string, T>, k: string) => {
        m.delete(k)
        n++
      }
      for (const [id, r] of state.oauthRequests) if (r.expiresAt <= now) del(state.oauthRequests, id)
      for (const [id, g] of state.oauthGrants)
        if (g.revokedAt !== null || g.expiresAt <= now) del(state.oauthGrants, id)
      for (const [h, t] of state.oauthTokens)
        if (t.expiresAt <= now || !state.oauthGrants.has(t.grantId)) del(state.oauthTokens, h)
      const used = new Set([
        ...[...state.oauthGrants.values()].map((g) => g.clientId),
        ...[...state.oauthRequests.values()].map((r) => r.clientId),
      ])
      for (const [id, c] of state.oauthClients)
        if (c.createdAt < clientsBefore && !used.has(id)) del(state.oauthClients, id)
      return n
    },
    getUserIdentity: async (provider, subject) =>
      clone(state.identities.get(ikey(provider, subject)) ?? null),
    insertUserIdentityIfAbsent: async (row) => {
      const k = ikey(row.provider, row.subject)
      if (!state.identities.has(k)) state.identities.set(k, clone(row))
      return clone(state.identities.get(k) as UserIdentityRow)
    },
    updateUserIdentity: async (provider, subject, patch) => {
      const r = state.identities.get(ikey(provider, subject))
      if (r) Object.assign(r, clone(patch))
    },
    listUserIdentities: async () => clone([...state.identities.values()]),
    insertSession: async (row) => {
      state.sessions.set(row.id, clone(row))
    },
    getSession: async (id) => clone(state.sessions.get(id) ?? null),
    updateSession: async (id, patch) => {
      const r = state.sessions.get(id)
      if (r) Object.assign(r, clone(patch))
    },
    revokeUserSessions: async (userId, at) => {
      for (const r of state.sessions.values())
        if (r.userId === userId && r.revokedAt === null) r.revokedAt = at
    },
    deleteExpiredSessions: async (now) => {
      let n = 0
      for (const [id, r] of state.sessions)
        if (r.revokedAt !== null || r.expiresAt <= now) {
          state.sessions.delete(id)
          n++
        }
      return n
    },
    mergeUser: async (from, into) => {
      const swap = (v: string) => (v === from ? into : v)
      for (const k of state.keys.values()) k.ownerId = swap(k.ownerId)
      for (const j of state.jobs.values()) j.ownerId = swap(j.ownerId)
      for (const v of state.versions.values()) v.authorId = swap(v.authorId)
      for (const p of state.publications.values()) p.publishedBy = swap(p.publishedBy)
      for (const [k, r] of [...state.idem]) {
        if (r.principalId !== from) continue
        state.idem.delete(k)
        const nk = `${into}|${r.operation}|${r.key}`
        if (!state.idem.has(nk)) state.idem.set(nk, { ...r, principalId: into })
      }
      for (const p of state.plans.values()) p.userId = swap(p.userId)
      for (const g of state.gatewayCalls) g.callerId = swap(g.callerId)
      for (const c of state.comments.values()) {
        c.authorId = swap(c.authorId)
        if (c.resolvedBy) c.resolvedBy = swap(c.resolvedBy)
      }
      for (const m of state.media.values()) m.uploaderId = swap(m.uploaderId)
      for (const u of state.uploads.values()) u.uploaderId = swap(u.uploaderId)
      for (const j of state.openverseJobs.values()) j.userId = swap(j.userId)
      for (const e of state.edits.values()) e.authorId = swap(e.authorId)
      for (const c of state.versionComments) c.authorId = swap(c.authorId)
      for (const [k, at] of [...state.commentReads]) {
        if (!k.startsWith(`${from}/`)) continue
        state.commentReads.delete(k)
        const nk = `${into}/${k.slice(from.length + 1)}`
        if (!state.commentReads.has(nk)) state.commentReads.set(nk, at)
      }
      for (const n of state.notifications) {
        n.userId = swap(n.userId)
        n.actorId = swap(n.actorId)
      }
      const read = state.notificationReads.get(from)
      state.notificationReads.delete(from)
      if (read && !state.notificationReads.has(into)) state.notificationReads.set(into, read)
      for (const t of state.transfers) {
        t.fromUserId = swap(t.fromUserId)
        t.toUserId = swap(t.toUserId)
        t.byUserId = swap(t.byUserId)
      }
      for (const [k, v] of [...state.verdicts]) {
        if (v.userId !== from) continue
        state.verdicts.delete(k)
        const nk = `${v.jobId}:${v.versionN}:${into}`
        if (!state.verdicts.has(nk)) state.verdicts.set(nk, { ...v, userId: into })
      }
      for (const d of state.deliveries.values()) if (d.destKind === 'personal') d.destRef = swap(d.destRef)
      const hook = state.userWebhooks.get(from)
      state.userWebhooks.delete(from)
      if (hook && !state.userWebhooks.has(into)) state.userWebhooks.set(into, { ...hook, userId: into })
      for (const r of state.oauthRequests.values()) if (r.userId) r.userId = swap(r.userId)
      for (const g of state.oauthGrants.values()) g.userId = swap(g.userId)
      for (const r of state.sessions.values()) r.userId = swap(r.userId)
      for (const r of state.identities.values()) r.userId = swap(r.userId)
      for (const l of state.narrationLocks.values()) l.holderId = swap(l.holderId)
      state.users.delete(from)
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
      if (txScope.getStore()?.open) return fn(repo)
      const run = async () => {
        const snapshot = clone(state)
        const scope = { open: true }
        try {
          return await txScope.run(scope, () => fn(repo))
        } catch (e) {
          state = snapshot
          throw e
        } finally {
          scope.open = false
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

export type UsageRow = { userId: string; week: string; credits: number | null; videos: number }

/** Counts one attempt in its author's weekly row. Credits become unknown once a finished attempt reports none. */
export function addUsage(
  out: Map<string, UsageRow>,
  authorId: string,
  queuedAt: string,
  stage: Stage,
  c: number | undefined,
) {
  const week = isoWeek(queuedAt)
  const k = `${authorId}|${week}`
  const row = out.get(k) ?? { userId: authorId, week, credits: 0, videos: 0 }
  if (row.credits !== null)
    row.credits = c === undefined ? (isTerminal(stage) ? null : row.credits) : row.credits + c
  row.videos += 1
  out.set(k, row)
}

export function isoWeek(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

function pickProvenance(
  m: MediaRow,
): Omit<VersionProvenanceRow, 'versionN' | 'mediaId' | 'position' | 'kind'> {
  return {
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
  }
}
