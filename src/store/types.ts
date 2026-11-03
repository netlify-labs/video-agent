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
  VersionCommentRow,
  CheckpointRow,
  EditRow,
  MediaRow,
  MediaUploadRow,
  MediaUploadPartRow,
  OpenverseJobRow,
  OpenverseJobKind,
  OpenverseJobStatus,
  OpenverseSearchRow,
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

export interface CommentCounts {
  count: number
  unread: number
}

export interface VideoPageRows {
  jobs: JobRow[]
  versions: VersionRow[]
  attempts: AttemptRow[]
  publications: PublicationRow[]
  outputs: OutputRow[]
  versionComments: VersionCommentRow[]
  provenance: (VersionProvenanceRow & { jobId: string })[]
  owners: UserRow[]
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
  replaceReceipt(row: ReceiptRow): Promise<void>
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
  insertMedia(row: MediaRow): Promise<void>
  getMedia(id: string): Promise<MediaRow | null>
  updateMedia(id: string, patch: Partial<MediaRow>): Promise<void>
  /** Newest first: ready, undeleted items, plus `includePendingOf`'s own items in any state. */
  listMedia(q: {
    kind?: MediaRow['kind'] | undefined
    /** Words that must all appear in the title, file name, notes, source title or creator (any case). */
    search?: string | undefined
    /** Newest first by default; `before` pages only that order. */
    sort?: 'newest' | 'oldest' | 'name' | undefined
    includePendingOf?: string | undefined
    before?: { createdAt: string; id: string } | undefined
    limit: number
  }): Promise<MediaRow[]>
  /** Undeleted items (ready, or `includePendingOf`'s own) with one of these hashes or file names, for duplicates. */
  findMediaMatches(q: {
    sha256s: string[]
    filenames: string[]
    includePendingOf: string
  }): Promise<MediaRow[]>
  insertUpload(row: MediaUploadRow): Promise<void>
  getUpload(id: string, opts?: { lock?: boolean }): Promise<MediaUploadRow | null>
  updateUpload(id: string, patch: Partial<MediaUploadRow>): Promise<void>
  deleteUpload(id: string): Promise<void>
  /** Bytes reserved by the person's open and assembling sessions. */
  reservedUploadBytes(uploaderId: string): Promise<number>
  listStaleUploads(now: string, limit: number): Promise<MediaUploadRow[]>
  getUploadPart(uploadId: string, idx: number): Promise<MediaUploadPartRow | null>
  insertUploadPart(row: MediaUploadPartRow): Promise<void>
  listUploadParts(uploadId: string): Promise<MediaUploadPartRow[]>
  deleteUploadParts(uploadId: string): Promise<void>
  /**
   * Inserts a job unless the same person already has a queued or running job for the same kind and key; returns the
   * stored row (that other job when there was one).
   */
  insertOpenverseJobIfAbsent(row: OpenverseJobRow): Promise<OpenverseJobRow>
  getOpenverseJob(id: string): Promise<OpenverseJobRow | null>
  /** The newest job for this kind and key in one of these states, updated at or after `since` (anyone's, or one person's). */
  findOpenverseJob(q: {
    kind: OpenverseJobKind
    key: string
    statuses: OpenverseJobStatus[]
    since: string
    userId?: string
  }): Promise<OpenverseJobRow | null>
  /** Jobs the person started at or after `since` (for the per-person rate limit). */
  countOpenverseJobs(userId: string, since: string): Promise<number>
  /** Moves a queued job to running; false when it isn't queued (another invocation took it, or it finished). */
  claimOpenverseJob(id: string, now: string): Promise<boolean>
  updateOpenverseJob(id: string, patch: Partial<OpenverseJobRow>): Promise<void>
  /** Queued jobs last touched before `queuedBefore` and running ones last touched before `runningBefore`. */
  listStaleOpenverseJobs(q: {
    queuedBefore: string
    runningBefore: string
    limit: number
  }): Promise<OpenverseJobRow[]>
  deleteExpiredOpenverseJobs(now: string): Promise<number>
  getOpenverseSearch(key: string): Promise<OpenverseSearchRow | null>
  /** Inserts or replaces the stored search for its key. */
  putOpenverseSearch(row: OpenverseSearchRow): Promise<void>
  /** Deletes searches fetched before `fetchedBefore`, then all but the `keep` most recently fetched. */
  deleteOldOpenverseSearches(q: { fetchedBefore: string; keep: number }): Promise<number>
  /** Counts one more use of a search on a UTC day (YYYY-MM-DD). */
  addOpenverseSearchUse(key: string, day: string): Promise<void>
  /** The most used searches on or after `sinceDay`, most used first. */
  topOpenverseSearches(sinceDay: string, limit: number): Promise<{ key: string; count: number }[]>
  deleteOpenverseSearchUses(beforeDay: string): Promise<number>
  insertVersionMedia(rows: VersionMediaRow[]): Promise<void>
  listVersionMedia(jobId: string, versionN: number): Promise<VersionMediaRow[]>
  /** Per media id, the distinct videos (job ids) whose versions use it. */
  mediaUsage(mediaIds: string[]): Promise<Record<string, string[]>>
  /** Undeleted items imported from `source` with one of these ids there, newest first. */
  mediaBySource(source: string, sourceIds: string[]): Promise<MediaRow[]>
  /** Every version's imported media (the item's provenance with the version and kind), in version order. */
  versionProvenance(jobId: string): Promise<VersionProvenanceRow[]>
  /**
   * Everything a page of videos shows, for all of them at once (a handful of queries instead of a dozen per video),
   * each list in the order its per-video method returns.
   */
  videoPage(jobIds: string[]): Promise<VideoPageRows>
  insertEdit(row: EditRow): Promise<void>
  getEdit(id: string, opts?: { lock?: boolean }): Promise<EditRow | null>
  updateEdit(id: string, patch: Partial<EditRow>): Promise<void>
  deleteEdit(id: string): Promise<void>
  /** The person's open (unrendered, unexpired) draft on a version, if any. */
  findEdit(authorId: string, jobId: string, baseN: number, now: string): Promise<EditRow | null>
  /** Expired drafts, oldest first (the sweep removes them and their bundles). */
  listExpiredEdits(now: string, limit: number): Promise<EditRow[]>
  getCheckpoint(attemptId: string, opts?: { lock?: boolean }): Promise<CheckpointRow | null>
  putCheckpoint(row: CheckpointRow): Promise<void>
  insertVersionComments(rows: VersionCommentRow[]): Promise<void>
  /** In position order; all versions of the video when `versionN` is left out. */
  listVersionComments(jobId: string, versionN?: number): Promise<VersionCommentRow[]>
  /** Marks the comments addressed in version n (only those still on this video and not deleted). */
  markCommentsAddressed(jobId: string, commentIds: string[], n: number): Promise<void>
  /** Per video: comments not deleted, and those by others newer than `userId`'s read watermark. */
  commentCounts(jobIds: string[], userId: string | null): Promise<Record<string, CommentCounts>>
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

