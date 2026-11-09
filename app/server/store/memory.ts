// In-memory store with the same semantics as Postgres: transactions are serialized and roll back
// on error. Used by tests and by OpenAPI generation.
import { AsyncLocalStorage } from 'node:async_hooks'
import { NARRATION_SETTING_DEFAULTS, SLOT_STAGES, isTerminal } from '../domain/types.js'
import type {
  ApiKeyRow,
  AttemptRow,
  CleanupRow,
  CliLoginFailureRow,
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
  DestinationRow,
  DestinationConnectionRow,
  DestinationPublicationRow,
} from '../domain/types.js'
import type { JobQuery, Repo, Store } from './types.js'
import { searchWords } from '../lib/search.js'
import { isTakeRole } from '../domain/media-roles.js'
import { ApiError } from '../lib/errors.js'

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
  /** `${userId}/${jobId}` → starred at. */
  favorites: Map<string, string>
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
  cliLogins: Map<string, CliLoginRow>
  cliLoginFailures: Map<string, CliLoginFailureRow>
  oauthGrants: Map<string, OAuthGrantRow>
  oauthTokens: Map<string, OAuthTokenRow>
  identities: Map<string, UserIdentityRow>
  sessions: Map<string, SessionRow>
  destinations: Map<string, DestinationRow>
  connections: Map<string, DestinationConnectionRow>
  dpubs: Map<string, DestinationPublicationRow>
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
  favorites: new Map(),
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
  cliLogins: new Map(),
  cliLoginFailures: new Map(),
  oauthGrants: new Map(),
  oauthTokens: new Map(),
  identities: new Map(),
  sessions: new Map(),
  destinations: new Map(),
  connections: new Map(),
  dpubs: new Map(),
})

const clone = <T>(v: T): T => structuredClone(v)
const vkey = (jobId: string, n: number) => `${jobId}#${n}`
const rkey = (r: Pick<MediaRefRow, 'mediaId' | 'ownerKind' | 'ownerId'>) =>
  `${r.mediaId}\n${r.ownerKind}\n${r.ownerId}`
const byCreated = (a: MediaRefRow, b: MediaRefRow) =>
  a.createdAt.localeCompare(b.createdAt) || rkey(a).localeCompare(rkey(b))
type Keyed = { createdAt: string; id: string }
const newestFirst = (a: Keyed, b: Keyed) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
const oldestFirst = (a: Keyed, b: Keyed) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
/** Keyset paging: `r` comes after cursor `c` newest first. */
const olderThan = (r: Keyed, c: Keyed) =>
  r.createdAt < c.createdAt || (r.createdAt === c.createdAt && r.id < c.id)
/**
 * Library queries: undeleted items, ready or `includePendingOf`'s own, leaving narration takes out except `takesOf`'s
 * own that GC isn't deleting.
 */
const libraryVisible = (
  m: MediaRow,
  q: { includePendingOf?: string | undefined; takesOf?: string | undefined },
) =>
  !m.deletedAt &&
  (m.status === 'ready' || m.uploaderId === q.includePendingOf) &&
  // Narration takes are the uploader's own; other roles are library items like any other.
  (!isTakeRole(m.role) || (m.uploaderId === q.takesOf && m.deletingAt === null))
const ikey = (provider: string, subject: string) => `${provider}\n${subject}`
const live = (leaseUntil: string | null, now: string) => leaseUntil !== null && leaseUntil > now
const activeDpub = (
  state: State,
  k: Pick<DestinationPublicationRow, 'jobId' | 'versionN' | 'kind' | 'destinationId' | 'targetKey'>,
  except?: string,
) =>
  [...state.dpubs.values()].find(
    (p) =>
      p.id !== except &&
      p.desired === 'published' &&
      p.jobId === k.jobId &&
      p.versionN === k.versionN &&
      p.kind === k.kind &&
      (p.destinationId ?? '') === (k.destinationId ?? '') &&
      p.targetKey === k.targetKey,
  )
