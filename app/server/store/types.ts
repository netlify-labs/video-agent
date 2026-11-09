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
  MediaRole,
  MediaRow,
  MediaUploadRow,
  MediaUploadPartRow,
  OpenverseJobRow,
  OpenverseJobKind,
  OpenverseJobStatus,
  OpenverseSearchRow,
  VersionMediaRow,
  MediaRefRow,
  MediaRefOwnerKind,
  NarrationLockRow,
  VersionProvenanceRow,
  GatewayCallRow,
  WebhookDeliveryRow,
  UserWebhookRow,
  OAuthClientRow,
  OAuthRequestRow,
  CliLoginRow,
  CliLoginFailureRow,
  OAuthGrantRow,
  OAuthTokenRow,
  SessionRow,
  UserIdentityRow,
  DestinationRow,
  DestinationConnectionRow,
  DestinationPublicationRow,
} from '../domain/types.js'

export interface JobQuery {
  ownerId?: string
  status?: VersionStatus
  published?: boolean
  /** Only videos this person starred. */
  favoriteOf?: string
  q?: string
  /** Exact match on the video's externalRef. */
  externalRef?: string
  /** Only videos that carry this tag. */
  tag?: string
  /** Leave out videos that carry this tag. */
  withoutTag?: string
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
  destinationPublications: DestinationPublicationRow[]
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
  /** Locks these rows for the rest of the transaction (SELECT … FOR UPDATE) in id order; missing ids are skipped. */
  lockMedia(ids: string[]): Promise<MediaRow[]>
  updateMedia(id: string, patch: Partial<MediaRow>): Promise<void>
  /**
   * Newest first: ready, undeleted items, plus `includePendingOf`'s own items in any state. Narration takes are left
   * out, except `takesOf`'s own that GC isn't deleting.
   */
  listMedia(q: {
    kind?: MediaRow['kind'] | undefined
    /** Words that must all appear in the title, file name, notes, source title or creator (any case). */
    search?: string | undefined
    /** Newest first by default; `before` pages only that order. */
    sort?: 'newest' | 'oldest' | 'name' | undefined
    includePendingOf?: string | undefined
    takesOf?: string | undefined
    /** Narration takes only (`takesOf`'s own), or none of them; by default they're listed with the rest. */
    recordings?: 'only' | 'exclude' | undefined
    before?: { createdAt: string; id: string } | undefined
    limit: number
  }): Promise<MediaRow[]>
  /**
   * Undeleted items (ready, or `includePendingOf`'s own) with one of these hashes or file names, for duplicates.
   * Narration takes are left out, except `takesOf`'s own that GC isn't deleting.
   */
  findMediaMatches(q: {
    sha256s: string[]
    filenames: string[]
    includePendingOf: string
    takesOf?: string | undefined
  }): Promise<MediaRow[]>
  insertUpload(row: MediaUploadRow): Promise<void>
  getUpload(id: string, opts?: { lock?: boolean }): Promise<MediaUploadRow | null>
  updateUpload(id: string, patch: Partial<MediaUploadRow>): Promise<void>
  deleteUpload(id: string): Promise<void>
  /** Bytes reserved by the person's open and assembling sessions. */
  reservedUploadBytes(uploaderId: string): Promise<number>
  /** The person's upload sessions still open or assembling (named when the in-flight reservation is full). */
  countOpenUploads(uploaderId: string): Promise<number>
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
  /** Adds references to narration takes; one that already exists is left as it is. */
  insertMediaRefs(rows: MediaRefRow[]): Promise<void>
  /** Removes the owner's references (all of them, or only to these media ids); returns how many went. */
  deleteMediaRefs(ownerKind: MediaRefOwnerKind, ownerId: string, mediaIds?: string[]): Promise<number>
  /** Every reference to these media ids, oldest first. */
  listMediaRefsByMedia(mediaIds: string[]): Promise<MediaRefRow[]>
  /** The media ids an owner references, oldest first. */
  listMediaRefsByOwner(ownerKind: MediaRefOwnerKind, ownerId: string): Promise<MediaRefRow[]>
  /**
   * Narration takes no media_refs row holds and GC hasn't begun deleting, oldest first: one person's (`uploaderId`),
   * and/or only those whose retention passed (`due`: retain_until at or before `now`, or, with none set, created at or
   * before `createdBefore`).
   */
  listUnreferencedTakes(q: {
    uploaderId?: string
    due?: { now: string; createdBefore: string }
    limit: number
  }): Promise<MediaRow[]>
  /**
   * A video's narration takes, newest first: undeleted ones GC isn't deleting that were made for it (scope_job_id)
   * or that a draft, attempt or version of it references. Who may read each is canReadTake's call, not this one's.
   */
  listVideoTakes(jobId: string, limit: number): Promise<MediaRow[]>
  /** With `lock`, SELECT … FOR UPDATE (inside a transaction). */
  getNarrationLock(jobId: string, opts?: { lock?: boolean }): Promise<NarrationLockRow | null>
  /** Inserts or replaces the video's lock. */
  upsertNarrationLock(row: NarrationLockRow): Promise<void>
  /**
   * Acquire or heartbeat, as one conditional upsert: takes the lock when there is none, its heartbeat is older than
   * `staleBefore`, or `row.holderId` already holds it (which keeps its acquiredAt). False when someone else holds it.
   */
  acquireNarrationLock(row: NarrationLockRow, staleBefore: string): Promise<boolean>
  deleteNarrationLock(jobId: string): Promise<void>
  /** Deletes the video's lock only if `holderId` holds it; true when it did. */
  releaseNarrationLock(jobId: string, holderId: string): Promise<boolean>
  /** Deletes locks whose last heartbeat is older than `before`; returns how many went. */
  deleteStaleNarrationLocks(before: string): Promise<number>
  /** Per media id, the distinct videos (job ids) whose versions use it. */
  mediaUsage(mediaIds: string[]): Promise<Record<string, string[]>>
  /**
   * Screen recordings no undeleted video uses, oldest first, that GC isn't deleting: each with `everUsed` (a version
   * of a since-deleted video listed it), so retention can start when the last using video went.
   */
  listUnusedRecordings(q: {
    uploaderId?: string
    limit: number
  }): Promise<{ row: MediaRow; everUsed: boolean }[]>
  /** The person's screen recordings' stored bytes (not rejected, not being deleted) plus open recording sessions. */
  screenRecordingBytes(uploaderId: string): Promise<number>
  /** Trace writes (media.trace_writes) at or after `since` over the person's own items (the trace rate limit). */
  recentTraceWrites(uploaderId: string, since: string): Promise<string[]>
  /** The versions of undeleted videos whose version_media lists this item (who may see a screen recording). */
  jobsUsingMedia(mediaId: string): Promise<{ jobId: string; versionN: number }[]>
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
  /** Stars or unstars a video for one person; idempotent. */
  setFavorite(userId: string, jobId: string, on: boolean, at: string): Promise<void>
  /** Which of these videos the person starred. */
  favoriteJobIds(userId: string, jobIds: string[]): Promise<string[]>
  /** The tags in use on videos this person can see, most used first. */
  tagCounts(visibleTo: { userId: string; all: boolean }): Promise<{ tag: string; count: number }[]>
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
  // Publish destinations (docs/plans/2026-11-04-publish-destinations.md §2.3-§2.4).
  listDestinations(): Promise<DestinationRow[]>
  getDestination(id: string): Promise<DestinationRow | null>
  insertDestination(row: DestinationRow): Promise<void>
  updateDestination(id: string, patch: Partial<DestinationRow>): Promise<void>
  deleteDestination(id: string): Promise<void>
  getDestinationConnection(id: string): Promise<DestinationConnectionRow | null>
  getUserConnection(
    userId: string,
    kind: DestinationConnectionRow['kind'],
  ): Promise<DestinationConnectionRow | null>
  listUserConnections(userId: string): Promise<DestinationConnectionRow[]>
  /** Inserts or replaces the person's connection of that kind. */
  putDestinationConnection(row: DestinationConnectionRow): Promise<void>
  updateDestinationConnection(id: string, patch: Partial<DestinationConnectionRow>): Promise<void>
  deleteDestinationConnection(id: string): Promise<void>
  /** Throws ApiError conflict when an active publication already holds the same (job, version, kind, destination,
   * target key). */
  insertDestinationPublication(row: DestinationPublicationRow): Promise<void>
  getDestinationPublication(id: string, opts?: { lock?: boolean }): Promise<DestinationPublicationRow | null>
  listDestinationPublications(jobId: string): Promise<DestinationPublicationRow[]>
  listDestinationPublicationsFor(destinationId: string): Promise<DestinationPublicationRow[]>
  /** The active publication holding that key, if any. */
  findActiveDestinationPublication(
    k: Pick<DestinationPublicationRow, 'jobId' | 'versionN' | 'kind' | 'destinationId' | 'targetKey'>,
  ): Promise<DestinationPublicationRow | null>
  /** Unconditional patch, for domain code that holds the job's lock (start, remove, retry). */
  updateDestinationPublication(id: string, patch: Partial<DestinationPublicationRow>): Promise<void>
  /** Takes the worker lease when no live lease exists: sets lease_until and increments lease_fence. */
  claimDestinationPublication(
    id: string,
    now: string,
    leaseUntil: string,
  ): Promise<DestinationPublicationRow | null>
  /** Applies the patch only if the fence, generation and desired still match; false = the row moved on. */
  commitDestinationPublication(
    id: string,
    f: PublicationFence,
    patch: Partial<DestinationPublicationRow>,
  ): Promise<boolean>
  /** Rows to dispatch (due, no live lease) or to expire (past their deadline), for the sweep. */
  listDueDestinationPublications(now: string, limit: number): Promise<DestinationPublicationRow[]>
  /** Rows whose one-time secret has expired and still has ciphertext. */
  listExpiredSecrets(now: string, limit: number): Promise<DestinationPublicationRow[]>
  /** Atomically consumes the one-time secret for its publisher; null if absent, consumed, expired or not theirs. */
  consumeSecretOnce(
    id: string,
    userId: string,
    now: string,
  ): Promise<{ label: string; valueEnc: string } | null>
  getUserWebhook(userId: string): Promise<UserWebhookRow | null>
  putUserWebhook(row: UserWebhookRow): Promise<void>
  deleteUserWebhook(userId: string): Promise<void>
  insertCleanup(row: CleanupRow): Promise<void>
  listDueCleanup(now: string, limit: number): Promise<CleanupRow[]>
  updateCleanup(id: string, patch: Partial<CleanupRow>): Promise<void>

