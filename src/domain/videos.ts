// Creating, revising, retrying, cancelling, renaming, deleting and publishing videos.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { clip } from '../lib/log.js'
import type { PreviewFile, Previews } from '../lib/media/previews.js'
import {
  PUBLIC_URL_TTL_SEC,
  accessKey,
  fileTtl,
  posterKeys,
  posterLqip,
  signFile,
  stableExp,
  versionFileName,
  writeAccessMirror,
} from './files.js'
import { getSettings } from './settings.js'
import { emitEvent } from './webhooks.js'
import { snapshotMedia } from './media.js'
import { addAttemptRefs, releaseOwnerRefs } from './takes.js'
import { musicPickDto } from './music-pick.js'
import { versionCredits, type Credit } from './credits.js'
import { embedHtml } from '../lib/credit-html.js'
import { notifyOwner } from './notifications.js'
import { ApiError } from '../lib/errors.js'
import { DEFAULT_LANGUAGE, type Language } from '../lib/language.js'
import type { CommentCounts, Repo, VideoPageRows } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
import type {
  CommentRow,
  FrozenPlan,
  Verdict,
  VerdictRow,
  VersionCommentRow,
  VersionLook,
  VersionProvenanceRow,
} from './types.js'
import { planningContext } from '../generated/planning-context.js'
import {
  ASPECTS,
  UNFINISHED_STATUSES,
  isTerminal,
  statusForStage,
  type Aspect,
  type AttemptRow,
  type JobRow,
  type OutputRow,
  type PublicationRow,
  type Stage,
  type VersionMediaRow,
  type VersionPoster,
  type VersionRow,
  type VideoSound,
  type Voiceover,
} from './types.js'
import { voiceoverFrom, withPlanNarration, type VoiceoverInput } from './voiceover.js'
import {
  destinationNames,
  destinationPublicationDto,
  destinationTag,
  sharePageEntry,
} from './destinations/dto.js'
import { removeAllForJob } from './destinations/remove.js'
import { assertSameEngine, enabledEngines, engineInfo, engineOf } from './engines.js'
import { fillBeats } from './beats.js'
import { enabledFeatures } from './features.js'
import { scopeRules } from '../lib/scope.js'
import { adoptLookSnapshot, snapshotLook } from './look-snapshot.js'
import { lookSettings } from './look-settings.js'
import {
  assertLookAllowed,
  aspectNotice,
  assertLookSupportsEngine,
  assertRestyleAllowed,
  chooseEngine,
  getLook,
  resolveLook,
} from './looks.js'
import type { DestinationPublicationRow } from './types.js'

const IDEMPOTENCY_TTL_MS = 24 * 3600_000

export interface CreateVideoInput {
  prompt: string
  aspect?: Aspect | undefined
  durationSec?: number | undefined
  title?: string | undefined
  webhookUrl?: string | undefined
  planId?: string | undefined
  mediaIds?: string[] | undefined
  sound?: VideoSound | undefined
  voiceover?: VoiceoverInput | undefined
  /** A look id (looks plan §4.3); null: no look; omitted: the plan's look, else the admin default, else none. */
  look?: string | null | undefined
}

export interface ReviseInput {
  prompt: string
  fromVersion?: number | undefined
  durationSec?: number | undefined
  webhookUrl?: string | undefined
  planId?: string | undefined
  /** Incorporate feedback (plan v2 §5): open comments on the version being revised. Owner or admin. */
  commentIds?: string[] | undefined
  /** More library media for this version, on top of what it inherits from the version it revises. */
  mediaIds?: string[] | undefined
  /** Omitted: the parent's sound, or music when a silent video gets a new audio pick. */
  sound?: VideoSound | undefined
  /** Omitted: the plan's voice-over, else the parent's. */
  voiceover?: VoiceoverInput | undefined
  /** Redo only these scenes (beat ids of fromVersion); everything else stays exactly as it is (redo a scene, §4.1). */
  scope?: { beats: string[] } | undefined
  /** A look id: a restyle unless it's the parent's own look at the same version; null: no look; omitted: the parent's. */
  look?: string | null | undefined
}

export const INCORPORATE_MAX_COMMENTS = 50
const INCORPORATE_MAX_CHARS = 20_000

/**
 * Consumes a plan exactly once inside the caller's transaction (plan v2 §14 rule 15): the plan row is locked, must
 * belong to the caller, be unexpired and unused, have a brief, and (for revisions) be bound to this video. Returns
 * the frozen copy stored on the version and the length the brief implies.
 */
export async function consumePlan(
  repo: Repo,
  deps: Deps,
  principal: Principal,
  planId: string,
  /** remixFrom: the source a remix is made from; only a plan made for that same source and version fits. */
  target: { jobId: string | null; n: number; newJobId: string; remixFrom?: { jobId: string; n: number } },
): Promise<{
  frozen: FrozenPlan
  /** The brief's name for the video, if it has one. */
  title: string | null
  aspect: Aspect | null
  durationSec: number | null
  mediaIds: string[]
  sound: VideoSound | null
  voiceover: Voiceover | null
}> {
  const plan = await repo.getPlan(planId, { lock: true })
  if (!plan || plan.userId !== principal.userId) throw new ApiError('not_found', 'Plan not found.')
  if (plan.consumedByJobId) throw new ApiError('conflict', 'This plan was already used to make a video.')
  if (plan.expiresAt <= deps.clock.now().toISOString())
    throw new ApiError('gone', 'This plan expired. Start a new one.')
  if ((plan.jobId ?? null) !== target.jobId)
    throw new ApiError(
      'conflict',
      target.jobId ? 'This plan is for a different video.' : 'This plan is for a revision.',
    )
  // A remix plan makes a remix of exactly its source (docs/plans/2026-11-03-remix.md §3.3), and nothing else does.
  const planRemix = plan.remixFromJobId ? { jobId: plan.remixFromJobId, n: plan.remixFromN } : null
  if (planRemix && !target.remixFrom)
    throw new ApiError('conflict', 'This plan is for a remix. Use it from the Remix dialog.')
  if (target.remixFrom && (planRemix?.jobId !== target.remixFrom.jobId || planRemix.n !== target.remixFrom.n))
    throw new ApiError('conflict', 'This plan is for a different video to remix.')
  if (!plan.brief)
    throw new ApiError('conflict', 'Finish the plan (get a brief) first, or create without it.')
  const qa = (plan.questions ?? []).map((q) => {
    const a = plan.answers?.find((x) => x.questionId === q.id)
    return {
      question: q.question,
      answer:
        !a || a.skipped
          ? '(skipped)'
          : [
              ...(a.optionIds ?? []).map((o) => q.options.find((x) => x.id === o)?.label ?? o),
              ...(a.other ? [a.other] : []),
            ],
    }
  })
  await repo.updatePlan(plan.id, { consumedByJobId: target.newJobId, consumedByN: target.n })
  const seconds = plan.brief.beats.reduce((t, b) => t + b.seconds, 0)
  return {
    frozen: { planId: plan.id, brief: plan.brief, qa, contextHash: planningContext.hash },
    title: plan.brief.title?.trim().slice(0, 120) || null,
    aspect: (plan.aspect as Aspect | null) ?? plan.route?.suggestedAspect ?? null,
    durationSec: plan.durationSec ?? (seconds > 0 ? Math.round(seconds) : null),
    mediaIds: plan.mediaIds,
    // The person's choice, else what the brief took from the request.
    sound: plan.sound ?? plan.brief.sound ?? null,
    voiceover: withPlanNarration(
      plan.voiceover ?? (plan.brief.voiceover ? { voice: null, speed: null, script: null } : null),
      plan.brief,
    ),
  }
}

/**
 * A new version's sound and voice-over: the request's, else the plan's, else the parent's (silent and none for a new
 * video). A new audio pick (one not in `inherited`) turns music on for a silent video.
 */
