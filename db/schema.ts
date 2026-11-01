// Netlify Database schema (Drizzle). Migrations are generated into netlify/database/migrations.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Timestamps are ISO-8601 UTC strings (toISOString), which sort correctly as text.
const ts = (name: string) => text(name)

export const settings = pgTable('settings', {
  id: integer('id').primaryKey(),
  fileSigningSecret: text('file_signing_secret').notNull(),
  dataEncryptionKey: text('data_encryption_key').notNull(),
  queuePausedReason: text('queue_paused_reason'),
  createdAt: ts('created_at').notNull(),
  teamWebhookUrl: text('team_webhook_url'),
  teamWebhookSecretEnc: text('team_webhook_secret_enc'),
  planDeepModel: text('plan_deep_model'),
})

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').notNull(),
  admittedVia: text('admitted_via').notNull(),
  createdAt: ts('created_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull(),
  disabledAt: ts('disabled_at'),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    secretHash: text('secret_hash').notNull(),
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    createdAt: ts('created_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_keys_owner_idx').on(t.ownerId)],
)

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    aspect: text('aspect').notNull(),
    ownerId: text('owner_id').notNull(),
    status: text('status').notNull(),
    latestVersion: integer('latest_version').notNull(),
    nextVersionN: integer('next_version_n').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
    version: integer('version').notNull(),
    private: boolean('private').notNull().default(false),
    accessEpoch: integer('access_epoch').notNull().default(0),
  },
  (t) => [
    index('jobs_created_idx').on(t.createdAt, t.id),
    index('jobs_owner_idx').on(t.ownerId, t.createdAt),
  ],
)

export const versions = pgTable(
  'versions',
  {
    jobId: text('job_id').notNull(),
    n: integer('n').notNull(),
    prompt: text('prompt').notNull(),
    authorId: text('author_id').notNull(),
    apiKeyId: text('api_key_id'),
    // Seconds; a frame-accurate decimal for edited versions (plan v2 §14 rule 19).
    targetDurationSec: doublePrecision('target_duration_sec'),
    parentN: integer('parent_n'),
    webhookUrl: text('webhook_url'),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull(),
    // The accepted plan, frozen when the version was created (plan v2 §14 rule 15).
    plan: jsonb('plan'),
    // Editing contract version the finished composition conforms to (plan v2 §8); null: not editable.
    contract: integer('contract'),
    // 'author' (an agent writes the composition) or 'render_unchanged' (an edit draft, frozen, rendered as is).
    mode: text('mode').notNull().default('author'),
    editedFromN: integer('edited_from_n'),
    // The frozen render input of a render_unchanged version: the archive in the sources store and its hashes.
    frozen: jsonb('frozen'),
    // 'silent', 'music' or 'music_sfx': what the run is asked to do with sound.
    sound: text('sound').notNull().default('silent'),
    // { voice, speed, script } when the run speaks a voice-over; null when it doesn't.
    voiceover: jsonb('voiceover'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.n] })],
)

export const attempts = pgTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    stage: text('stage').notNull(),
    nextActionAt: ts('next_action_at'),
    leaseUntil: ts('lease_until'),
    deployId: text('deploy_id'),
    agent: text('agent').notNull(),
    model: text('model'),
    effort: text('effort'),
    promptTemplateVersion: integer('prompt_template_version').notNull(),
    toolVersions: jsonb('tool_versions'),
    parentSourceSha256: text('parent_source_sha256'),
    handleEnc: text('handle_enc'),
    startRequestEnc: text('start_request_enc'),
    runnerId: text('runner_id'),
    sessionId: text('session_id'),
    callbackTokenHash: text('callback_token_hash').notNull(),
    sendWindow: jsonb('send_window'),
    cancelRequestedAt: ts('cancel_requested_at'),
    cancelReason: text('cancel_reason'),
    latestStep: text('latest_step'),
    // The agent's final answer (truncated): why a run ended without a video, when it did.
    resultText: text('result_text'),
    usage: jsonb('usage'),
    errorCategory: text('error_category'),
    errorMessage: text('error_message'),
    queuedAt: ts('queued_at').notNull(),
    startedAt: ts('started_at'),
    finishingAt: ts('finishing_at'),
    endedAt: ts('ended_at'),
    authoringDeadlineAt: ts('authoring_deadline_at'),
  },
  (t) => [
    index('attempts_due_idx')
      .on(t.nextActionAt)
      .where(sql`${t.stage} not in ('ready','failed','cancelled','timed_out','queued','unresolved')`),
    index('attempts_queued_idx')
      .on(t.queuedAt)
      .where(sql`${t.stage} = 'queued'`),
    index('attempts_job_idx').on(t.jobId, t.versionN),
  ],
)