  // video-agent login (cli-and-sdk plan §5.2)
  insertCliLogin(row: CliLoginRow): Promise<void>
  getCliLogin(id: string, opts?: { lock?: boolean }): Promise<CliLoginRow | null>
  /** The pending, unexpired login with this user code, if any. */
  findPendingCliLogin(userCode: string, now: string): Promise<CliLoginRow | null>
  updateCliLogin(id: string, patch: Partial<CliLoginRow>): Promise<void>
  /** Pending, unexpired logins, overall or from one client IP. */
  countPendingCliLogins(now: string, clientIp?: string): Promise<number>
  /** Logins this person approved since `since`. */
  countCliLoginApprovals(userId: string, since: string): Promise<number>
  insertCliLoginFailure(row: CliLoginFailureRow): Promise<void>
  countCliLoginFailures(userId: string, since: string): Promise<number>
  /** Marks pending logins past expiry expired; deletes logins expired before `deleteBefore` and older failures. */
  sweepCliLogins(now: string, deleteBefore: string, failuresBefore: string): Promise<number>

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

  // sign-in identities and web sessions (app/server/auth)
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
   * a row under the same key (a verdict, a read watermark, a favorite, a personal webhook), `intoId`'s is kept. Call in `tx`.
   */
  mergeUser(fromId: string, intoId: string): Promise<void>