export function versionAudio(
  input: { sound?: VideoSound | undefined; voiceover?: VoiceoverInput | undefined },
  planned: { sound: VideoSound | null; voiceover: Voiceover | null } | null,
  parent: Pick<VersionRow, 'sound' | 'voiceover'> | null,
  media: VersionMediaRow[],
  inherited: VersionMediaRow[] = [],
): { sound: VideoSound; voiceover: Voiceover | null } {
  const parentSound = parent?.sound ?? 'silent'
  const newAudio = media.some((m) => m.kind === 'audio' && !inherited.some((r) => r.mediaId === m.mediaId))
  return {
    sound: input.sound ?? planned?.sound ?? (parentSound === 'silent' && newAudio ? 'music' : parentSound),
    voiceover: input.voiceover
      ? voiceoverFrom(input.voiceover)
      : (planned?.voiceover ?? parent?.voiceover ?? null),
  }
}

export function checkWebhook(principal: Principal, url: string | undefined) {
  if (url === undefined) return
  if (principal.kind !== 'apiKey') {
    throw new ApiError(
      'invalid_request',
      'webhookUrl is only accepted on API-key requests. The web app has in-app notifications.',
    )
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ApiError('invalid_request', 'webhookUrl must be a valid URL.')
  }
  if (u.protocol !== 'https:') throw new ApiError('invalid_request', 'webhookUrl must use https.')
}

export function newAttempt(
  deps: Pick<Deps, 'ids' | 'config'>,
  jobId: string,
  versionN: number,
  now: string,
): AttemptRow {
  return {
    id: deps.ids.uuid(),
    jobId,
    versionN,
    stage: 'queued',
    nextActionAt: now,
    leaseUntil: null,
    deployId: null,
    agent: deps.config.agent,
    model: deps.config.agentModel,
    effort: deps.config.agentEffort,
    promptTemplateVersion: 0,
    toolVersions: null,
    parentSourceSha256: null,
    handleEnc: null,
    startRequestEnc: null,
    runnerId: null,
    sessionId: null,
    callbackTokenHash: '',
    sendWindow: null,
    cancelRequestedAt: null,
    cancelReason: null,
    latestStep: null,
    usage: null,
    errorCategory: null,
    errorMessage: null,
    queuedAt: now,
    startedAt: null,
    finishingAt: null,
    endedAt: null,
    authoringDeadlineAt: null,
  }
}

/** Moves an attempt to a stage and keeps the version and video status in step. */
export async function setStage(
  repo: Repo,
  attempt: AttemptRow,
  stage: Stage,
  patch: Partial<AttemptRow>,
  now: string,
): Promise<boolean> {
  const ok = await repo.updateAttempt(attempt.id, { ...patch, stage }, attempt.stage)
  if (!ok) return false
  if (isTerminal(stage)) {
    // The agent's uploads are only needed until finalize; reap them a day later.
    await repo.insertCleanup({
      id: `uploads-${attempt.id}`,
      kind: 'delete_prefix',
      store: 'uploads',
      prefix: `${attempt.id}/`,
      nextActionAt: new Date(new Date(now).getTime() + 24 * 3600_000).toISOString(),
      doneAt: null,
    })
    // An attempt that won't make its version lets go of the narration takes it froze (their 30 days start now); a
    // retry takes them again. A ready one's become its version's in finalize.
    if (stage !== 'ready')
      await releaseOwnerRefs(repo, { clock: { now: () => new Date(now) } }, 'frozen_attempt', attempt.id)
  }
  const status = statusForStage(stage)
  await repo.updateVersion(attempt.jobId, attempt.versionN, { status })
  const job = await repo.getJob(attempt.jobId)
  if (job && job.latestVersion === attempt.versionN) {
    await repo.updateJob(job.id, { status, updatedAt: now, version: job.version + 1 })
  }
  return true
}

export async function withIdempotency<T>(
  repo: Repo,
  deps: Deps,
  principal: Principal,
  operation: string,
  key: string | undefined,
  body: unknown,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false }
  const hash = sha256Hex(JSON.stringify(body))
  const prior = await repo.getIdempotency(principal.userId, operation, key)
  if (prior && prior.expiresAt > deps.clock.now().toISOString()) {
    if (prior.requestHash !== hash)
      throw new ApiError('conflict', 'This Idempotency-Key was used with a different request.')
    return { ...(prior.response as { status: number; body: T }), replayed: true }
  }
  const res = await run()
  await repo.insertIdempotency({
    principalId: principal.userId,
    operation,
    key,
    requestHash: hash,
    response: res,
    expiresAt: new Date(deps.clock.now().getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
  })
  return { ...res, replayed: false }
}

export async function createVideo(
  deps: Deps,
  principal: Principal,
  input: CreateVideoInput,
  idemKey?: string,
) {
  assertCan(principal, 'video:create')
  checkWebhook(principal, input.webhookUrl)
  deps.log.debug('video.create_requested', {
    userId: principal.userId,
    via: principal.kind,
    prompt: clip(input.prompt),
    title: input.title ?? null,
    aspect: input.aspect ?? null,
    durationSec: input.durationSec ?? null,
    planId: input.planId ?? null,
    mediaIds: input.mediaIds ?? [],
    sound: input.sound ?? null,
    voiceover: input.voiceover ?? null,
    look: input.look ?? null,
  })
  // The look, resolved and copied before the transaction (blob writes can't roll back), under an id minted now.
  const settings = await lookSettings(deps)
  const resolved = resolveLook(deps, input, {
    defaultLook: settings.defaultLook,
    disabled: settings.disabledLooks,
  })
  const presetJobId = resolved.kind === 'pick' ? deps.ids.videoId() : null
  const look =
    resolved.kind === 'pick' && presetJobId
      ? await snapshotLook(deps, presetJobId, { from: 'bundle', entry: resolved.entry }, false)
      : null
  const engine = chooseEngine({
    look: resolved.kind === 'pick' ? resolved.entry : null,
    enabled: (await enabledEngines(deps)).map((e) => e.id),
  })
  return deps.store.tx((repo) =>
    withIdempotency(repo, deps, principal, 'videos.create', idemKey, input, async () => {
      const now = deps.clock.now().toISOString()
      const jobId = presetJobId ?? deps.ids.videoId()
      const planned = input.planId
        ? await consumePlan(repo, deps, principal, input.planId, { jobId: null, n: 1, newJobId: jobId })
        : null
      const job: JobRow = {
        id: jobId,
        title: input.title?.trim() || planned?.title || deriveTitle(input.prompt),
        aspect: input.aspect ?? planned?.aspect ?? '16:9',
        ownerId: principal.userId,
        status: 'queued',
        latestVersion: 1,
        nextVersionN: 2,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
        private: false,
        accessEpoch: 0,
        language: DEFAULT_LANGUAGE,
      }
      await repo.insertJob(job)
      // Media attached while planning comes first, then any picked when creating.
      const media = await snapshotMedia(
        repo,
        jobId,
        1,
        [...(planned?.mediaIds ?? []), ...(input.mediaIds ?? [])],
        [],
      )
      await repo.insertVersionMedia(media)
      await repo.insertVersion({
        jobId,
        n: 1,
        prompt: input.prompt,
        authorId: principal.userId,
        apiKeyId: principal.apiKeyId,
        targetDurationSec: input.durationSec ?? planned?.durationSec ?? null,
        parentN: null,
        webhookUrl: input.webhookUrl ?? null,
        status: 'queued',
        createdAt: now,
        plan: planned?.frozen ?? null,
        // A picked audio item means music unless the person chose otherwise.
        ...versionAudio(input, planned, null, media),
        // The look's first enabled engine, else HyperFrames (looks plan §4.14).
        engine,
        look,
      })
      if (look) await adoptLookSnapshot(repo, deps, jobId, look, now)
      await repo.insertAttempt(newAttempt(deps, jobId, 1, now))
      return { status: 202, body: await videoDto(repo, deps, jobId, principal) }
    }),
  )
}

