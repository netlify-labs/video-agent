// Netlify Database schema (Drizzle). Migrations are generated into netlify/database/migrations.
import { sql } from 'drizzle-orm'
import { bigint, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// Timestamps are ISO-8601 UTC strings (toISOString), which sort correctly as text.
const ts = (name: string) => text(name)

export const settings = pgTable('settings', {
  id: integer('id').primaryKey(),
  fileSigningSecret: text('file_signing_secret').notNull(),
  dataEncryptionKey: text('data_encryption_key').notNull(),
  queuePausedReason: text('queue_paused_reason'),
  createdAt: ts('created_at').notNull(),
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
    targetDurationSec: integer('target_duration_sec'),
    parentN: integer('parent_n'),
    webhookUrl: text('webhook_url'),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull(),
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
    index('attempts_queued_idx').on(t.queuedAt).where(sql`${t.stage} = 'queued'`),
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

export const webhookEvents = pgTable(
  'webhook_events',
  {
    eventId: text('event_id').primaryKey(),
    jobId: text('job_id').notNull(),
    versionN: integer('version_n').notNull(),
    attemptId: text('attempt_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    apiKeyId: text('api_key_id').notNull(),
    url: text('url').notNull(),
    leaseUntil: ts('lease_until'),
    nextRetryAt: ts('next_retry_at'),
    deliverUntil: ts('deliver_until').notNull(),
    attempts: integer('attempts').notNull(),
    lastResult: text('last_result'),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [index('webhook_events_due_idx').on(t.nextRetryAt).where(sql`${t.deliveredAt} is null`)],
)

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
