// Storage primitives. Domain logic composes these inside `tx` so the in-memory store (tests, spec
// generation) and the Postgres store (production) share one implementation of every rule.
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
  VersionStatus,
  WebhookEventRow,
  VerdictRow,
  OwnershipTransferRow,
  NotificationRow,
  PlanRow,
  CommentRow,
  GatewayCallRow,
  WebhookDeliveryRow,
  UserWebhookRow,
} from '../domain/types.js'

export interface JobQuery {
  ownerId?: string
  status?: VersionStatus
  published?: boolean
  q?: string
  cursor?: { createdAt: string; id: string }
  /** Private videos are returned only to their owner, unless `all` (admins). */
  visibleTo?: { userId: string; all: boolean }
  limit: number
}

export interface Repo {
  // settings
  getSettings(): Promise<SettingsRow | null>
  insertSettingsIfAbsent(row: SettingsRow): Promise<SettingsRow>
  updateSettings(patch: Partial<Omit<SettingsRow, 'id'>>): Promise<void>

  // users
  getUser(id: string): Promise<UserRow | null>
  insertUserIfAbsent(row: UserRow): Promise<UserRow>
  updateUser(id: string, patch: Partial<UserRow>): Promise<void>
  listUsers(): Promise<UserRow[]>

  // api keys
  insertKey(row: ApiKeyRow): Promise<void>
  getKey(id: string): Promise<ApiKeyRow | null>
  listKeys(ownerId: string): Promise<ApiKeyRow[]>
  updateKey(id: string, patch: Partial<ApiKeyRow>): Promise<void>

  // jobs and versions
  insertJob(row: JobRow): Promise<void>
  /** With lock, the row is locked for the rest of the transaction (SELECT … FOR UPDATE). */
  getJob(id: string, opts?: { lock?: boolean }): Promise<JobRow | null>
  updateJob(id: string, patch: Partial<JobRow>): Promise<void>
  listJobs(query: JobQuery): Promise<JobRow[]>
  insertVersion(row: VersionRow): Promise<void>
  getVersion(jobId: string, n: number): Promise<VersionRow | null>
  listVersions(jobId: string): Promise<VersionRow[]>
  updateVersion(jobId: string, n: number, patch: Partial<VersionRow>): Promise<void>

  // attempts
  insertAttempt(row: AttemptRow): Promise<void>
  getAttempt(id: string, opts?: { lock?: boolean }): Promise<AttemptRow | null>
  /** Returns false when `expectStage` is given and the current stage differs (lost race). */
  updateAttempt(id: string, patch: Partial<AttemptRow>, expectStage?: Stage): Promise<boolean>
  /** Atomically takes a lease when the stage matches and no live lease exists. */
  leaseAttempt(id: string, stage: Stage, now: string, until: string): Promise<boolean>
  latestAttempt(jobId: string, versionN: number): Promise<AttemptRow | null>
  listAttempts(jobId: string): Promise<AttemptRow[]>
  /** Non-terminal attempts with next_action_at <= now and no live lease, oldest first. */
  listDueAttempts(now: string, limit: number): Promise<AttemptRow[]>
  countSlotHolders(): Promise<number>
  /** Oldest queued attempt that is due, locked; skips rows locked by other transactions. */
  claimOldestQueued(now: string): Promise<AttemptRow | null>
  /** Locks the single queue-control row; every slot claim must call this first. */
  lockQueueControl(): Promise<void>
  listAttemptsByStage(stages: Stage[], limit: number): Promise<AttemptRow[]>

  // outputs and publications
  upsertOutput(row: OutputRow): Promise<void>
  getOutput(jobId: string, versionN: number): Promise<OutputRow | null>
  insertPublication(row: PublicationRow): Promise<void>
  getPublication(slug: string): Promise<PublicationRow | null>
  listPublications(jobId: string): Promise<PublicationRow[]>
  updatePublication(slug: string, patch: Partial<PublicationRow>): Promise<void>

  // callback receipts and idempotency
  getReceipt(attemptId: string): Promise<ReceiptRow | null>
  insertReceipt(row: ReceiptRow): Promise<void>
  getIdempotency(principalId: string, operation: string, key: string): Promise<IdempotencyRow | null>
  insertIdempotency(row: IdempotencyRow): Promise<void>
  deleteExpiredIdempotency(now: string): Promise<number>
  /** Deletes plan content past its expiry (gateway_calls, the usage record, is kept). */
  deleteExpiredPlans(now: string): Promise<number>

  // webhooks and cleanup
  insertComment(row: CommentRow): Promise<void>
  getComment(id: string): Promise<CommentRow | null>
  updateComment(id: string, patch: Partial<CommentRow>): Promise<void>
  /** Not deleted, oldest first; optionally one version. */
  listComments(jobId: string, versionN?: number): Promise<CommentRow[]>
  getCommentReadAt(userId: string, jobId: string): Promise<string | null>
  setCommentReadAt(userId: string, jobId: string, readAt: string): Promise<void>
  insertPlan(row: PlanRow): Promise<void>
  getPlan(id: string, opts?: { lock?: boolean }): Promise<PlanRow | null>
  updatePlan(id: string, patch: Partial<PlanRow>): Promise<void>
  insertGatewayCall(row: GatewayCallRow): Promise<void>
  listGatewayCalls(q: { since: string; callerId?: string }): Promise<GatewayCallRow[]>
  insertNotification(row: NotificationRow): Promise<void>
  /** Newest first; `before` is a createdAt|id cursor. */
  listNotifications(
    userId: string,
    q: { before?: { createdAt: string; id: string }; limit: number },
  ): Promise<NotificationRow[]>
  getNotificationReadAt(userId: string): Promise<string | null>
  setNotificationReadAt(userId: string, readAt: string): Promise<void>
  insertOwnershipTransfer(row: OwnershipTransferRow): Promise<void>
  listOwnershipTransfers(jobId: string): Promise<OwnershipTransferRow[]>
  // verdicts
  putVerdict(row: VerdictRow): Promise<void>
  deleteVerdict(jobId: string, versionN: number, userId: string): Promise<void>
  listVerdicts(jobIds: string[]): Promise<VerdictRow[]>
  insertWebhookEvent(row: WebhookEventRow): Promise<void>
  getWebhookEvent(eventId: string): Promise<WebhookEventRow | null>
  /** Ignores a duplicate (event, destination). */
  insertWebhookDelivery(row: WebhookDeliveryRow): Promise<void>
  /** Atomically leases up to `limit` due deliveries (skipping rows other sweeps hold) and returns them. */
  claimDueWebhookDeliveries(now: string, leaseUntil: string, limit: number): Promise<WebhookDeliveryRow[]>
  updateWebhookDelivery(id: string, patch: Partial<WebhookDeliveryRow>): Promise<void>
  getUserWebhook(userId: string): Promise<UserWebhookRow | null>
  putUserWebhook(row: UserWebhookRow): Promise<void>
  deleteUserWebhook(userId: string): Promise<void>
  insertCleanup(row: CleanupRow): Promise<void>
  listDueCleanup(now: string, limit: number): Promise<CleanupRow[]>
  updateCleanup(id: string, patch: Partial<CleanupRow>): Promise<void>

  // stats
  usageSince(
    since: string,
  ): Promise<{ userId: string; week: string; credits: number | null; videos: number }[]>
  failuresSince(since: string): Promise<{ category: string; count: number }[]>
}

export interface Store extends Repo {
  /** Runs fn atomically. Nested calls reuse the outer transaction. */
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T>
}