export function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57).trimEnd()}…`
}

/** Private videos are visible only to their owner and admins (plan v2 §3). */
export function canSee(
  p: Pick<Principal, 'role' | 'userId'>,
  job: Pick<JobRow, 'private' | 'ownerId'>,
): boolean {
  return !job.private || p.role === 'admin' || job.ownerId === p.userId
}

/** Loads a video the principal may see. Invisible private videos are not_found (never forbidden), and this
 * runs before any role check, replay or file signing (§14 rule 3). */
export async function loadJob(repo: Repo, p: Principal, id: string, lock = false): Promise<JobRow> {
  const job = await repo.getJob(id, { lock })
  if (!job || job.deletedAt || !canSee(p, job)) throw new ApiError('not_found', 'Video not found.')
  return job
}

export async function hasUnfinished(repo: Repo, jobId: string): Promise<boolean> {
  return (await repo.listVersions(jobId)).some((v) => UNFINISHED_STATUSES.includes(v.status))
}

export async function reviseVideo(
  deps: Deps,
  principal: Principal,
  jobId: string,
  input: ReviseInput,
  idemKey?: string,
) {
  assertCan(principal, 'version:create')
  checkWebhook(principal, input.webhookUrl)
  deps.log.debug('video.revise_requested', {
    userId: principal.userId,
    via: principal.kind,
    jobId,
    change: clip(input.prompt),
    fromVersion: input.fromVersion ?? null,
    planId: input.planId ?? null,
    commentIds: input.commentIds ?? [],
    mediaIds: input.mediaIds ?? [],
    sound: input.sound ?? null,
    voiceover: input.voiceover ?? null,
    ...(input.scope ? { scope: input.scope.beats } : {}),
    look: input.look ?? null,
  })
  // Redoing a scene keeps the video's look (looks plan §4.3).
  assertLookAllowed({ look: input.look, scope: input.scope })
  // A scoped revision's checks that may read Blobs (the parent's scenes) run before the transaction.
  if (input.scope) await checkScopedRevise(deps, principal, jobId, input)
  // A picked look is copied before the transaction: the copy depends only on this video and the look's version, so
  // the parent (and whether it's a restyle) is decided inside. Visibility is checked first.
  const settings = await lookSettings(deps)
  let picked: VersionLook | null = null
  if (typeof input.look === 'string') {
    await loadJob(deps.store, principal, jobId)
    const r = resolveLook(deps, input, { defaultLook: null, disabled: settings.disabledLooks })
    if (r.kind === 'pick') picked = await snapshotLook(deps, jobId, { from: 'bundle', entry: r.entry }, false)
  }
  return deps.store.tx(async (repo) => {
    // Visibility first: a replay must not return a saved response for a video that has since gone private.
    await loadJob(repo, principal, jobId)
    return withIdempotency(repo, deps, principal, `versions.create:${jobId}`, idemKey, input, async () => {
      const job = await loadJob(repo, principal, jobId, true)
      if (await hasUnfinished(repo, jobId))
        throw new ApiError('conflict', 'Another version of this video is still in progress.')
      const versions = await repo.listVersions(jobId)
      const parent =
        input.fromVersion !== undefined
          ? versions.find((v) => v.n === input.fromVersion)
          : versions.find((v) => v.status === 'ready')
      if (!parent) throw new ApiError('conflict', 'There is no ready version to revise from.')
      if (parent.status !== 'ready')
        throw new ApiError('conflict', `Version ${parent.n} isn't ready, so it can't be revised.`)
      const scope = input.scope ? scopeOf(parent, input.scope.beats) : null
      const now = deps.clock.now().toISOString()
      const n = job.nextVersionN
      // The look: the parent's snapshot unless the request picks one (null: none); a different snapshot is a restyle.
      const parentLook = parent.look ?? null
      const restyle = picked !== null && picked.hash !== parentLook?.hash
      assertRestyleAllowed(restyle, !!parent.narration)
      const look: VersionLook | null =
        input.look === null
          ? null
          : picked
            ? restyle
              ? { ...picked, restyle: true }
              : { ...(parentLook ?? picked), restyle: false }
            : parentLook && { ...parentLook, restyle: false }
      deps.log.debug('video.revise_look', { jobId, n, look: look?.id ?? null, restyle })
      const feedback = input.commentIds?.length
        ? await snapshotFeedback(repo, principal, job, parent.n, n, input.commentIds)
        : []
      const planned = input.planId
        ? await consumePlan(repo, deps, principal, input.planId, { jobId, n, newJobId: jobId })
        : null
      // The parent's media comes along (even items deleted from the library since); new picks are added.
      const inherited = await repo.listVersionMedia(jobId, parent.n)
      // Files attached to the comments being incorporated come along too.
      const media = await snapshotMedia(
        repo,
        jobId,
        n,
        [...(planned?.mediaIds ?? []), ...(input.mediaIds ?? []), ...feedbackMediaIds(feedback)],
        inherited,
      )
      const row: VersionRow = {
        jobId,
        n,
        prompt: input.prompt,
        authorId: principal.userId,
        apiKeyId: principal.apiKeyId,
        // An accepted plan's length replaces the inherited target (§14 rule 15).
        targetDurationSec:
          input.durationSec ??
          planned?.durationSec ??
          (await repo.getVersion(jobId, parent.n))?.targetDurationSec ??
          null,
        parentN: parent.n,
        webhookUrl: input.webhookUrl ?? null,
        status: 'queued',
        createdAt: now,
        plan: planned?.frozen ?? null,
        // Sound and voice-over are inherited unless changed; a plan without a voice-over choice keeps the parent's
        // (turning it off is an explicit enabled: false).
        ...versionAudio(input, planned, parent, media, inherited),
        // The parent's engine: a video keeps one (render-engines §4.2).
        engine: engineOf(parent),
        ...(scope ? { scope } : {}),
        look,
      }
      assertSameEngine(deps, parent, row)
      // A restyle keeps the video's engine, so the new look must support it (§4.14).
      const entry = look && restyle ? getLook(deps, look.id) : null
      if (entry) assertLookSupportsEngine(entry, engineOf(row))
      await repo.insertVersion(row)
      if (look && restyle) await adoptLookSnapshot(repo, deps, jobId, look, now)
      await repo.insertVersionComments(feedback)
      await repo.insertVersionMedia(media)
      await repo.insertAttempt(newAttempt(deps, jobId, n, now))
      await repo.updateJob(jobId, {
        latestVersion: n,
        nextVersionN: n + 1,
        status: 'queued',
        updatedAt: now,
        version: job.version + 1,
      })
      return { status: 202, body: await videoDto(repo, deps, jobId, principal) }
    })
  })
}

/**
 * A scoped revision's checks outside the transaction (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.1):
 * the server offers it, the request is one it can be, and the parent can be redone scene by scene. A parent made
 * before versions recorded their scenes gets them now (fillBeats checks visibility first and unpacks the archive),
 * so nothing reads Blobs while the job row is locked; the transaction then reads the stored scenes.
 */
async function checkScopedRevise(deps: Deps, principal: Principal, jobId: string, input: ReviseInput) {
  if (!(await enabledFeatures(deps)).includes('scoped_revision'))
    throw new ApiError('invalid_request', "This server can't redo single scenes yet.")
  const refused: [unknown, string][] = [
    [input.planId, 'A plan describes the whole video, so it can’t be used to redo scenes; leave out planId.'],
    [
      input.durationSec,
      'Redoing scenes keeps the video’s length setting; leave out durationSec and say in the request if a scene should run longer.',
    ],
    [input.sound, 'Redoing scenes keeps the video’s sound; leave out sound.'],
    [
      input.voiceover,
      'Redoing scenes keeps the video’s voice-over; leave out voiceover and say in the request how a scene’s line should change.',
    ],
  ]
  for (const [value, message] of refused)
    if (value !== undefined) throw new ApiError('invalid_request', message)
  if (input.fromVersion === undefined)
    throw new ApiError(
      'invalid_request',
      'Say which version the scenes are from (fromVersion): scene ids belong to one version.',
    )
  await loadJob(deps.store, principal, jobId)
  const parent = await deps.store.getVersion(jobId, input.fromVersion)
  if (!parent) throw new ApiError('not_found', `Version ${input.fromVersion} not found.`)
  assertScopable(parent)
  if (!parent.beats) await fillBeats(deps, principal, jobId, parent.n)
}

/** The parent can be redone scene by scene: ready, keeping the editing contract, made by an engine that can. */
function assertScopable(parent: VersionRow) {
  const engine = engineOf(parent)
  if (!engineInfo(engine).capabilities.scopedRevision)
    throw new ApiError(
      'not_editable',
      `Version ${parent.n} was made with ${engineInfo(engine).name}, which can't redo scenes one by one yet. Revise the whole video instead.`,
    )
  if (parent.status !== 'ready' || parent.contract !== 1)
    throw new ApiError(
      'not_editable',
      `Version ${parent.n} can't be edited scene by scene (${parent.status !== 'ready' ? "it isn't ready" : "it doesn't keep the editing contract"}). Revise the whole video instead.`,
    )
}