export const outputs = pgTable(
  'outputs',
  {
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    videoKey: text('video_key').notNull(),
    posterKey: text('poster_key').notNull(),
    gifKey: text('gif_key').notNull(),
    captionsKey: text('captions_key').notNull(),
    sourceKey: text('source_key').notNull(),
    sha256: jsonb('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    durationSec: doublePrecision('duration_sec').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    title: text('title').notNull(),
    agentSummary: text('agent_summary').notNull(),
    previews: jsonb('previews'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.versionN] })],
)

export const publications = pgTable(
  'publications',
  {
    slug: text('slug').primaryKey(),
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    publishedBy: text('published_by').notNull(),
    publishedAt: ts('published_at').notNull(),
    unpublishedAt: ts('unpublished_at'),
  },
  (t) => [index('publications_job_idx').on(t.jobId)],
)

export const callbackReceipts = pgTable('callback_receipts', {
  attemptId: text('attempt_id').primaryKey(),
  manifest: jsonb('manifest').notNull(),
  manifestHash: text('manifest_hash').notNull(),
  receivedAt: ts('received_at').notNull(),
})

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    principalId: text('principal_id').notNull(),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.principalId, t.operation, t.key] })],
)

export const queueControl = pgTable('queue_control', {
  id: integer('id').primaryKey(),
})

// Plan with questions (plan v2 §4, §14 rules 14–17). Plan content expires; gateway_calls (usage) is kept.
export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    jobId: text('job_id'),
    baseN: integer('base_n'),
    prompt: text('prompt').notNull(),
    aspect: text('aspect'),
    durationSec: integer('duration_sec'),
    mediaIds: jsonb('media_ids').$type<string[]>().notNull().default([]),
    // The Sound chosen while planning; null when none was (the video then decides).
    sound: text('sound'),
    // The voice-over chosen while planning; null when none was.
    voiceover: jsonb('voiceover'),
    inputsHash: text('inputs_hash').notNull(),
    route: jsonb('route'),
    questions: jsonb('questions'),
    answers: jsonb('answers'),
    brief: jsonb('brief'),
    briefRev: integer('brief_rev').notNull(),
    consumedByJobId: text('consumed_by_job_id'),
    consumedByN: integer('consumed_by_n'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('plans_user_idx').on(t.userId, t.createdAt)],
)

export const gatewayCalls = pgTable(
  'gateway_calls',
  {
    id: text('id').primaryKey(),
    callerId: text('caller_id').notNull(),
    planId: text('plan_id'),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheTokens: integer('cache_tokens').notNull(),
    credits: doublePrecision('credits'),
    estimate: boolean('estimate').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    ms: integer('ms').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [index('gateway_calls_at_idx').on(t.at), index('gateway_calls_caller_idx').on(t.callerId, t.at)],
)

// Comments pinned to a moment of a version (plan v2 §5). x/y are 0–1 within the displayed video, always paired.
export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    timeSec: doublePrecision('time_sec'),
    x: doublePrecision('x'),
    y: doublePrecision('y'),
    createdAt: ts('created_at').notNull(),
    editedAt: ts('edited_at'),
    resolvedAt: ts('resolved_at'),
    resolvedBy: text('resolved_by'),
    addressedInN: integer('addressed_in_n'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('comments_job_idx').on(t.jobId, t.createdAt)],
)