/** Applies a patch to the row at `k`, if there is one. */
const patchRow = <T extends object>(m: Map<string, T>, k: string, patch: Partial<T>) => {
  const r = m.get(k)
  if (r) Object.assign(r, clone(patch))
}
/** Deletes the entries `drop` picks and returns how many. */
const deleteWhere = <T>(m: Map<string, T>, drop: (v: T, k: string) => boolean) => {
  let n = 0
  for (const [k, v] of m)
    if (drop(v, k)) {
      m.delete(k)
      n++
    }
  return n
}

export function createMemoryStore(): Store & { reset(): void; dump(): State } {
  let state = empty()
  let chain: Promise<unknown> = Promise.resolve()
  // Which transaction a call runs in: a nested call joins it, while a concurrent one (another request, sweep or GC)
  // waits its turn, the way a row lock would make it wait on Postgres.
  const txScope = new AsyncLocalStorage<{ open: boolean }>()
  // Take upload sessions not yet completed: they hold quota and count toward the rate limit until their media row does.
  const openTakeSessions = (uploaderId: string) =>
    [...state.uploads.values()].filter(
      (u) => u.uploaderId === uploaderId && u.status === 'open' && isTakeRole(u.role),
    )

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
    updateUser: async (id, patch) => patchRow(state.users, id, patch),
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
    updateKey: async (id, patch) => patchRow(state.keys, id, patch),

    insertJob: async (row) => {
      if (state.jobs.has(row.id)) throw new Error(`duplicate job ${row.id}`)
      state.jobs.set(row.id, clone(row))
    },
    getJob: async (id) => clone(state.jobs.get(id) ?? null),
    updateJob: async (id, patch) => patchRow(state.jobs, id, patch),
    listJobs: async (q: JobQuery) => {
      const published = new Set([
        ...[...state.publications.values()].filter((p) => p.unpublishedAt === null).map((p) => p.jobId),
        ...[...state.dpubs.values()].filter((p) => p.status === 'live').map((p) => p.jobId),
      ])
      const needle = q.q?.toLowerCase()
      let rows = [...state.jobs.values()].filter((j) => j.deletedAt === null)
      if (q.ownerId) rows = rows.filter((j) => j.ownerId === q.ownerId)
      const vis = q.visibleTo
      if (vis && !vis.all) rows = rows.filter((j) => !j.private || j.ownerId === vis.userId)
      if (q.status) rows = rows.filter((j) => j.status === q.status)
      if (q.externalRef !== undefined) rows = rows.filter((j) => j.externalRef === q.externalRef)
      const { tag, withoutTag } = q
      if (tag) rows = rows.filter((j) => (j.tags ?? []).includes(tag))
      if (withoutTag) rows = rows.filter((j) => !(j.tags ?? []).includes(withoutTag))
      if (q.published !== undefined) rows = rows.filter((j) => published.has(j.id) === q.published)
      const fav = q.favoriteOf
      if (fav) rows = rows.filter((j) => state.favorites.has(`${fav}/${j.id}`))
      if (needle) {
        rows = rows.filter(
          (j) =>
            j.title.toLowerCase().includes(needle) ||
            [...state.versions.values()].some(
              (v) => v.jobId === j.id && v.prompt.toLowerCase().includes(needle),
            ),
        )
      }
      rows.sort(newestFirst)
      if (q.cursor) {
        const c = q.cursor
        rows = rows.filter((j) => olderThan(j, c))
      }
      return clone(rows.slice(0, q.limit))
    },
    insertVersion: async (row) => {
      const k = vkey(row.jobId, row.n)
      if (state.versions.has(k)) throw new Error(`duplicate version ${k}`)
      // Postgres fills the column default; so does the memory store.
      state.versions.set(k, clone({ ...row, engine: row.engine ?? 'hyperframes' }))
    },
    getVersion: async (jobId, n) => clone(state.versions.get(vkey(jobId, n)) ?? null),
    listVersions: async (jobId) =>
      clone([...state.versions.values()].filter((v) => v.jobId === jobId).sort((a, b) => b.n - a.n)),
    updateVersion: async (jobId, n, patch) => patchRow(state.versions, vkey(jobId, n), patch),

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
    updatePublication: async (slug, patch) => patchRow(state.publications, slug, patch),

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
    deleteExpiredPlans: async (now) => deleteWhere(state.plans, (p) => p.expiresAt <= now),
    deleteExpiredIdempotency: async (now) => deleteWhere(state.idem, (v) => v.expiresAt <= now),

    insertComment: async (row) => {
      state.comments.set(row.id, clone(row))
    },
    getComment: async (id) => clone(state.comments.get(id) ?? null),
    updateComment: async (id, patch) => patchRow(state.comments, id, patch),
    listComments: async (jobId, n) =>
      clone(
        [...state.comments.values()]
          .filter((c) => c.jobId === jobId && c.deletedAt === null && (n === undefined || c.versionN === n))
          .sort(oldestFirst),
      ),
    insertPlan: async (row) => {
      state.plans.set(row.id, clone(row))
    },
    getPlan: async (id) => clone(state.plans.get(id) ?? null),
    updatePlan: async (id, patch) => patchRow(state.plans, id, patch),
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
          .sort(newestFirst)
          .filter((n) => !b || olderThan(n, b))
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
    updateMedia: async (id, patch) => patchRow(state.media, id, patch),
    findMediaMatches: async (q) =>
      clone(
        [...state.media.values()]
          .filter(
            (m) =>
              libraryVisible(m, q) &&
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
              libraryVisible(m, q) &&
              (q.recordings === 'only'
                ? isTakeRole(m.role)
                : q.recordings !== 'exclude' || !isTakeRole(m.role)) &&
              (!q.kind || m.kind === q.kind) &&
              searchWords(q.search).every((w) =>
                [m.title, m.filename, m.caption, m.sourceTitle, m.creator].some((f) =>
                  f?.toLowerCase().includes(w.toLowerCase()),
                ),
              ) &&
              (!q.before || (q.sort ?? 'newest') !== 'newest' || olderThan(m, q.before)),
          )
          .sort((a, b) =>
            q.sort === 'oldest'
              ? oldestFirst(a, b)
              : q.sort === 'name'
                ? (a.title ?? a.filename)
                    .toLowerCase()
                    .localeCompare((b.title ?? b.filename).toLowerCase()) || a.id.localeCompare(b.id)
                : newestFirst(a, b),
          )
          .slice(0, q.limit),
      ),
    insertUpload: async (row) => {
      state.uploads.set(row.id, clone(row))
    },
    getUpload: async (id) => clone(state.uploads.get(id) ?? null),
    updateUpload: async (id, patch) => patchRow(state.uploads, id, patch),
    deleteUpload: async (id) => {
      state.uploads.delete(id)
    },
    reservedUploadBytes: async (uploaderId) =>
      [...state.uploads.values()]
        .filter((u) => u.uploaderId === uploaderId && (u.status === 'open' || u.status === 'assembling'))
        .reduce((s, u) => s + u.size, 0),
    countOpenUploads: async (uploaderId) =>
      [...state.uploads.values()].filter(
        (u) => u.uploaderId === uploaderId && (u.status === 'open' || u.status === 'assembling'),
      ).length,
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
      deleteWhere(state.uploadParts, (_p, k) => k.startsWith(`${uploadId}/`))
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
    updateOpenverseJob: async (id, patch) => patchRow(state.openverseJobs, id, patch),
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
    deleteExpiredOpenverseJobs: async (now) => deleteWhere(state.openverseJobs, (j) => j.expiresAt <= now),
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
    deleteOpenverseSearchUses: async (beforeDay) =>
      deleteWhere(state.openverseSearchUses, (u) => u.day < beforeDay),
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
    deleteMediaRefs: async (ownerKind, ownerId, mediaIds) =>
      deleteWhere(
        state.mediaRefs,
        (r) =>
          r.ownerKind === ownerKind && r.ownerId === ownerId && (!mediaIds || mediaIds.includes(r.mediaId)),
      ),
    listMediaRefsByMedia: async (ids) =>
      clone([...state.mediaRefs.values()].filter((r) => ids.includes(r.mediaId)).sort(byCreated)),
    listMediaRefsByOwner: async (ownerKind, ownerId) =>
      clone(
        [...state.mediaRefs.values()]
          .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
          .sort(byCreated),
      ),
    listVideoTakes: async (jobId, limit) => {
      const used = new Set(
        [...state.mediaRefs.values()].filter((r) => r.jobId === jobId).map((r) => r.mediaId),
      )
      return clone(
        [...state.media.values()]
          .filter(
            (m) =>
              isTakeRole(m.role) &&
              !m.deletedAt &&
              m.deletingAt === null &&
              (m.scopeJobId === jobId || used.has(m.id)),
          )
          .sort(newestFirst)
          .slice(0, limit),
      )
    },
    listUnreferencedTakes: async (q) => {
      const held = new Set([...state.mediaRefs.values()].map((r) => r.mediaId))
      return clone(
        [...state.media.values()]
          .filter(
            (m) =>
              isTakeRole(m.role) &&
              m.deletingAt === null &&
              !held.has(m.id) &&
              (!q.uploaderId || m.uploaderId === q.uploaderId) &&
              (!q.due ||
                (m.retainUntil !== null ? m.retainUntil <= q.due.now : m.createdAt <= q.due.createdBefore)),
          )
          .sort(oldestFirst)
          .slice(0, q.limit),
      )
    },
    getNarrationLock: async (jobId) => clone(state.narrationLocks.get(jobId) ?? null),
    upsertNarrationLock: async (row) => {
      state.narrationLocks.set(row.jobId, clone(row))
    },
    acquireNarrationLock: async (row, staleBefore) => {
      const was = state.narrationLocks.get(row.jobId)
      const mine = was?.holderId === row.holderId
      if (was && !mine && was.heartbeatAt >= staleBefore) return false
      state.narrationLocks.set(row.jobId, clone(mine ? { ...row, acquiredAt: was.acquiredAt } : row))
      return true
    },
    deleteNarrationLock: async (jobId) => {
      state.narrationLocks.delete(jobId)
    },
    releaseNarrationLock: async (jobId, holderId) => {
      if (state.narrationLocks.get(jobId)?.holderId !== holderId) return false
      state.narrationLocks.delete(jobId)
      return true
    },
    deleteStaleNarrationLocks: async (before) =>
      deleteWhere(state.narrationLocks, (l) => l.heartbeatAt < before),
    mediaUsage: async (ids) => {
      const out: Record<string, string[]> = {}
      const versionRefs = [...state.mediaRefs.values()].filter((r) => r.ownerKind === 'version')
      for (const r of [...state.versionMedia, ...versionRefs])
        if (ids.includes(r.mediaId) && !(out[r.mediaId] ??= []).includes(r.jobId))
          out[r.mediaId]?.push(r.jobId)
      return out
    },
    listUnusedRecordings: async (q) =>
      [...state.media.values()]
        .filter(
          (m) =>
            m.role === 'screen-recording' &&
            !m.deletedAt &&
            !m.deletingAt &&
            (!q.uploaderId || m.uploaderId === q.uploaderId) &&
            !state.versionMedia.some(
              (r) => r.mediaId === m.id && state.jobs.get(r.jobId)?.deletedAt === null,
            ),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, q.limit)
        .map((m) => ({ row: clone(m), everUsed: state.versionMedia.some((r) => r.mediaId === m.id) })),
    screenRecordingBytes: async (uploaderId) =>
      [...state.media.values()]
        .filter(
          (m) =>
            m.uploaderId === uploaderId &&
            m.role === 'screen-recording' &&
            m.status !== 'rejected' &&
            !m.deletingAt &&
            !m.deletedAt,
        )
        .reduce((n, m) => n + m.bytes, 0) +
      [...state.uploads.values()]
        .filter((u) => u.uploaderId === uploaderId && u.status === 'open' && u.role === 'screen-recording')
        .reduce((n, u) => n + u.size, 0),
    recentTraceWrites: async (uploaderId, since) =>
      [...state.media.values()]
        .filter((m) => m.uploaderId === uploaderId)
        .flatMap((m) => m.traceWrites ?? [])
        .filter((t) => t >= since)
        .sort(),
    jobsUsingMedia: async (mediaId) =>
      state.versionMedia
        .filter((r) => r.mediaId === mediaId && state.jobs.get(r.jobId)?.deletedAt === null)
        .map((r) => ({ jobId: r.jobId, versionN: r.versionN }))
        .sort((a, b) => a.jobId.localeCompare(b.jobId) || a.versionN - b.versionN),
    mediaBySource: async (source, ids) =>
      clone(
        [...state.media.values()]
          .filter(
            (m) => m.source === source && m.sourceId !== null && ids.includes(m.sourceId) && !m.deletedAt,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    versionProvenance: async (jobId) => provenanceOf(state, (id) => id === jobId).map(withoutJob),
    insertEdit: async (row) => {
      state.edits.set(row.id, clone(row))
    },
    getEdit: async (id) => clone(state.edits.get(id) ?? null),
    updateEdit: async (id, patch) => patchRow(state.edits, id, patch),
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
        provenance: provenanceOf(state, has),
        owners,
        destinationPublications: clone(
          [...state.dpubs.values()]
            .filter((p) => has(p.jobId))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
        ),
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
    setFavorite: async (userId, jobId, on, at) => {
      const k = `${userId}/${jobId}`
      if (!on) state.favorites.delete(k)
      else if (!state.favorites.has(k)) state.favorites.set(k, at)
    },
    favoriteJobIds: async (userId, jobIds) => jobIds.filter((id) => state.favorites.has(`${userId}/${id}`)),
    tagCounts: async (vis) => {
      const counts = new Map<string, number>()
      for (const j of state.jobs.values()) {
        if (j.deletedAt !== null || (!vis.all && j.private && j.ownerId !== vis.userId)) continue
        for (const tag of j.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      return [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
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
    updateWebhookDelivery: async (id, patch) => patchRow(state.deliveries, id, patch),
    listDestinations: async () =>
      clone([...state.destinations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
    getDestination: async (id) => clone(state.destinations.get(id) ?? null),
    insertDestination: async (row) => {
      state.destinations.set(row.id, clone(row))
    },
    updateDestination: async (id, patch) => patchRow(state.destinations, id, patch),
    deleteDestination: async (id) => {
      state.destinations.delete(id)
    },
    getDestinationConnection: async (id) => clone(state.connections.get(id) ?? null),
    getUserConnection: async (userId, kind) =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- one connection kind today; more later
      clone([...state.connections.values()].find((c) => c.userId === userId && c.kind === kind) ?? null),
    listUserConnections: async (userId) =>
      clone([...state.connections.values()].filter((c) => c.userId === userId)),
    putDestinationConnection: async (row) => {
      for (const [k, c] of state.connections) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- one connection kind today; more later
        if (c.userId === row.userId && c.kind === row.kind) state.connections.delete(k)
      }
      state.connections.set(row.id, clone(row))
    },
    updateDestinationConnection: async (id, patch) => patchRow(state.connections, id, patch),
    deleteDestinationConnection: async (id) => {
      state.connections.delete(id)
    },
    insertDestinationPublication: async (row) => {
      if (row.desired === 'published' && activeDpub(state, row)) {
        throw new ApiError('conflict', 'This version is already published there.')
      }
      state.dpubs.set(row.id, clone(row))
    },
    getDestinationPublication: async (id) => clone(state.dpubs.get(id) ?? null),
    listDestinationPublications: async (jobId) =>
      clone(
        [...state.dpubs.values()]
          .filter((p) => p.jobId === jobId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      ),
    listDestinationPublicationsFor: async (destinationId) =>
      clone([...state.dpubs.values()].filter((p) => p.destinationId === destinationId)),
    findActiveDestinationPublication: async (k) => clone(activeDpub(state, k) ?? null),
    updateDestinationPublication: async (id, patch) => {
      const cur = state.dpubs.get(id)
      if (!cur) return
      const next = { ...cur, ...clone(patch) }
      if (next.desired === 'published' && cur.desired !== 'published' && activeDpub(state, next, id)) {
        throw new ApiError('conflict', 'This version is already published there.')
      }
      state.dpubs.set(id, next)
    },
    claimDestinationPublication: async (id, now, leaseUntil) => {
      const p = state.dpubs.get(id)
      if (!p || live(p.leaseUntil, now)) return null
      p.leaseUntil = leaseUntil
      p.leaseFence += 1
      return clone(p)
    },
    commitDestinationPublication: async (id, f, patch) => {
      const p = state.dpubs.get(id)
      if (!p || p.leaseFence !== f.fence || p.generation !== f.generation || p.desired !== f.desired)
        return false
      Object.assign(p, clone(patch))
      return true
    },
    listDueDestinationPublications: async (now, limit) =>
      clone(
        [...state.dpubs.values()]
          .filter(
            (p) =>
              ['queued', 'running', 'waiting', 'removing'].includes(p.status) &&
              !live(p.leaseUntil, now) &&
              ((p.nextRunAt !== null && p.nextRunAt <= now) || p.deadlineAt <= now),
          )
          .sort((a, b) => (a.nextRunAt ?? a.deadlineAt).localeCompare(b.nextRunAt ?? b.deadlineAt))
          .slice(0, limit),
      ),
    listExpiredSecrets: async (now, limit) =>
      clone(
        [...state.dpubs.values()]
          .filter(
            (p) => p.secretOnceEnc !== null && p.secretOnceExpiresAt !== null && p.secretOnceExpiresAt <= now,
          )
          .slice(0, limit),
      ),
    consumeSecretOnce: async (id, userId, now) => {
      const p = state.dpubs.get(id)
      if (
        !p ||
        p.publishedBy !== userId ||
        p.secretOnceEnc === null ||
        p.secretOnceConsumedAt !== null ||
        p.secretOnceExpiresAt === null ||
        p.secretOnceExpiresAt <= now
      )
        return null
      const out = { label: p.secretOnceLabel ?? 'Secret', valueEnc: p.secretOnceEnc }
      p.secretOnceEnc = null
      p.secretOnceConsumedAt = now
      return out
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
    updateCleanup: async (id, patch) => patchRow(state.cleanup, id, patch),

    engineRendersSince: async (since) =>
      clone(
        [...state.attempts.values()]
          .filter((a) => a.endedAt !== null && a.endedAt >= since && a.engineRenders)
          .map((a) => a.engineRenders as { video: number; stills: number; audio: number }),
      ),
    latestEngineAttempt: async (engine) => {
      let latest: AttemptRow | null = null
      for (const a of state.attempts.values()) {
        if (a.endedAt === null || (latest?.endedAt ?? '') > a.endedAt) continue
        if ((state.versions.get(vkey(a.jobId, a.versionN))?.engine ?? 'hyperframes') === engine) latest = a
      }
      return latest?.endedAt
        ? { stage: latest.stage, errorCategory: latest.errorCategory, endedAt: latest.endedAt }
        : null
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
    insertCliLogin: async (row) => {
      state.cliLogins.set(row.id, clone(row))
    },
    getCliLogin: async (id) => clone(state.cliLogins.get(id) ?? null),
    findPendingCliLogin: async (userCode, now) =>
      clone(
        [...state.cliLogins.values()].find(
          (l) => l.userCode === userCode && l.status === 'pending' && l.expiresAt > now,
        ) ?? null,
      ),
    updateCliLogin: async (id, patch) => patchRow(state.cliLogins, id, patch),
    countPendingCliLogins: async (now, clientIp) =>
      [...state.cliLogins.values()].filter(
        (l) =>
          l.status === 'pending' && l.expiresAt > now && (clientIp === undefined || l.clientIp === clientIp),
      ).length,
    countCliLoginApprovals: async (userId, since) =>
      [...state.cliLogins.values()].filter(
        (l) => l.userId === userId && l.approvedAt !== null && l.approvedAt >= since,
      ).length,
    insertCliLoginFailure: async (row) => {
      state.cliLoginFailures.set(row.id, clone(row))
    },
    countCliLoginFailures: async (userId, since) =>
      [...state.cliLoginFailures.values()].filter((f) => f.userId === userId && f.createdAt >= since).length,
    sweepCliLogins: async (now, deleteBefore, failuresBefore) => {
      let n = 0
      for (const l of state.cliLogins.values())
        if (l.status === 'pending' && l.expiresAt <= now) {
          l.status = 'expired'
          n++
        }
      n += deleteWhere(state.cliLogins, (l) => l.expiresAt < deleteBefore)
      return n + deleteWhere(state.cliLoginFailures, (f) => f.createdAt < failuresBefore)
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
    updateOAuthRequest: async (id, patch) => patchRow(state.oauthRequests, id, patch),
    insertOAuthGrant: async (row) => {
      state.oauthGrants.set(row.id, clone(row))
    },
    getOAuthGrant: async (id) => clone(state.oauthGrants.get(id) ?? null),
    listOAuthGrants: async (userId, now) =>
      clone(
        [...state.oauthGrants.values()]
          .filter((g) => g.userId === userId && g.revokedAt === null && g.expiresAt > now)
          .sort(newestFirst),
      ),
    updateOAuthGrant: async (id, patch) => patchRow(state.oauthGrants, id, patch),
    revokeOAuthGrants: async (userId, at) => {
      for (const g of state.oauthGrants.values())
        if (g.userId === userId && g.revokedAt === null) g.revokedAt = at
    },
    insertOAuthToken: async (row) => {
      state.oauthTokens.set(row.hash, clone(row))
    },
    getOAuthToken: async (hash) => clone(state.oauthTokens.get(hash) ?? null),
    updateOAuthToken: async (hash, patch) => patchRow(state.oauthTokens, hash, patch),
    deleteExpiredOAuth: async (now, clientsBefore) => {
      let n = deleteWhere(state.oauthRequests, (r) => r.expiresAt <= now)
      n += deleteWhere(state.oauthGrants, (g) => g.revokedAt !== null || g.expiresAt <= now)
      n += deleteWhere(state.oauthTokens, (t) => t.expiresAt <= now || !state.oauthGrants.has(t.grantId))
      const used = new Set([
        ...[...state.oauthGrants.values()].map((g) => g.clientId),
        ...[...state.oauthRequests.values()].map((r) => r.clientId),
      ])
      return n + deleteWhere(state.oauthClients, (c, id) => c.createdAt < clientsBefore && !used.has(id))
    },
    getUserIdentity: async (provider, subject) =>
      clone(state.identities.get(ikey(provider, subject)) ?? null),
    insertUserIdentityIfAbsent: async (row) => {
      const k = ikey(row.provider, row.subject)
      if (!state.identities.has(k)) state.identities.set(k, clone(row))
      return clone(state.identities.get(k) as UserIdentityRow)
    },
    updateUserIdentity: async (provider, subject, patch) =>
      patchRow(state.identities, ikey(provider, subject), patch),
    listUserIdentities: async () => clone([...state.identities.values()]),
    insertSession: async (row) => {
      state.sessions.set(row.id, clone(row))
    },
    getSession: async (id) => clone(state.sessions.get(id) ?? null),
    updateSession: async (id, patch) => patchRow(state.sessions, id, patch),
    revokeUserSessions: async (userId, at) => {
      for (const r of state.sessions.values())
        if (r.userId === userId && r.revokedAt === null) r.revokedAt = at
    },
    deleteExpiredSessions: async (now) =>
      deleteWhere(state.sessions, (r) => r.revokedAt !== null || r.expiresAt <= now),
    mergeUser: async (from, into) => {
      const swap = (v: string) => (v === from ? into : v)
      for (const k of state.keys.values()) k.ownerId = swap(k.ownerId)
      for (const j of state.jobs.values()) j.ownerId = swap(j.ownerId)
      for (const v of state.versions.values()) v.authorId = swap(v.authorId)
      for (const p of state.publications.values()) p.publishedBy = swap(p.publishedBy)
      for (const p of state.dpubs.values()) p.publishedBy = swap(p.publishedBy)
      for (const c of [...state.connections.values()]) {
        if (c.userId !== from) continue
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- one connection kind today; more later
        if ([...state.connections.values()].some((x) => x.userId === into && x.kind === c.kind))
          state.connections.delete(c.id)
        else c.userId = into
      }
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
      for (const [k, at] of [...state.favorites]) {
        if (!k.startsWith(`${from}/`)) continue
        state.favorites.delete(k)
        const nk = `${into}/${k.slice(from.length + 1)}`
        if (!state.favorites.has(nk)) state.favorites.set(nk, at)
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

    narrationTakeBytes: async (uploaderId) =>
      [...state.media.values()]
        .filter(
          (m) =>
            m.uploaderId === uploaderId && isTakeRole(m.role) && m.status !== 'rejected' && !m.deletingAt,
        )
        .reduce((n, m) => n + m.bytes, 0) + openTakeSessions(uploaderId).reduce((n, u) => n + u.size, 0),
    countRoleUploads: async (uploaderId, roles, since) =>
      [...state.media.values()].filter(
        (m) =>
          m.uploaderId === uploaderId && m.role !== null && roles.includes(m.role) && m.createdAt >= since,
      ).length +
      [...state.uploads.values()].filter(
        (u) =>
          u.uploaderId === uploaderId &&
          u.status === 'open' &&
          u.role !== null &&
          roles.includes(u.role) &&
          u.createdAt >= since,
      ).length,
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

/**
 * Credited library items per version: version_media rows, then the library audio a version's recorded narration
 * plays (media_refs `version` references, owner `<job>#<n>`; recordings, which have a take role, are left out).
 */
function provenanceOf(state: State, has: (jobId: string) => boolean) {
  const media = state.versionMedia
    .filter((r) => has(r.jobId))
    .sort((a, b) => a.versionN - b.versionN || a.position - b.position)
    .flatMap((r) => {
      const m = state.media.get(r.mediaId)
      if (!m?.source) return []
      const { jobId, versionN, mediaId, position, kind } = r
      return [{ jobId, versionN, mediaId, position, kind, ...pickProvenance(m) }]
    })
  const narration = [...state.mediaRefs.values()]
    .filter((r) => r.ownerKind === 'version' && has(r.jobId))
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.mediaId.localeCompare(b.mediaId))
    .flatMap((r) => {
      const m = state.media.get(r.mediaId)
      if (!m?.source || isTakeRole(m.role)) return []
      const versionN = Number(r.ownerId.slice(r.ownerId.lastIndexOf('#') + 1))
      return [
        {
          jobId: r.jobId,
          versionN,
          mediaId: m.id,
          position: 0,
          kind: m.kind,
          narration: true,
          ...pickProvenance(m),
        },
      ]
    })
  return byVersion([...media, ...narration] as (VersionProvenanceRow & { jobId: string })[])
}

export const withoutJob = <T extends { jobId: string }>(r: T): Omit<T, 'jobId'> => {
  const row: Partial<T> = { ...r }
  delete row.jobId
  return row as Omit<T, 'jobId'>
}
/** version_media rows first, then narration ones, each version in turn. */
export const byVersion = <T extends VersionProvenanceRow>(rows: T[]) =>
  rows.sort(
    (a, b) =>
      a.versionN - b.versionN || Number(!!a.narration) - Number(!!b.narration) || a.position - b.position,
  )

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