/** The stored scope for a revision of `parent`: the beat rules on its scenes (src/lib/scope.ts scopeRules). */
function scopeOf(parent: VersionRow, beats: string[]): { beats: string[] } {
  assertScopable(parent)
  if (!parent.beats)
    throw new ApiError('conflict', `Version ${parent.n}'s scenes aren't known yet. Try again.`)
  const r = scopeRules(parent.beats, beats)
  if ('refusal' in r) throw new ApiError('invalid_request', r.refusal)
  return { beats: r.beats }
}

/**
 * Checks the comments to incorporate and snapshots them for version n (plan v2 §5): owner or admin; open (not
 * resolved or deleted) comments on the version being revised; bounded so the prompt stays small.
 */
async function snapshotFeedback(
  repo: Repo,
  principal: Principal,
  job: JobRow,
  parentN: number,
  n: number,
  ids: string[],
): Promise<VersionCommentRow[]> {
  assertCan(principal, 'video:incorporate', { ownerId: job.ownerId })
  const unique = [...new Set(ids)]
  if (unique.length > INCORPORATE_MAX_COMMENTS)
    throw new ApiError('invalid_request', `Pick at most ${INCORPORATE_MAX_COMMENTS} comments.`)
  const open = new Map(
    (await repo.listComments(job.id, parentN)).filter((c) => !c.resolvedAt).map((c) => [c.id, c]),
  )
  const missing = unique.filter((id) => !open.has(id))
  if (missing.length)
    throw new ApiError(
      'invalid_request',
      `These aren't open comments on v${parentN}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}.`,
    )
  const picked = unique.map((id) => open.get(id) as CommentRow)
  if (picked.reduce((s, c) => s + c.body.length, 0) > INCORPORATE_MAX_CHARS)
    throw new ApiError('invalid_request', 'Those comments are too long to send together. Pick fewer.')
  const rows: VersionCommentRow[] = []
  for (const [i, c] of picked.entries()) {
    const author = await repo.getUser(c.authorId)
    rows.push({
      jobId: job.id,
      versionN: n,
      commentId: c.id,
      position: i,
      authorId: c.authorId,
      authorName: author?.name ?? author?.email.split('@')[0] ?? null,
      body: c.body,
      timeSec: c.timeSec,
      x: c.x,
      y: c.y,
      files: await commentFiles(repo, c),
    })
  }
  return rows
}

/**
 * A comment's attached media as the run will see them (snapshotMedia names each assets/media/{id}.{ext}), skipping
 * items deleted from the library since; null for none.
 */
async function commentFiles(repo: Repo, c: CommentRow): Promise<string[] | null> {
  const out = []
  for (const id of c.mediaIds ?? []) {
    const m = await repo.getMedia(id)
    if (m && !m.deletedAt && m.status === 'ready') out.push(`assets/media/${m.id}.${m.ext}`)
  }
  return out.length ? out : null
}

/** The media ids behind a feedback snapshot's files, so the revision downloads them. */
const feedbackMediaIds = (rows: VersionCommentRow[]) =>
  rows.flatMap((r) => (r.files ?? []).map((f) => f.replace(/^assets\/media\//, '').replace(/\.[^.]+$/, '')))

export async function retryVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    const version = await repo.getVersion(jobId, n)
    if (!version) throw new ApiError('not_found', 'Version not found.')
    assertCan(principal, 'version:retry', { ownerId: job.ownerId, authorId: version.authorId })
    if (!['failed', 'cancelled', 'timed_out'].includes(version.status)) {
      throw new ApiError('conflict', 'Only failed, cancelled or timed-out versions can be tried again.')
    }
    if (job.latestVersion !== n) throw new ApiError('conflict', 'Only the latest version can be tried again.')
    if (await hasUnfinished(repo, jobId))
      throw new ApiError('conflict', 'Another version of this video is still in progress.')
    const now = deps.clock.now().toISOString()
    const attempt = newAttempt(deps, jobId, n, now)
    await repo.insertAttempt(attempt)
    // A frozen narration's takes move to the new attempt (re-locked and re-checked), so a failed one holds nothing.
    const takes = version.frozen?.narration?.takes.map((t) => t.mediaId) ?? []
    if (takes.length) {
      await addAttemptRefs(repo, deps, attempt.id, jobId, takes)
      for (const a of await repo.listAttempts(jobId))
        if (a.versionN === n && a.id !== attempt.id)
          await releaseOwnerRefs(repo, deps, 'frozen_attempt', a.id)
    }
    await repo.updateVersion(jobId, n, { status: 'queued' })
    await repo.updateJob(jobId, { status: 'queued', updatedAt: now, version: job.version + 1 })
    return videoDto(repo, deps, jobId, principal)
  })
}

export async function cancelVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    const version = await repo.getVersion(jobId, n)
    if (!version) throw new ApiError('not_found', 'Version not found.')
    assertCan(principal, 'version:cancel', { ownerId: job.ownerId, authorId: version.authorId })
    const attempt = await repo.latestAttempt(jobId, n)
    if (!attempt || isTerminal(attempt.stage))
      throw new ApiError('conflict', 'This version is not in progress.')
    await requestCancel(repo, deps, attempt, 'user')
    return videoDto(repo, deps, jobId, principal)
  })
}

/** Queued or finding music (no run yet): cancel now. Running: persist intent; the sweep stops the session. */
export async function requestCancel(
  repo: Repo,
  deps: Pick<Deps, 'clock'>,
  attempt: AttemptRow,
  reason: 'user' | 'needs_input' | 'deadline',
) {
  const now = deps.clock.now().toISOString()
  if (attempt.stage === 'queued' || attempt.stage === 'finding_music') {
    await setStage(
      repo,
      attempt,
      'cancelled',
      { endedAt: now, cancelRequestedAt: now, cancelReason: reason, nextActionAt: null, leaseUntil: null },
      now,
    )
    return
  }
  if (attempt.stage === 'unresolved')
    throw new ApiError('conflict', 'This start is unresolved; an admin has to resolve it.')
  if (attempt.stage === 'finishing') {
    await repo.updateAttempt(attempt.id, { cancelRequestedAt: now, cancelReason: reason })
    return
  }
  if (attempt.stage === 'cancelling') return
  await setStage(
    repo,
    attempt,
    'cancelling',
    { cancelRequestedAt: now, cancelReason: reason, nextActionAt: now, leaseUntil: null },
    now,
  )
}

export async function updateVideo(
  deps: Deps,
  principal: Principal,
  jobId: string,
  patch: { title?: string | undefined; private?: boolean | undefined; language?: Language | undefined },
) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    // The language is a setting of the video like its title: whoever may rename it may set it.
    if (patch.title !== undefined || patch.language !== undefined)
      assertCan(principal, 'video:rename', { ownerId: job.ownerId })
    const privacyChanges = patch.private !== undefined && patch.private !== job.private
    if (patch.private !== undefined) assertCan(principal, 'video:private', { ownerId: job.ownerId })
    await repo.updateJob(jobId, {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(privacyChanges ? { private: patch.private as boolean, accessEpoch: job.accessEpoch + 1 } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      updatedAt: deps.clock.now().toISOString(),
      version: job.version + 1,
    })
    if (privacyChanges)
      await writeAccessMirror(deps, {
        id: jobId,
        private: patch.private as boolean,
        accessEpoch: job.accessEpoch + 1,
      })
    return videoDto(repo, deps, jobId, principal)
  })
}

