// Domain records. These mirror the database tables (db/schema.ts) and the in-memory store.
import type { BundleReference } from '../lib/bundle-references.js'
import type { Language } from '../lib/language.js'
import type { FrozenNarration } from '../lib/run-manifest.js'
import type { MediaKind } from '../lib/media/classify.js'
import type { NarrationCleanup } from '../lib/timeline.js'
import type { PreviewFile, Previews } from '../lib/media/previews.js'
import type { RunCredit } from '../lib/openverse-rules.js'

export type Role = 'admin' | 'creator' | 'reviewer' | 'viewer'
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5'
/** What a run does with sound: nothing (the default), a music bed, or music plus effects on visible actions. */
export const SOUNDS = ['silent', 'music', 'music_sfx'] as const
export type VideoSound = (typeof SOUNDS)[number]
/**
 * A voice-over (docs/spikes.md S9): the run speaks a narration line per beat with scripts/voice.ts. Null fields are left to
 * the run: the default voice and speed, and a script the agent writes (or the plan's narration).
 */
export interface Voiceover {
  voice: string | null
  speed: number | null
  script: string[] | null
}

export const ASPECTS: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
}

/** Attempt stages. Slot holders are finding_music, starting, running, cancelling and unresolved. */
export type Stage =
  | 'queued'
  /** Before a run that needs music and has none: the server picks a track on Openverse (src/domain/music-pick.ts). */
  | 'finding_music'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'unresolved'
  | 'finishing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export const SLOT_STAGES: readonly Stage[] = [
  'finding_music',
  'starting',
  'running',
  'cancelling',
  'unresolved',
]
export const TERMINAL_STAGES: readonly Stage[] = ['ready', 'failed', 'cancelled', 'timed_out']
export const isTerminal = (s: Stage) => TERMINAL_STAGES.includes(s)

/** What a version (and a video) shows: derived from its latest attempt's stage. */
export type VersionStatus =
  'queued' | 'running' | 'finishing' | 'ready' | 'failed' | 'cancelled' | 'timed_out'