// The team media library (plan v2 §9). Bytes live in the media store: the original as uploaded and, for SVGs, a
// sanitized clean copy that is the only one runs and previews use. Soft delete keeps bytes while referenced.
export const media = pgTable(
  'media',
  {
    id: text('id').primaryKey(),
    uploaderId: text('uploader_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    rejectReason: text('reject_reason'),
    filename: text('filename').notNull(),
    caption: text('caption'),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    originalKey: text('original_key').notNull(),
    originalSha256: text('original_sha256').notNull(),
    cleanKey: text('clean_key').notNull(),
    cleanSha256: text('clean_sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSec: doublePrecision('duration_sec'),
    posterKey: text('poster_key'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('media_created_idx').on(t.createdAt), index('media_uploader_idx').on(t.uploaderId)],
)

// Upload sessions for files over 4 MB (plan v2 §14 rule 24): bound to the uploader, expiring, with the whole file's
// size and hash declared up front and quota reserved at creation. Parts are immutable once received.
export const mediaUploads = pgTable(
  'media_uploads',
  {
    id: text('id').primaryKey(),
    uploaderId: text('uploader_id').notNull(),
    filename: text('filename').notNull(),
    caption: text('caption'),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    partSize: integer('part_size').notNull(),
    partCount: integer('part_count').notNull(),
    status: text('status').notNull(),
    mediaId: text('media_id'),
    error: text('error'),
    leaseUntil: ts('lease_until'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('media_uploads_uploader_idx').on(t.uploaderId, t.status),
    index('media_uploads_expires_idx').on(t.expiresAt),
  ],
)

export const mediaUploadParts = pgTable(
  'media_upload_parts',
  {
    uploadId: text('upload_id').notNull(),
    idx: integer('idx').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.idx] })],
)

// Media a version was made with, snapshotted when it was queued (plan v2 §9): the run downloads exactly these
// bytes, even if the item is later soft-deleted. Revisions and edits inherit their parent's.
export const versionMedia = pgTable(
  'version_media',
  {
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    mediaId: text('media_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    sha256: text('sha256').notNull(),
    filename: text('filename').notNull(),
    caption: text('caption'),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.versionN, t.mediaId] }),
    index('version_media_media_idx').on(t.mediaId),
  ],
)

// Edit drafts (plan v2 §8): one person's edits on one version, re-applied by the server on every save. Each rev has
// an immutable bundle in the bundles store; a render freezes the draft's latest rev into the new version.
export const edits = pgTable(
  'edits',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    baseN: integer('base_n').notNull(),
    authorId: text('author_id').notNull(),
    rev: integer('rev').notNull(),
    ops: jsonb('ops').notNull(),
    bundleSha256: text('bundle_sha256'),
    renderedN: integer('rendered_n'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('edits_author_idx').on(t.authorId, t.jobId), index('edits_expires_idx').on(t.expiresAt)],
)

// The latest milestone a run reported (plan v2 §6 A2): one row per attempt, replaced only by a higher seq.
export const checkpoints = pgTable('checkpoints', {
  attemptId: text('attempt_id').primaryKey(),
  jobId: text('job_id').notNull(),
  seq: integer('seq').notNull(),
  message: text('message'),
  renderPercent: integer('render_percent'),
  bundleKey: text('bundle_key'),
  createdAt: ts('created_at').notNull(),
  windowStart: ts('window_start').notNull(),
  windowCount: integer('window_count').notNull(),
})

// Comments a version was asked to incorporate, snapshotted when it was queued (plan v2 §5): later edits or
// deletes of the comment don't change what the run was given.
export const versionComments = pgTable(
  'version_comments',
  {
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    commentId: text('comment_id').notNull(),
    position: integer('position').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name'),
    body: text('body').notNull(),
    timeSec: doublePrecision('time_sec'),
    x: doublePrecision('x'),
    y: doublePrecision('y'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.versionN, t.commentId] })],
)

// Per-person read watermark for a video's comments (plan v2 §5): drives the unread badge.
export const commentReads = pgTable(
  'comment_reads',
  {
    userId: text('user_id').notNull(),
    jobId: text('job_id').notNull(),
    readAt: ts('read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
)

// In-app notifications for video owners (plan v2 §3, §14 rule 13): comments and verdicts on their videos.
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    jobId: text('job_id').notNull(),
    versionN: integer('version_n'),
    type: text('type').notNull(),
    actorId: text('actor_id').notNull(),
    summary: text('summary').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
)

export const notificationReads = pgTable('notification_reads', {
  userId: text('user_id').primaryKey(),
  readAt: ts('read_at').notNull(),
})

// Ownership transfers (plan v2 §3, §14 rule 7): audit of who moved which video to whom.
export const ownershipTransfers = pgTable('ownership_transfers', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  fromUserId: text('from_user_id').notNull(),
  toUserId: text('to_user_id').notNull(),
  byUserId: text('by_user_id').notNull(),
  at: ts('at').notNull(),
})