export async function deleteVideo(deps: Deps, principal: Principal, jobId: string) {
  const slugs = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    assertCan(principal, 'video:delete', { ownerId: job.ownerId })
    const now = deps.clock.now().toISOString()
    await repo.updateJob(jobId, { deletedAt: now, updatedAt: now, version: job.version + 1 })
    const ended: string[] = []
    for (const p of await repo.listPublications(jobId)) {
      if (!p.unpublishedAt) {
        await repo.updatePublication(p.slug, { unpublishedAt: now })
        ended.push(p.slug)
      }
    }
    // Destination publications turn towards removed before the byte cleanup is queued (the sweep dispatches them).
    await removeAllForJob(repo, deps, jobId)
    for (const a of await repo.listAttempts(jobId)) {
      if (!isTerminal(a.stage) && a.stage !== 'unresolved') await requestCancel(repo, deps, a, 'user')
      await releaseOwnerRefs(repo, deps, 'frozen_attempt', a.id)
    }
    // Its versions' narration takes are released: kept for 30 days, then GC deletes them.
    for (const v of await repo.listVersions(jobId))
      await releaseOwnerRefs(repo, deps, 'version', `${jobId}#${v.n}`)
    for (const store of ['videos', 'sources', 'bundles'] as const) {
      await repo.insertCleanup({
        id: deps.ids.uuid(),
        kind: 'delete_prefix',
        store,
        prefix: `${jobId}/`,
        nextActionAt: now,
        doneAt: null,
      })
    }
    return ended
  })
  for (const slug of slugs) await deps.blobs.delete('internal', pubKey(slug))
  await deps.blobs.delete('internal', accessKey(jobId))
}

export const pubKey = (slug: string) => `pub/${slug}.json`

export interface PublicationMirror {
  slug: string
  jobId: string
  versionN: number
  title: string
  width: number
  height: number
  durationSec: number
  keys: {
    video: string
    poster: string
    gif: string
    captions: string
    /** Recorded narration's downloads (plan 2026-11-02 §6.7), for versions that have them. */
    narration?: string
    transcript?: string
    /** The 960w WebP poster (a picked poster's own, src/domain/poster.ts); null: none. Missing on older mirrors: the
     * render's poster-960.webp, when there is one. */
    posterWebp?: string | null
    /** The silent hover clip (clip.mp4), for the player; null: none. Missing on mirrors written before it. */
    hover?: string | null
  }
  /** The poster's blurred placeholder (a data URL); null: none. Missing on mirrors written before it. */
  lqip?: string | null
  /** CC BY media the version was made with; mirrors written before credits existed have none. */
  credits?: Credit[]
  /** The share page offers the transcript (the publisher's choice); missing: no. */
  showTranscript?: boolean
  /** versions.captions.generation the keys are of: a caption revision's sync applies only a newer one. */
  captionsGeneration?: number
}

export async function publishVersion(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
  opts: { showTranscript?: boolean | undefined } = {},
) {
  const { pub, mirror, output, written, poster } = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    const output = await repo.getOutput(jobId, n)
    const version = await repo.getVersion(jobId, n)
    if (!version || version.status !== 'ready' || !output)
      throw new ApiError('not_ready', 'Only ready versions can be published.')
    const credits = versionCredits(await repo.versionProvenance(jobId), version, output.runCredits)
    const active = (await repo.listPublications(jobId)).find((p) => p.versionN === n && !p.unpublishedAt)
    if (active) {
      // Publishing again may change only whether the share page shows the transcript.
      const show = opts.showTranscript ?? active.showTranscript ?? false
      if (show !== (active.showTranscript ?? false)) {
        await repo.updatePublication(active.slug, { showTranscript: show })
        // The video's ETag moves, so readers refetch the DTO with the new publication.
        await repo.updateJob(jobId, { version: job.version + 1 })
      }
      const row = { ...active, showTranscript: show }
      const mirror = mirrorFor(row, job, version, output, credits)
      // Under the job's lock, like a caption revision's mirror sync, so neither overwrites the other's newer state.
      await deps.blobs.set('internal', pubKey(row.slug), JSON.stringify(mirror))
      return { pub: row, mirror, output, written: true, poster: version.poster ?? null }
    }
    const row: PublicationRow = {
      slug: deps.ids.slug(),
      jobId,
      versionN: n,
      publishedBy: principal.userId,
      publishedAt: deps.clock.now().toISOString(),
      unpublishedAt: null,
      showTranscript: opts.showTranscript ?? false,
    }
    await repo.insertPublication(row)
    await repo.updateJob(jobId, { version: job.version + 1 })
    return {
      pub: row,
      mirror: mirrorFor(row, job, version, output, credits),
      output,
      written: false,
      poster: version.poster ?? null,
    }
  })
  if (!written) await deps.blobs.set('internal', pubKey(pub.slug), JSON.stringify(mirror))
  deps.log.info('publish.done', {
    jobId,
    versionN: n,
    slug: pub.slug,
    showTranscript: mirror.showTranscript ?? false,
    narration: Boolean(mirror.keys.narration),
  })
  return publicationDto(deps, pub, output, mirror.credits, poster)
}

function mirrorFor(
  p: PublicationRow,
  job: JobRow,
  v: Pick<VersionRow, 'captions' | 'poster'>,
  o: OutputRow,
  credits: Credit[],
): PublicationMirror {
  const prefix = `${job.id}/v${p.versionN}`
  const transcript = versionFileName(v, o, 'transcript')
  const captions = versionFileName(v, o, 'captions')
  return {
    slug: p.slug,
    jobId: job.id,
    versionN: p.versionN,
    title: o.title || job.title,
    width: o.width,
    height: o.height,
    durationSec: o.durationSec,
    keys: {
      video: o.videoKey,
      ...posterKeys(job.id, p.versionN, o, v.poster),
      gif: o.gifKey,
      captions: v.captions ? `${prefix}/${captions}` : o.captionsKey,
      ...(versionFileName(v, o, 'narration-audio') ? { narration: `${prefix}/narration.mp3` } : {}),
      ...(transcript ? { transcript: `${prefix}/${transcript}` } : {}),
      hover: o.previews?.files['clip.mp4'] ? `${prefix}/clip.mp4` : null,
    },
    lqip: posterLqip(o, v.poster),
    credits,
    showTranscript: p.showTranscript ?? false,
    ...(v.captions ? { captionsGeneration: v.captions.generation } : {}),
  }
}

export async function unpublishVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  const slugs = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    const now = deps.clock.now().toISOString()
    const active = (await repo.listPublications(jobId)).filter((p) => p.versionN === n && !p.unpublishedAt)
    if (active.length === 0) throw new ApiError('not_found', 'This version is not published.')
    for (const p of active) await repo.updatePublication(p.slug, { unpublishedAt: now })
    await repo.updateJob(jobId, { version: job.version + 1 })
    return active.map((p) => p.slug)
  })
  for (const slug of slugs) await deps.blobs.delete('internal', pubKey(slug))
}

// ───────────── DTOs ─────────────

/** The live publications and their transcript choice, for the video's ETag; empty when none is live. */
function livePubTag(pubs: PublicationRow[]): string {
  const live = pubs
    .filter((p) => !p.unpublishedAt)
    .map((p) => `${p.slug}${p.showTranscript ? 't' : ''}`)
    .sort()
  return live.length ? `-p${sha256Hex(live.join(',')).slice(0, 8)}` : ''
}