export function statusForStage(stage: Stage): VersionStatus {
  switch (stage) {
    case 'queued':
      return 'queued'
    case 'finding_music':
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
  /** A render-unchanged run stopped because the edited composition failed `hyperframes check` (plan v2 §8). */
  | 'check_failed'

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
  /** Admin-set webhook for every event on every video (plan v2 §3). */
  teamWebhookUrl?: string | null
  teamWebhookSecretEnc?: string | null
  /** Admin-chosen deep model for planning (allowlisted; null = default). */
  planDeepModel?: string | null
  /** Recorded voice-over on (the default) or off, without a redeploy. Missing: the default. */
  narrationEnabled?: boolean
  /** How recorded narration is transcribed for captions. Missing: the default. */
  transcriptionProvider?: TranscriptionProvider
  /** Stored bytes each person's narration takes may use. Missing: the default. */
  takeQuotaBytes?: number
  /** Remixing on (the default) or off, without a redeploy (remix spec §4). Missing: the default. */
  remixEnabled?: boolean
}

export type TranscriptionProvider = 'local' | 'elevenlabs' | 'off'

/** The voice-over settings' defaults, as the database fills them (db/schema.ts). */
export const NARRATION_SETTING_DEFAULTS = {
  narrationEnabled: true,
  transcriptionProvider: 'local',
  takeQuotaBytes: 2 * 1024 ** 3,
} as const satisfies Required<
  Pick<SettingsRow, 'narrationEnabled' | 'transcriptionProvider' | 'takeQuotaBytes'>
>

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

/** A client registered through Dynamic Client Registration (CIMD clients are fetched, not stored). */
export interface OAuthClientRow {
  id: string
  name: string | null
  redirectUris: string[]
  createdAt: string
}

/**
 * One authorization in progress: created at /oauth/authorize (keyed by the hash of the state sent upstream),
 * given a user and a consent secret at the callback, then a code; kept until expiry to detect a reused code.
 */
export interface OAuthRequestRow {
  id: string
  clientId: string
  clientName: string | null
  redirectUri: string
  resource: string
  state: string
  codeChallenge: string
  userId: string | null
  consentHash: string | null
  codeHash: string | null
  grantId: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  /** The upstream access token (encrypted), kept only when a Netlify team is required. */
  upstreamTokenEnc?: string | null
  membershipCheckedAt?: string | null
}

/** A connected app: one person's authorization of one client. Revoking it ends all of its tokens. */
export interface OAuthGrantRow {
  id: string
  userId: string
  clientId: string
  clientName: string | null
  resource: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  revokedAt: string | null
  /** For the Netlify team re-check (src/auth/membership.ts): the encrypted upstream token and check times. */
  upstreamTokenEnc?: string | null
  membershipCheckedAt?: string | null
  membershipFailedAt?: string | null
}

/** A sign-in identity (provider + subject) linked to a user row. */
export interface UserIdentityRow {
  provider: string
  subject: string
  userId: string
  email: string
  createdAt: string
  lastSeenAt: string
}

/** A web session (Sign in with Netlify). `id` is the SHA-256 of the cookie's token. */
export interface SessionRow {
  id: string
  userId: string
  provider: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  rotatedAt: string
  upstreamTokenEnc: string | null
  membershipCheckedAt: string | null
  membershipFailedAt: string | null
  revokedAt: string | null
}

/** An access or refresh token, stored as the SHA-256 of its value. */
export interface OAuthTokenRow {
  hash: string
  kind: 'access' | 'refresh'
  grantId: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
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
  /** Hidden from everyone but its owner and admins (plan v2 §3). */
  private: boolean
  /** Bumped on every privacy or owner change; part of file URL signatures (§14 rule 4). */
  accessEpoch: number
  /** The language spoken in it (src/lib/language.ts); narration captions are transcribed in it. */
  language: Language
  /** The video and version this one was remixed from: the immediate source only (remix spec §0, §3.3). */
  remixOfJobId?: string | null
  remixOfN?: number | null
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
  /** The accepted plan, frozen at creation: brief, questions and answers, context hash. */
  plan?: FrozenPlan | null
  /** Editing contract the finished composition conforms to (validated at finalize); null when it doesn't. */
  contract?: number | null
  /** 'render_unchanged': an edit draft rendered as is (plan v2 §8). */
  mode?: VersionMode
  editedFromN?: number | null
  /** The version-owned render input of a render_unchanged version. */
  frozen?: FrozenBundle | null
  /** Missing on rows written before sound existed: silent. */
  sound?: VideoSound
  /** Null (or missing) when the version has no voice-over. */
  voiceover?: Voiceover | null
  /** Recorded narration; null (or missing) when the version has none. */
  narration?: VersionNarration | null
  /** The current caption revision; null (or missing): the render's own captions. */
  captions?: VersionCaptions | null
  /** A remix's v1: everything its runs need, snapshotted at creation so nothing is re-read from the source. */
  remix?: VersionRemix | null
}

/**
 * What a remix's first version was made from (remix spec §3.3). Written once when the remix is created and never
 * updated: the run and every retry read only this, so the source video can change or be deleted meanwhile.
 */
export interface VersionRemix {
  /** The cleaned copy of the source's composition, in the sources store under the remix's own prefix. */
  sourceKey: string
  sourceSha256: string
  fromJobId: string
  fromN: number
  fromTitle: string
  fromOwnerName: string | null
  /** The source's prompts, oldest first (a remixed source's own history first), capped. */
  history: string[]
  /** The source version's agent summary, capped. */
  fromSummary: string
  /** The source had recorded narration, which was removed from the copy. */
  narrationDropped: boolean
  /** The source version's sound, so the music pick needn't read the source. */
  sourceSound: VideoSound
}

/** A version's recorded narration (plan 2026-11-02 §6.1): what was mixed, how, and the resulting bus. */
export interface VersionNarration {
  /** The resolved narration op (schema-versioned; validated where it's saved). */
  op: unknown
  /** The pipeline version, ffmpeg's version line from the run's receipt, and the settings it ran with (cleanup). */
  recipe: { pipeline: number; ffmpegVersion: string; settings: Record<string, unknown> }
  /** The processed bus in the videos store, its digest and length in samples. */
  bus: { key: string; sha256: string; samples: number }
  /** sha256 of the op (narrationOpHash): a later version with the same op carries this one's caption corrections. */
  opHash?: string
}

/** A version's captions (plan 2026-11-02 §6.6), kept apart from the render's output hashes. */
export interface VersionCaptions {
  /** How the run's transcription went (scripts/lib/stt): 'ok', or why the captions have no narration cues. */
  status: 'ok' | 'failed' | 'off' | 'timeout'
  /** Stored, never inferred from the HTML: burned-in captions can't be revised. */
  policy: 'sidecar' | 'burned'
  /** Bumped by every revision (compare-and-swap). */
  rev: number
  /** File names of the current revision, e.g. captions.r2.vtt; no transcript when the run wrote none. */
  files: { vtt: string; transcript: string | null }
  sha256: { vtt: string; transcript: string | null }
  /** The publication mirror's generation: a mirror update never applies an older one. */
  generation: number
  /** Corrections carried from an earlier version with the same narration op (its n and revision). */
  carriedFrom?: { n: number; rev: number }
}

export type VersionMode = 'author' | 'render_unchanged'

export interface FrozenBundle {
  /** Key in the sources store of a .tar.gz of video/. */
  key: string
  sha256: string
  /** Canonical file manifest hash (src/lib/bundle-manifest.ts) prepare-run and render-job verify. */
  manifestHash: string
  editId: string
  /** Narration lines the run re-voices (scripts/voice.ts revoice), and the hash of every file that must not change. */
  revoice?: RevoicePlan
  /** Files of the bundle kept by key outside the archive (src/lib/bundle-references.ts). */
  references?: BundleReference[]
  /** Keep-visuals renders of a draft with recorded narration: what the run mixes over the frozen visuals. */
  narration?: FrozenNarration
}

export interface RevoicePlan {
  beats: string[]
  keptHash: string
}

export interface FrozenPlan {
  planId: string
  brief: PlanBrief
  qa: { question: string; answer: string[] | string }[]
  contextHash: string
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
  /** The agent's final answer, truncated. */
  resultText?: string | null
  usage: Usage | null
  errorCategory: FailureCategory | null
  errorMessage: string | null
  queuedAt: string
  startedAt: string | null
  finishingAt: string | null
  endedAt: string | null
  authoringDeadlineAt: string | null
  /** The music the server picked before the run (null: none was needed). */
  musicPick?: MusicPick | null
}

/** Where a pre-run music pick is: searching Openverse, importing the chosen track, done (picked) or given up. */
export type MusicPickStatus = 'searching' | 'importing' | 'picked' | 'skipped'

/** One search a music pick tried: failed (Openverse errored), empty (nothing importable), or the one it chose from. */
export interface MusicPickTry {
  query: string
  outcome: 'searching' | 'failed' | 'empty' | 'chosen' | 'import_failed'
}

export interface MusicPick {
  status: MusicPickStatus
  startedAt: string
  /** The Openverse search words, and where they came from. */
  query: string | null
  fallbackQuery: string | null
  querySource: 'gateway' | 'heuristic' | null
  /** True once the fallback query is the one being searched. */
  usedFallback: boolean
  /** Each search tried so far, in order, and how it went (bounded; absent on picks from before it existed). */
  tried?: MusicPickTry[]
  /** Where the track came from: an Openverse search, or the team's library when Openverse found none in time. */
  source?: 'openverse' | 'library' | null
  searchJobId: string | null
  importJobId: string | null
  openverseId: string | null
  title: string | null
  mediaId: string | null
  /** Why it was skipped. */
  reason: string | null
  endedAt: string | null
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
  /** Optional preview variants (WebP/AVIF posters, hover clip, LQIP). Null for versions rendered without them. */
  previews?: Previews | null
  /** Openverse files the run fetched itself, from its video/assets/music/credits.json as finalize checked it. */
  runCredits?: RunCredit[] | null
  /** Things to know about the video, kept despite them (a length far from the one asked for). */
  notices?: string[] | null
}

export interface PublicationRow {
  slug: string
  jobId: string
  versionN: number
  publishedBy: string
  publishedAt: string
  unpublishedAt: string | null
  /** The share page offers the version's transcript; missing on rows written before it existed: off. */
  showTranscript?: boolean
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

export interface PlanQuestion {
  id: string
  question: string
  why: string
  /** The planner's recommended option, when it has one, is first and marked. */
  options: { id: string; label: string; description: string; recommended?: boolean }[]
  multiSelect: boolean
  allowOther: boolean
}
export interface PlanAnswer {
  questionId: string
  optionIds?: string[] | undefined
  other?: string | undefined
  skipped?: boolean | undefined
}
export interface PlanBrief {
  /** The planner's name for the video (briefs from before titles have none). */
  title?: string | undefined
  goal: string
  audience: string
  keyMessage: string
  beats: { text: string; seconds: number; narration?: string | undefined }[]
  tone: string
  callToAction: string
  mustInclude: string[]
  avoid: string[]
  /** Taken from the request when the person left Sound untouched. */
  sound?: VideoSound | undefined
  /** Taken from the request when the person left Voice-over untouched. */
  voiceover?: boolean | undefined
}
export interface PlanRoute {
  needsQuestions: boolean
  template: string
  complexity: string
  suggestedAspect: '16:9' | '9:16' | '1:1' | '4:5' | null
  model: string
}
export interface PlanRow {
  id: string
  userId: string
  jobId: string | null
  baseN: number | null
  prompt: string
  aspect: string | null
  durationSec: number | null
  /** Library items attached while planning; the video made from the plan uses them. */
  mediaIds: string[]
  /** The Sound chosen while planning, if any. */
  sound?: VideoSound | null
  /** The voice-over chosen while planning, if any; the brief then gets narration per beat. */
  voiceover?: Voiceover | null
  inputsHash: string
  route: PlanRoute | null
  questions: PlanQuestion[] | null
  answers: PlanAnswer[] | null
  brief: PlanBrief | null
  briefRev: number
  consumedByJobId: string | null
  consumedByN: number | null
  createdAt: string
  expiresAt: string
  /** A plan for a remix of this video and version (jobId is then null: it makes a new video). */
  remixFromJobId?: string | null
  remixFromN?: number | null
}
export interface GatewayCallRow {
  id: string
  callerId: string
  planId: string | null
  kind: 'router' | 'questions' | 'brief' | 'retry' | 'music_query'
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  credits: number | null
  estimate: boolean
  ok: boolean
  error: string | null
  ms: number
  at: string
}

export interface CommentRow {
  id: string
  jobId: string
  versionN: number
  authorId: string
  body: string
  timeSec: number | null
  x: number | null
  y: number | null
  createdAt: string
  editedAt: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  addressedInN: number | null
  deletedAt: string | null
  /** Notes posted together (a review pass with several timestamps) share one id; null for a lone comment. */
  groupId?: string | null
}

export type MediaStatus = 'uploading' | 'verifying' | 'ready' | 'rejected'

/** Recorded voice-over audio; library items have none. */
export type MediaRole = 'narration-take' | 'narration-upload'

export interface MediaRow extends MediaProvenance {
  id: string
  uploaderId: string
  kind: MediaKind
  status: MediaStatus
  rejectReason: string | null
  filename: string
  /** The name given in the library; null shows the file name. */
  title: string | null
  /** Notes: what the item is and how to use it. The planner and the agent read them. */
  caption: string | null
  mime: string
  ext: string
  bytes: number
  originalKey: string
  originalSha256: string
  /** The copy runs and previews use: sanitized for SVGs, the original otherwise. */
  cleanKey: string
  cleanSha256: string
  width: number | null
  height: number | null
  durationSec: number | null
  posterKey: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  role: MediaRole | null
  /** The video a narration take was recorded or uploaded for. */
  scopeJobId: string | null
  /** An unreferenced take's bytes are kept until then. */
  retainUntil: string | null
  /** Set by GC's first phase (no references left): the bytes are being deleted and nothing may reference it. */
  deletingAt: string | null
}

/** Where an imported item came from, with its licence and credit; all null for uploads. */
export interface MediaProvenance {
  source: 'openverse' | null
  sourceId: string | null
  /** The work's landing page. */
  sourceUrl: string | null
  sourceTitle: string | null
  /** Openverse licence slug: 'cc0' or 'by' (nothing else is imported). */
  license: string | null
  licenseVersion: string | null
  licenseUrl: string | null
  creator: string | null
  creatorUrl: string | null
  /** Openverse's own attribution text. */
  attribution: string | null
}

export const NO_PROVENANCE: MediaProvenance = {
  source: null,
  sourceId: null,
  sourceUrl: null,
  sourceTitle: null,
  license: null,
  licenseVersion: null,
  licenseUrl: null,
  creator: null,
  creatorUrl: null,
  attribution: null,
}

export type UploadStatus = 'open' | 'assembling' | 'done' | 'failed'

/** warmup: the daily refresh of common searches (src/domain/openverse-jobs.ts), run by the server for itself. */
export type OpenverseJobKind = 'search' | 'import' | 'warmup'
export type OpenverseJobStatus = 'queued' | 'running' | 'done' | 'failed'

/** A search or import run by openverse-background (src/domain/openverse-jobs.ts). */
export interface OpenverseJobRow {
  id: string
  userId: string
  kind: OpenverseJobKind
  /** The normalized request: the search's query string, or the track id. Identical requests share a job. */
  key: string
  params: Record<string, unknown>
  status: OpenverseJobStatus
  result: unknown
  error: { code: string; message: string } | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

/** A finished Openverse search page (normalized, before it's checked against the library). */
export interface OpenverseSearchRow {
  key: string
  result: unknown
  fetchedAt: string
}

export interface MediaUploadRow {
  id: string
  uploaderId: string
  filename: string
  caption: string | null
  size: number
  sha256: string
  partSize: number
  partCount: number
  status: UploadStatus
  mediaId: string | null
  error: string | null
  leaseUntil: string | null
  createdAt: string
  expiresAt: string
  /** A narration take's role and the video it's recorded for; the media row gets both at completion. */
  role: MediaRole | null
  scopeJobId: string | null
}

export interface MediaUploadPartRow {
  uploadId: string
  idx: number
  size: number
  sha256: string
}

export interface VersionMediaRow {
  jobId: string
  versionN: number
  mediaId: string
  position: number
  kind: MediaRow['kind']
  key: string
  sha256: string
  /** File name inside video/assets/media/. */
  filename: string
  caption: string | null
}

/** draft: an edit draft (owner id = edit id); frozen_attempt: a render's frozen input (attempt id); version: `<job>#<n>`. */
export type MediaRefOwnerKind = 'draft' | 'frozen_attempt' | 'version'

/** One reference to a narration take (plan 2026-11-02 §6.1): while any exists, GC keeps the take's bytes. */
export interface MediaRefRow {
  mediaId: string
  ownerKind: MediaRefOwnerKind
  ownerId: string
  jobId: string
  createdAt: string
}

/** Who is working on a video's narration (plan 2026-11-02 §6.1); free once `heartbeatAt` is two minutes old. */
export interface NarrationLockRow {
  jobId: string
  holderId: string
  /** The holder's edit draft. */
  draftId: string
  acquiredAt: string
  heartbeatAt: string
}

/** One imported item a version was made with: its provenance, as the credits on that version need it. */
export interface VersionProvenanceRow extends MediaProvenance {
  versionN: number
  mediaId: string
  position: number
  kind: MediaRow['kind']
  /** Library audio the version's recorded narration plays (a media_refs version reference), not a version_media row. */
  narration?: boolean
}

export interface EditRow {
  id: string
  jobId: string
  baseN: number
  authorId: string
  rev: number
  /** The contract edit operations, in order (src/lib/contract.ts EditOp). */
  ops: unknown[]
  /** Canonical manifest hash of this rev's bundle. */
  bundleSha256: string | null
  renderedN: number | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface CheckpointRow {
  attemptId: string
  jobId: string
  seq: number
  message: string | null
  renderPercent: number | null
  /** Key in the checkpoints store of the latest composition bundle, if one was sent. */
  bundleKey: string | null
  createdAt: string
  /** Rate window: when it began and how many posts it has seen. */
  windowStart: string
  windowCount: number
}

export interface VersionCommentRow {
  jobId: string
  versionN: number
  commentId: string
  position: number
  authorId: string
  authorName: string | null
  body: string
  timeSec: number | null
  x: number | null
  y: number | null
}

export type NotificationType = 'comment.created' | 'version.approved' | 'version.changes_requested'

export interface NotificationRow {
  id: string
  userId: string
  jobId: string
  versionN: number | null
  type: NotificationType
  actorId: string
  summary: string
  createdAt: string
}

export interface OwnershipTransferRow {
  id: string
  jobId: string
  fromUserId: string
  toUserId: string
  byUserId: string
  at: string
}

export type Verdict = 'approved' | 'changes_requested'

export interface VerdictRow {
  jobId: string
  versionN: number
  userId: string
  verdict: Verdict
  note: string | null
  updatedAt: string
}

export type WebhookEventType =
  'video.ready' | 'video.failed' | 'comment.created' | 'version.approved' | 'version.changes_requested'

/** A logical event; each destination gets its own delivery row (plan v2 §14 rule 10). */
export interface WebhookEventRow {
  eventId: string
  jobId: string
  versionN: number | null
  attemptId: string | null
  type: WebhookEventType
  payload: unknown
  createdAt: string
}

/** version_key: the per-video webhookUrl, signed with the API key's secret (destRef = key id).
 * personal: the video owner's own webhook (destRef = user id). team: the admin-set webhook (destRef = 'team'). */
export type WebhookDestKind = 'version_key' | 'personal' | 'team'

export interface WebhookDeliveryRow {
  id: string
  eventId: string
  destKind: WebhookDestKind
  destRef: string
  url: string
  leaseUntil: string | null
  nextRetryAt: string | null
  deliverUntil: string
  attempts: number
  lastResult: string | null
  deliveredAt: string | null
  droppedAt: string | null
}

export interface UserWebhookRow {
  userId: string
  url: string
  secretEnc: string
  createdAt: string
  updatedAt: string
}

export interface CleanupRow {
  id: string
  /** delete_take: GC's second phase for a narration take (prefix `<media id>/`), which also marks the row deleted. */
  /** sync_captions: a caption revision's publication mirror update (prefix `pub/<slug>.json#g<generation>`). */
  kind: 'delete_prefix' | 'delete_take' | 'sync_captions'
  store: 'videos' | 'sources' | 'uploads' | 'internal' | 'checkpoints' | 'bundles' | 'media'
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
  > &
    Partial<Record<PreviewFile | NarrationOutput, { sha256: string; bytes: number }>>
  /** Files of the composition uploaded on their own, outside source.tar.gz (src/lib/bundle-references.ts). */
  references?: Omit<BundleReference, 'key'>[]
  /** The tiny poster placeholder as a data URI, when render-job could make one. */
  lqip?: string
  /** Variants render-job couldn't make or upload, with why. */
  previewsSkipped?: { name: string; reason: string }[]
  durationSec: number
  width: number
  height: number
  tools?: Record<string, string>
  /** Narrated renders only: the final mix's loudness before and after the master gain (scripts/lib/mastering.ts). */
  mastering?: MasteringReport
  /** Narrated renders only: what scripts/narration.ts's receipt says it made, and how transcription went. */
  narration?: NarrationReport
}

/** The run's narration receipt, summed up for the callback (src/lib/narration-run.ts NarrationReceipt). Untrusted. */
export interface NarrationReport {
  pipeline: number
  cleanup: NarrationCleanup
  /** First line of `ffmpeg -version`. */
  ffmpeg: string
  bus: { sha256: string; samples: number }
  /** Null when the transcription stage didn't run. */
  stt: {
    status: VersionCaptions['status']
    provider: string | null
    model: string | null
    words: number
  } | null
}

/** Integrated loudness (null when ffmpeg measures -inf) and true peak of an MP4's audio, from ffmpeg ebur128. */
export interface Loudness {
  integratedLufs: number | null
  truePeakDb: number
}

/**
 * The master gain step (plan 2026-11-02 §6.3 step 7): `mastered` when the audio was re-encoded with `gainDb`,
 * `within_target` when it already met -14 +/- 1 LUFS at <= -1 dBTP, `exempt` for silent or speechless mixes.
 */
export interface MasteringReport {
  status: 'mastered' | 'within_target' | 'exempt'
  before: Loudness
  /** Re-measured after the re-encode; null when nothing was applied. */
  after: Loudness | null
  gainDb: number
  /** peak_limited (target loudness not reachable under the ceiling), true_peak_over, loudness_off_target, silent, no_speech. */
  warnings: string[]
}

export const OUTPUT_FILES = [
  'video.mp4',
  'poster.jpg',
  'preview.gif',
  'captions.vtt',
  'source.tar.gz',
] as const
export type OutputFile = (typeof OUTPUT_FILES)[number]

/** Recorded narration's outputs (plan 2026-11-02 §6.7): only narrated renders make them, so they're never required. */
export const NARRATION_OUTPUTS = {
  'narration.mp3': 'audio/mpeg',
  'transcript.txt': 'text/plain; charset=utf-8',
} as const
export type NarrationOutput = keyof typeof NARRATION_OUTPUTS