  // MCP OAuth (used only when it's enabled)
  insertOAuthClient(row: OAuthClientRow): Promise<void>
  getOAuthClient(id: string): Promise<OAuthClientRow | null>
  insertOAuthRequest(row: OAuthRequestRow): Promise<void>
  getOAuthRequest(id: string): Promise<OAuthRequestRow | null>
  /** By consent secret or code hash. With lock, the row is locked for the rest of the transaction. */
  findOAuthRequest(
    by: { consentHash: string } | { codeHash: string },
    opts?: { lock?: boolean },
  ): Promise<OAuthRequestRow | null>
  updateOAuthRequest(id: string, patch: Partial<OAuthRequestRow>): Promise<void>
  insertOAuthGrant(row: OAuthGrantRow): Promise<void>
  getOAuthGrant(id: string): Promise<OAuthGrantRow | null>
  /** The person's grants that are neither revoked nor expired, newest first. */
  listOAuthGrants(userId: string, now: string): Promise<OAuthGrantRow[]>
  updateOAuthGrant(id: string, patch: Partial<OAuthGrantRow>): Promise<void>
  /** Revokes every live grant a person holds. */
  revokeOAuthGrants(userId: string, at: string): Promise<void>
  insertOAuthToken(row: OAuthTokenRow): Promise<void>
  getOAuthToken(hash: string, opts?: { lock?: boolean }): Promise<OAuthTokenRow | null>
  updateOAuthToken(hash: string, patch: Partial<OAuthTokenRow>): Promise<void>
  /**
   * Deletes expired requests and tokens, expired or revoked grants with their tokens, and registered clients
   * created before `clientsBefore` that no grant or request uses.
   */
  deleteExpiredOAuth(now: string, clientsBefore: string): Promise<number>

  // sign-in identities and web sessions (src/auth)
  getUserIdentity(provider: string, subject: string): Promise<UserIdentityRow | null>
  /** Returns the stored row, which is another person's when the (provider, subject) was already linked. */
  insertUserIdentityIfAbsent(row: UserIdentityRow): Promise<UserIdentityRow>
  updateUserIdentity(provider: string, subject: string, patch: Partial<UserIdentityRow>): Promise<void>
  listUserIdentities(): Promise<UserIdentityRow[]>
  insertSession(row: SessionRow): Promise<void>
  getSession(id: string): Promise<SessionRow | null>
  updateSession(id: string, patch: Partial<SessionRow>): Promise<void>
  /** Ends every live session a person holds. */
  revokeUserSessions(userId: string, at: string): Promise<void>
  /** Deletes expired and revoked sessions. */
  deleteExpiredSessions(now: string): Promise<number>
  /**
   * Moves everything `fromId` owns, wrote or holds to `intoId` and deletes the `fromId` user row. Where both have
   * a row under the same key (a verdict, a read watermark, a personal webhook), `intoId`'s is kept. Call in `tx`.
   */
  mergeUser(fromId: string, intoId: string): Promise<void>

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