/** The <video-agent-player> snippet for a share page: this deployment's /player.js, then the element. */
export const playerSnippet = (siteUrl: string, sharePage: string) =>
  `<script type="module" src="${siteUrl}/player.js"></script><video-agent-player src="${sharePage}"></video-agent-player>`

export function publicationDto(
  deps: Pick<Deps, 'config'>,
  p: PublicationRow,
  o: Pick<OutputRow, 'width' | 'height' | 'previews' | 'sha256' | 'posterKey'> | null = null,
  credits: Credit[] = [],
  poster: VersionPoster | null = null,
) {
  const base = `${deps.config.siteUrl}/v/${p.slug}`
  // The 960w WebP poster is public only as /v/{slug}.webp, for a published version that has one (a picked poster's own).
  const webp = o && posterKeys(p.jobId, p.versionN, o, poster).posterWebp ? `${base}.webp` : null
  const showTranscript = p.showTranscript ?? false
  return {
    slug: p.slug,
    versionN: p.versionN,
    publishedAt: p.publishedAt,
    unpublishedAt: p.unpublishedAt,
    showTranscript,
    urls: p.unpublishedAt
      ? null
      : {
          page: base,
          mp4: `${base}.mp4`,
          poster: `${base}.jpg`,
          gif: `${base}.gif`,
          captions: `${base}.vtt`,
          ...(webp ? { posterWebp: webp } : {}),
          // Recorded narration: its audio follows the publication; the transcript only when the publisher chose it.
          ...(o?.sha256['narration.mp3'] ? { narration: `${base}.mp3` } : {}),
          ...(showTranscript && o?.sha256['transcript.txt'] ? { transcript: `${base}.txt` } : {}),
        },
    embed: p.unpublishedAt ? null : embedHtml(base, webp, o, credits),
    player: p.unpublishedAt ? null : playerSnippet(deps.config.siteUrl, base),
  }
}

function versionDto(
  deps: Pick<Deps, 'config' | 'runner'> & Partial<Pick<Deps, 'looks'>>,
  jobId: string,
  v: VersionRow,
  a: AttemptRow | null,
  attemptsCount: number,
  o: OutputRow | null,
  pubs: PublicationRow[],
  verdicts: VerdictRow[] = [],
  viewerId: string | null = null,
  fed: VersionCommentRow[] = [],
  signing: { secret: string; job: JobRow; exp: number } | null = null,
  credits: Credit[] = [],
  dests: { rows: DestinationPublicationRow[]; names: Map<string, string>; now: string } | null = null,
  parent: VersionRow | null = null,
  aspect: Aspect | null = null,
) {
  const mineV = verdicts.find((x) => x.versionN === v.n && x.userId === viewerId)
  // The look's name and version (looks plan §4.9), and a note when its current version wasn't made for this shape.
  const lookEntry = v.look && deps.looks ? getLook({ looks: deps.looks }, v.look.id) : null
  const lookNotice = lookEntry && aspect ? aspectNotice(lookEntry, aspect) : null
  const fileBase = `${deps.config.siteUrl}/api/v1/videos/${jobId}/versions/${v.n}`
  return {
    verdicts: {
      approved: verdicts.filter((x) => x.versionN === v.n && x.verdict === 'approved').length,
      changesRequested: verdicts.filter((x) => x.versionN === v.n && x.verdict === 'changes_requested')
        .length,
      mine: mineV?.verdict ?? null,
    },
    plan: v.plan ? { planId: v.plan.planId, brief: v.plan.brief, answers: v.plan.qa } : null,
    incorporates: fed.length,
    feedback: fed.map((c) => ({
      author: c.authorName,
      body: c.body,
      timeSec: c.timeSec,
      spot: c.x !== null && c.y !== null,
    })),
    editable: v.status === 'ready' && v.contract === 1,
    // What the editor may offer on this version's engine (render-engines §4.2); editable still decides whether it opens.
    editing: { engine: engineOf(v), capabilities: engineInfo(engineOf(v)).capabilities },
    beats: v.beats ?? null,
    // The redone scenes, named from the version they came from ("Redid Features"); an id is its own fallback.
    scope: v.scope
      ? {
          beats: v.scope.beats.map((id) => ({
            id,
            label: parent?.beats?.find((b) => b.id === id)?.label ?? id,
          })),
        }
      : null,
    look: v.look ? { id: v.look.id, name: v.look.name, hash: v.look.hash } : null,
    mode: v.mode ?? 'author',
    editedFromN: v.editedFromN ?? null,
    n: v.n,
    status: v.status,
    prompt: v.prompt,
    authorId: v.authorId,
    parentN: v.parentN,
    targetDurationSec: v.targetDurationSec,
    sound: v.sound ?? 'silent',
    voiceover: v.voiceover ?? null,
    createdAt: v.createdAt,
    attempts: attemptsCount,
    stage: a?.stage ?? null,
    latestStep: a?.latestStep ?? null,
    music: musicPickDto(a?.musicPick),
    error: a?.errorCategory ? { category: a.errorCategory, message: a.errorMessage ?? '' } : null,
    agent: a
      ? {
          agent: a.agent,
          model: a.model,
          effort: a.effort,
          deployId: a.deployId,
          promptTemplateVersion: a.promptTemplateVersion,
        }
      : null,
    usage: a?.usage ?? null,
    timings: a
      ? { queuedAt: a.queuedAt, startedAt: a.startedAt, finishingAt: a.finishingAt, endedAt: a.endedAt }
      : null,
    output: o
      ? {
          durationSec: o.durationSec,
          width: o.width,
          height: o.height,
          bytes: o.bytes,
          title: o.title,
          summary: o.agentSummary,
          notices: [...(o.notices ?? []), ...(lookNotice ? [lookNotice] : [])],
        }
      : null,
    captions: v.captions
      ? { status: v.captions.status, policy: v.captions.policy, rev: v.captions.rev }
      : null,
    poster: v.poster?.custom ? { source: v.poster.custom.source, at: v.poster.custom.at } : null,
    links: {
      video: `${fileBase}/video`,
      poster: `${fileBase}/poster`,
      gif: `${fileBase}/gif`,
      captions: `${fileBase}/captions`,
      // Recorded narration's downloads, when the version has them (plan 2026-11-02 §6.7).
      ...(o && versionFileName(v, o, 'narration-audio')
        ? { narrationAudio: `${fileBase}/narration-audio` }
        : {}),
      ...(o && versionFileName(v, o, 'transcript') ? { transcript: `${fileBase}/transcript` } : {}),
      netlifyRun: a?.runnerId ? deps.runner.runUrl(a.runnerId, a.sessionId) : null,
    },
    // Signed image URLs, so the UI skips the redirect. One expiry per DTO keeps them stable for the browser cache.
    files:
      o && signing
        ? signedFiles(deps.config.siteUrl, signing, v.n, o.previews ?? null, v.poster ?? null)
        : null,
    // CC BY media it was made with: the library's provenance, plus Openverse files the run fetched (checked by finalize).
    credits,
    publications: pubs
      .filter((p) => p.versionN === v.n)
      .map((p) => publicationDto(deps, p, o, credits, v.poster ?? null)),
    // Publish destinations (§6.1): the share page's entries, then each destination publication.
    destinations: [
      ...pubs
        .filter((p) => p.versionN === v.n)
        .map((p) => sharePageEntry(p, `${deps.config.siteUrl}/v/${p.slug}`)),
      ...(dests?.rows ?? [])
        .filter((p) => p.versionN === v.n)
        .map((p) =>
          destinationPublicationDto(p, dests?.names ?? new Map<string, string>(), dests?.now ?? ''),
        ),
    ],
  }
}

