// Domain records. These mirror the database tables (db/schema.ts) and the in-memory store.

export type Role = 'admin' | 'member'
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5'

export const ASPECTS: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
}

/** Attempt stages. Slot holders are starting, running, cancelling and unresolved. */
export type Stage =
  | 'queued'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'unresolved'
  | 'finishing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export const SLOT_STAGES: readonly Stage[] = ['starting', 'running', 'cancelling', 'unresolved']
export const TERMINAL_STAGES: readonly Stage[] = ['ready', 'failed', 'cancelled', 'timed_out']
export const isTerminal = (s: Stage) => TERMINAL_STAGES.includes(s)

/** What a version (and a video) shows: derived from its latest attempt's stage. */
export type VersionStatus =
  'queued' | 'running' | 'finishing' | 'ready' | 'failed' | 'cancelled' | 'timed_out'

export function statusForStage(stage: Stage): VersionStatus {
  switch (stage) {
    case 'queued':
      return 'queued'
    case 'starting':
    case 'running':
    case 'cancelling':
    case 'unresolved':
      return 'running'
    case 'finishing':
      return 'finishing'
    default:
      return stage
  }
}

export const UNFINISHED_STATUSES: readonly VersionStatus[] = ['queued', 'running', 'finishing']

export type CancelReason = 'user' | 'needs_input' | 'deadline'

export type FailureCategory =
  | 'needs_input'
  | 'credits_unavailable'
  | 'artifacts_missing'
  | 'invalid_output'
  | 'source_unavailable'
  | 'start_failed'
  | 'unresolved_start'
  | 'runner_failed'
  | 'queue_timeout'

export interface Usage {
  totalCreditsCost?: number
  totalTokens?: number
  stepsCount?: number
}

export interface SettingsRow {
  id: 1
  fileSigningSecret: string
  dataEncryptionKey: string
  queuePausedReason: string | null
  createdAt: string
}

export interface UserRow {
  id: string
  email: string
  name: string | null
  role: Role
  admittedVia: 'domain' | 'invite'
  createdAt: string
  lastSeenAt: string
  disabledAt: string | null
}

export interface ApiKeyRow {
  id: string
  ownerId: string
  name: string
  secretHash: string
  webhookSecretEnc: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface JobRow {
  id: string
  title: string
  aspect: Aspect
  ownerId: string
  status: VersionStatus
  latestVersion: number
  nextVersionN: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
}

export interface VersionRow {
  jobId: string
  n: number
  prompt: string
  authorId: string
  apiKeyId: string | null
  targetDurationSec: number | null
  parentN: number | null
  webhookUrl: string | null
  status: VersionStatus
  createdAt: string
}

export interface AttemptRow {
  id: string
  jobId: string
  versionN: number
  stage: Stage
  nextActionAt: string | null
  leaseUntil: string | null
  deployId: string | null
  agent: string
  model: string | null
  effort: string | null
  promptTemplateVersion: number
  toolVersions: Record<string, string> | null
  parentSourceSha256: string | null
  handleEnc: string | null
  /** The exact start request (prompt includes the callback token), encrypted; reused to reconcile. */
  startRequestEnc: string | null
  runnerId: string | null
  sessionId: string | null
  callbackTokenHash: string
  sendWindow: { sentAt: number; failedAt: number } | null
  cancelRequestedAt: string | null
  cancelReason: CancelReason | null
  latestStep: string | null
  usage: Usage | null
  errorCategory: FailureCategory | null
  errorMessage: string | null
  queuedAt: string
  startedAt: string | null
  finishingAt: string | null
  endedAt: string | null
  authoringDeadlineAt: string | null
}

export interface OutputRow {
  jobId: string
  versionN: number
  videoKey: string
  posterKey: string
  gifKey: string
  captionsKey: string
  sourceKey: string
  sha256: Record<string, string>
  bytes: number
  durationSec: number
  width: number
  height: number
  title: string
  agentSummary: string
}

export interface PublicationRow {
  slug: string
  jobId: string
  versionN: number
  publishedBy: string
  publishedAt: string
  unpublishedAt: string | null
}

export interface ReceiptRow {
  attemptId: string
  manifest: Manifest
  manifestHash: string
  receivedAt: string
}

export interface IdempotencyRow {
  principalId: string
  operation: string
  key: string
  requestHash: string
  response: { status: number; body: unknown }
  expiresAt: string
}

export interface WebhookEventRow {
  eventId: string
  jobId: string
  versionN: number
  attemptId: string
  type: 'video.ready' | 'video.failed'
  payload: unknown
  apiKeyId: string
  url: string
  leaseUntil: string | null
  nextRetryAt: string | null
  deliverUntil: string
  attempts: number
  lastResult: string | null
  deliveredAt: string | null
}

export interface CleanupRow {
  id: string
  kind: 'delete_prefix'
  store: 'videos' | 'sources' | 'uploads'
  prefix: string
  nextActionAt: string
  doneAt: string | null
}

/** What render-job.ts reports through the callback and prints as its final JSON block. */
export interface Manifest {
  jobId: string
  attemptId: string
  title: string
  summary: string
  files: Record<
    'video.mp4' | 'poster.jpg' | 'preview.gif' | 'captions.vtt' | 'source.tar.gz',
    { sha256: string; bytes: number }
  >
  durationSec: number
  width: number
  height: number
  tools?: Record<string, string>
}

export const OUTPUT_FILES = [
  'video.mp4',
  'poster.jpg',
  'preview.gif',
  'captions.vtt',
  'source.tar.gz',
] as const
export type OutputFile = (typeof OUTPUT_FILES)[number]