  // stats
  usageSince(
    since: string,
  ): Promise<{ userId: string; week: string; credits: number | null; videos: number }[]>
  failuresSince(since: string): Promise<{ category: string; count: number }[]>
  /** Remotion render counts of attempts that ended at or after `since` (render-engines §7), failed ones included. */
  engineRendersSince(since: string): Promise<{ video: number; stills: number; audio: number }[]>
  /** The newest ended attempt of a version made with this engine (the /setup Engines row, render-engines §7). */
  latestEngineAttempt(
    engine: 'hyperframes' | 'remotion',
  ): Promise<{ stage: string; errorCategory: string | null; endedAt: string } | null>

  // narration take budgets (voice-over plan §8)
  /**
   * Bytes of the person's narration takes (media role narration-*) that are stored or being checked: uploading,
   * verifying or ready, plus the declared size of their open take upload sessions (which have no media row yet).
   * Rows GC has marked deleting count as freed.
   */
  narrationTakeBytes(uploaderId: string): Promise<number>
  /**
   * The person's media of these roles created at or after `since` (for a role's upload rate limit): media rows, plus
   * open upload sessions of those roles (a completed session is counted by its media row).
   */
  countRoleUploads(uploaderId: string, roles: readonly MediaRole[], since: string): Promise<number>
}

/** The fenced write a destination worker or callback makes (publish destinations §2.4). */
export interface PublicationFence {
  fence: number
  generation: number
  desired: DestinationPublicationRow['desired']
}

export interface Store extends Repo {
  /** Runs fn atomically. Nested calls reuse the outer transaction. */
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T>
}