/** Signed poster and GIF URLs, plus the preview variants and placeholder for versions that have them. */
function signedFiles(
  site: string,
  signing: { secret: string; job: JobRow; exp: number },
  n: number,
  previews: Previews | null,
  poster: VersionPoster | null,
) {
  const url = (file: Parameters<typeof signFile>[3], name?: string) =>
    `${site}${signFile(signing.secret, signing.job, n, file, signing.exp, name)}`
  const has = (f: PreviewFile) => Boolean(previews?.files[f])
  // A picked poster (src/domain/poster.ts) replaces the render's stills: its own JPEG, WebPs and placeholder.
  const custom = poster?.custom ?? null
  // Best format first, as <picture> and <video> pick the first source the browser supports.
  const posterSources = custom
    ? [
        {
          type: 'image/webp' as const,
          srcset: (
            [
              [480, custom.files.webp480],
              [960, custom.files.webp960],
            ] as const
          )
            .filter(([, name]) => name)
            .map(([w, name]) => `${url(`poster-${w}.webp`, name ?? undefined)} ${w}w`)
            .join(', '),
        },
      ].filter((s) => s.srcset)
    : (['avif', 'webp'] as const)
        .map((fmt) => ({
          type: `image/${fmt}` as const,
          srcset: ([480, 960] as const)
            .filter((w) => has(`poster-${w}.${fmt}`))
            .map((w) => `${url(`poster-${w}.${fmt}`)} ${w}w`)
            .join(', '),
        }))
        .filter((s) => s.srcset)
  const clip = (['clip.webm', 'clip.mp4'] as const)
    .filter(has)
    .map((f) => ({ type: f === 'clip.webm' ? ('video/webm' as const) : ('video/mp4' as const), src: url(f) }))
  const lqip = custom ? custom.lqip : (previews?.lqip ?? null)
  return {
    poster: url('poster', custom?.files.jpg),
    gif: url('gif'),
    ...(posterSources.length ? { posterSources } : {}),
    ...(clip.length ? { clip } : {}),
    ...(lqip ? { lqip } : {}),
  }
}

/** `viewer` is the principal the DTO is for (visibility enforced), or 'system' for webhooks and other
 * server-side uses that already decided who receives it. */
export async function videoDto(
  repo: Repo,
  deps: DtoDeps,
  jobId: string,
  viewer: Principal,
  prefetched?: DtoPrefetched,
): Promise<VideoDtoShape>
export async function videoDto(
  repo: Repo,
  deps: Pick<Deps, 'config' | 'runner'>,
  jobId: string,
  viewer: 'system',
): Promise<VideoDtoShape>
export async function videoDto(
  repo: Repo,
  deps: Pick<Deps, 'config' | 'runner'> & Partial<DtoDeps>,
  jobId: string,
  viewer: Principal | 'system',
  prefetched?: DtoPrefetched,
) {
  return buildVideoDto(repo, deps, jobId, viewer, prefetched)
}

type DtoDeps = Pick<Deps, 'config' | 'runner' | 'store' | 'ids' | 'clock' | 'blobs' | 'looks'>
type VideoDtoShape = Awaited<ReturnType<typeof buildVideoDto>>
/** What a list page already loaded for all its videos, so each DTO doesn't query it again. */
interface DtoPrefetched {
  verdicts: VerdictRow[]
  comments: Record<string, CommentCounts>
  favorites: string[]
  /** Remixes' source videos on the page, by id (pageRepo only finds the page's own jobs). */
  remixSources?: Map<string, JobRow | null>
}

async function buildVideoDto(
  repo: Repo,
  deps: Pick<Deps, 'config' | 'runner'> & Partial<DtoDeps>,
  jobId: string,
  viewer: Principal | 'system',
  prefetched?: DtoPrefetched,
) {
  const job = await repo.getJob(jobId)
  if (!job || job.deletedAt || (viewer !== 'system' && !canSee(viewer, job)))
    throw new ApiError('not_found', 'Video not found.')
  const [versions, attempts, pubs, verdicts, fed, provenance, dpubs, destRows] = await Promise.all([
    repo.listVersions(jobId),
    repo.listAttempts(jobId),
    repo.listPublications(jobId),
    prefetched ? prefetched.verdicts.filter((x) => x.jobId === jobId) : repo.listVerdicts([jobId]),
    repo.listVersionComments(jobId),
    repo.versionProvenance(jobId),
    repo.listDestinationPublications(jobId),
    repo.listDestinations(),
  ])
  const dests = {
    rows: dpubs,
    names: destinationNames(destRows),
    now: (deps.clock ?? { now: () => new Date() }).now().toISOString(),
  }
  // Webhooks ('system') get no signed URLs: they'd expire long before anyone used them.
  const { store, ids, clock, blobs } = deps
  const signing =
    viewer === 'system' || !store || !ids || !clock || !blobs
      ? null
      : {
          secret: (await getSettings({ store, ids, clock, blobs })).fileSigningSecret,
          job,
          exp: stableExp(clock.now().getTime() / 1000, fileTtl(job, PUBLIC_URL_TTL_SEC)),
        }
  const out = await Promise.all(
    versions.map(async (v) => {
      const mine = attempts.filter((a) => a.versionN === v.n)
      const output = await repo.getOutput(jobId, v.n)
      return versionDto(
        deps,
        jobId,
        v,
        mine[0] ?? null,
        mine.length,
        output,
        pubs,
        verdicts,
        viewer === 'system' ? null : viewer.userId,
        fed.filter((c) => c.versionN === v.n).sort((a, b) => a.position - b.position),
        signing,
        versionCredits(provenance, v, output?.runCredits),
        dests,
        v.parentN !== null ? (versions.find((x) => x.n === v.parentN) ?? null) : null,
        job.aspect,
      )
    }),
  )
  const owner = await repo.getUser(job.ownerId)
  const viewerId = viewer === 'system' ? null : viewer.userId
  const comments = prefetched
    ? prefetched.comments[jobId]
    : (await repo.commentCounts([jobId], viewerId))[jobId]
  const favorite = prefetched
    ? prefetched.favorites.includes(jobId)
    : viewerId !== null && (await repo.favoriteJobIds(viewerId, [jobId])).length > 0
  // Provenance (remix spec §3.6): the source only when this viewer can see it; webhooks ('system') never get it.
  let remixOf: { id: string; n: number; title: string } | null = null
  if (job.remixOfJobId && viewer !== 'system') {
    const src = prefetched?.remixSources?.has(job.remixOfJobId)
      ? (prefetched.remixSources.get(job.remixOfJobId) ?? null)
      : await repo.getJob(job.remixOfJobId)
    if (src && !src.deletedAt && canSee(viewer, src))
      remixOf = { id: src.id, n: job.remixOfN ?? 1, title: src.title }
  }
  return {
    id: job.id,
    title: job.title,
    aspect: job.aspect,
    dimensions: ASPECTS[job.aspect],
    status: job.status,
    owner: { id: job.ownerId, name: owner?.name ?? null, email: owner?.email ?? null },
    latestVersion: job.latestVersion,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // Starring is the viewer's own and doesn't bump job.version, so it's part of the validator.
    // The source's visibility and title are part of it too: a source made private or renamed must not 304.
    // So are the live publications: ones made before publishing moved job.version must not 304 either.
    etag: `"${job.id}-${job.version}${favorite ? '-f' : ''}${remixOf ? `-r${sha256Hex(remixOf.title).slice(0, 8)}` : ''}${livePubTag(pubs)}${destinationTag(dpubs)}"`,
    versions: out,
    published: pubs.some((p) => !p.unpublishedAt) || dpubs.some((p) => p.status === 'live'),
    private: job.private,
    language: job.language,
    comments: comments ?? { count: 0, unread: 0 },
    isRemix: !!job.remixOfJobId,
    remixOf,
    favorite,
    links: { self: `${deps.config.siteUrl}/api/v1/videos/${job.id}` },
  }
}

export type VideoDto = VideoDtoShape

type Cursor = { createdAt: string; id: string }

/** Reads an opaque list cursor; a malformed one is a 400. */
export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
  } catch {
    throw new ApiError('invalid_request', 'Invalid cursor.')
  }
}

/** The cursor after the last row of `page`, or null when `total` fits in `limit`. */
export function nextCursor(total: number, limit: number, page: Cursor[]): string | null {
  const last = page.at(-1)
  return total > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url')
    : null
}