// Approved / Changes requested, one current verdict per person per version (plan v2 §3).
export const verdicts = pgTable(
  'verdicts',
  {
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    userId: text('user_id').notNull(),
    verdict: text('verdict').notNull(),
    note: text('note'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.versionN, t.userId] }), index('verdicts_job_idx').on(t.jobId)],
)

// Webhook outbox (plan v2 §14 rule 10): one logical event, one delivery row per destination.
export const webhookEvents = pgTable('webhook_events', {
  eventId: text('event_id').primaryKey(),
  jobId: text('job_id').notNull(),
  versionN: integer('version_n'),
  attemptId: text('attempt_id'),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: ts('created_at').notNull(),
})

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    destKind: text('dest_kind').notNull(),
    destRef: text('dest_ref').notNull(),
    url: text('url').notNull(),
    leaseUntil: ts('lease_until'),
    nextRetryAt: ts('next_retry_at'),
    deliverUntil: ts('deliver_until').notNull(),
    attempts: integer('attempts').notNull(),
    lastResult: text('last_result'),
    deliveredAt: ts('delivered_at'),
    droppedAt: ts('dropped_at'),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_dest_idx').on(t.eventId, t.destKind, t.destRef),
    index('webhook_deliveries_due_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.deliveredAt} is null and ${t.droppedAt} is null`),
  ],
)

export const userWebhooks = pgTable('user_webhooks', {
  userId: text('user_id').primaryKey(),
  url: text('url').notNull(),
  secretEnc: text('secret_enc').notNull(),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
})

export const cleanup = pgTable(
  'cleanup',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    store: text('store').notNull(),
    prefix: text('prefix').notNull(),
    nextActionAt: ts('next_action_at').notNull(),
    doneAt: ts('done_at'),
  },
  (t) => [uniqueIndex('cleanup_store_prefix_idx').on(t.store, t.prefix)],
)

// Optional MCP OAuth (src/auth): registered clients, authorizations in progress, grants and hashed tokens.
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: ts('created_at').notNull(),
})

export const oauthRequests = pgTable(
  'oauth_requests',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    redirectUri: text('redirect_uri').notNull(),
    resource: text('resource').notNull(),
    state: text('state').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    userId: text('user_id'),
    consentHash: text('consent_hash'),
    codeHash: text('code_hash'),
    grantId: text('grant_id'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    // The upstream access token (encrypted), kept only when a Netlify team is required, until the grant takes it.
    upstreamTokenEnc: text('upstream_token_enc'),
    membershipCheckedAt: ts('membership_checked_at'),
  },
  (t) => [
    uniqueIndex('oauth_requests_consent_idx').on(t.consentHash),
    uniqueIndex('oauth_requests_code_idx').on(t.codeHash),
    index('oauth_requests_expires_idx').on(t.expiresAt),
  ],
)

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    resource: text('resource').notNull(),
    createdAt: ts('created_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    upstreamTokenEnc: text('upstream_token_enc'),
    membershipCheckedAt: ts('membership_checked_at'),
    membershipFailedAt: ts('membership_failed_at'),
  },
  (t) => [index('oauth_grants_user_idx').on(t.userId), index('oauth_grants_client_idx').on(t.clientId)],
)

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    hash: text('hash').primaryKey(),
    kind: text('kind').notNull(),
    grantId: text('grant_id').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('oauth_tokens_grant_idx').on(t.grantId), index('oauth_tokens_expires_idx').on(t.expiresAt)],
)

// Sign-in identities linked to a user row (src/auth/accounts.ts): one account per person across the web app and MCP.
export const userIdentities = pgTable(
  'user_identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] }), index('user_identities_user_idx').on(t.userId)],
)

// Web sessions for Sign in with Netlify (src/auth/sessions.ts). The cookie holds a random token; only its hash is here.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    rotatedAt: ts('rotated_at').notNull(),
    upstreamTokenEnc: text('upstream_token_enc'),
    membershipCheckedAt: ts('membership_checked_at'),
    membershipFailedAt: ts('membership_failed_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)