/**
 * A repo that answers a page's per-video reads from rows loaded for the whole page at once (store.videoPage), and
 * passes everything else to the store. The library's 24 videos took over 250 queries one by one; now a handful.
 */
function pageRepo(store: Repo, rows: VideoPageRows): Repo {
  const of = <T extends { jobId: string }>(list: T[], jobId: string) => list.filter((r) => r.jobId === jobId)
  let destinations: ReturnType<Repo['listDestinations']> | null = null
  const reads: Partial<Repo> = {
    // One read for the whole page (the names of HTTP destinations).
    listDestinations: () => (destinations ??= store.listDestinations()),
    getJob: async (id, opts) =>
      opts?.lock ? store.getJob(id, opts) : (rows.jobs.find((j) => j.id === id) ?? null),
    listVersions: async (jobId) => of(rows.versions, jobId),
    listAttempts: async (jobId) => of(rows.attempts, jobId),
    listPublications: async (jobId) => of(rows.publications, jobId),
    getOutput: async (jobId, n) => rows.outputs.find((o) => o.jobId === jobId && o.versionN === n) ?? null,
    listVersionComments: async (jobId, n) =>
      of(rows.versionComments, jobId).filter((r) => n === undefined || r.versionN === n),
    // The per-video query doesn't return jobId; neither does this.
    versionProvenance: async (jobId) =>
      of(rows.provenance, jobId).map((r) => {
        const row: Partial<typeof r> = { ...r }
        delete row.jobId
        return row as VersionProvenanceRow
      }),
    getUser: async (id) => rows.owners.find((u) => u.id === id) ?? store.getUser(id),
    listDestinationPublications: async (jobId) => of(rows.destinationPublications, jobId),
  }
  return new Proxy(store, {
    get: (target, key, receiver): unknown =>
      Object.hasOwn(reads, key) ? reads[key as keyof Repo] : Reflect.get(target, key, receiver),
  })
}

export async function listVideos(
  deps: Deps,
  principal: Principal,
  q: {
    owner?: 'me' | 'all' | undefined
    status?: JobRow['status'] | undefined
    published?: boolean | undefined
    favorite?: boolean | undefined
    q?: string | undefined
    cursor?: string | undefined
    limit?: number | undefined
  },
) {
  assertCan(principal, 'video:read')
  const limit = Math.min(Math.max(q.limit ?? 24, 1), 50)
  const cursor = decodeCursor(q.cursor === 'undefined' ? undefined : q.cursor)
  const rows = await deps.store.listJobs({
    ...(q.owner === 'me' ? { ownerId: principal.userId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.published !== undefined ? { published: q.published } : {}),
    ...(q.favorite ? { favoriteOf: principal.userId } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(cursor ? { cursor } : {}),
    visibleTo: { userId: principal.userId, all: principal.role === 'admin' },
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  // Verdict counts for the whole page in one query.
  const ids = page.map((j) => j.id)
  const [verdicts, comments, favorites, pageRows] = await Promise.all([
    deps.store.listVerdicts(ids),
    deps.store.commentCounts(ids, principal.userId),
    deps.store.favoriteJobIds(principal.userId, ids),
    deps.store.videoPage(ids),
  ])
  const repo = pageRepo(deps.store, pageRows)
  const sourceIds = [...new Set(page.flatMap((j) => (j.remixOfJobId ? [j.remixOfJobId] : [])))]
  const remixSources = new Map(
    await Promise.all(sourceIds.map(async (id) => [id, await deps.store.getJob(id)] as const)),
  )
  const items = await Promise.all(
    page.map((j) => videoDto(repo, deps, j.id, principal, { verdicts, comments, favorites, remixSources })),
  )
  return { items, nextCursor: nextCursor(rows.length, limit, page) }
}

/** Stars or unstars a video in your own library. Anyone who can see a video can star it; nobody else sees it. */
export async function setFavorite(deps: Deps, principal: Principal, jobId: string, on: boolean) {
  assertCan(principal, 'video:read')
  await loadJob(deps.store, principal, jobId)
  await deps.store.setFavorite(principal.userId, jobId, on, deps.clock.now().toISOString())
}

/** Approved / Changes requested on a ready version (plan v2 §3, §14 rule 8). Never on your own version. */
export async function setVerdict(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
  input: { verdict: Verdict | null; note?: string | undefined },
) {
  return deps.store.tx(async (repo) => {
    await loadJob(repo, principal, jobId)
    assertCan(principal, 'verdict:set')
    const v = await repo.getVersion(jobId, n)
    if (!v) throw new ApiError('not_found', 'Version not found.')
    if (v.authorId === principal.userId)
      throw new ApiError('forbidden', "You can't approve your own version.")
    if (v.status !== 'ready') throw new ApiError('conflict', 'Only ready versions can be approved.')
    if (input.verdict === null) {
      await repo.deleteVerdict(jobId, n, principal.userId)
    } else {
      await repo.putVerdict({
        jobId,
        versionN: n,
        userId: principal.userId,
        verdict: input.verdict,
        note: input.note?.trim() || null,
        updatedAt: deps.clock.now().toISOString(),
      })
      await emitEvent(repo, deps, {
        type: input.verdict === 'approved' ? 'version.approved' : 'version.changes_requested',
        jobId,
        versionN: n,
        data: {
          verdict: {
            by: { id: principal.userId, name: principal.name, email: principal.email },
            verdict: input.verdict,
            note: input.note?.trim() || null,
          },
        },
      })
      const who = principal.name ?? principal.email
      const note = input.note?.trim() ? `: ${input.note.trim()}` : ''
      await notifyOwner(repo, deps, {
        type: input.verdict === 'approved' ? 'version.approved' : 'version.changes_requested',
        jobId,
        versionN: n,
        actorId: principal.userId,
        summary:
          input.verdict === 'approved'
            ? `${who} approved v${n}${note}`
            : `${who} requested changes on v${n}${note}`,
      })
    }
    const job = await repo.getJob(jobId)
    if (job) await repo.updateJob(jobId, { version: job.version + 1 })
    return videoDto(repo, deps, jobId, principal)
  })
}

/**
 * Moves job ownership (plan v2 §3, §14 rule 7). Version authorship, API keys and usage attribution stay with the
 * people who made them. Bumps the ETag version and the access epoch (old private links stop working).
 */
export async function transferVideos(
  deps: Deps,
  principal: Principal,
  input: { jobIds?: string[] | undefined; fromUserId?: string | undefined; toUserId: string },
) {
  assertCan(principal, 'video:transfer')
  return deps.store.tx(async (repo) => {
    const to = await repo.getUser(input.toUserId)
    if (!to || to.disabledAt) throw new ApiError('invalid_request', 'Pick an active person to transfer to.')
    if (to.role !== 'admin' && to.role !== 'creator')
      throw new ApiError('invalid_request', 'Videos can only be transferred to a Creator or an Admin.')
    let ids = input.jobIds ?? []
    if (input.fromUserId) {
      const owned = await repo.listJobs({ ownerId: input.fromUserId, limit: 10_000 })
      ids = [...ids, ...owned.map((j) => j.id)]
    }
    const now = deps.clock.now().toISOString()
    const moved: string[] = []
    for (const id of new Set(ids)) {
      const job = await loadJob(repo, principal, id, true)
      if (job.ownerId === to.id) continue
      await repo.updateJob(id, {
        ownerId: to.id,
        version: job.version + 1,
        accessEpoch: job.accessEpoch + 1,
        updatedAt: now,
      })
      await repo.insertOwnershipTransfer({
        id: deps.ids.uuid(),
        jobId: id,
        fromUserId: job.ownerId,
        toUserId: to.id,
        byUserId: principal.userId,
        at: now,
      })
      if (job.private) await writeAccessMirror(deps, { id, private: true, accessEpoch: job.accessEpoch + 1 })
      moved.push(id)
    }
    return { transferred: moved.length, videoIds: moved }
  })
}
