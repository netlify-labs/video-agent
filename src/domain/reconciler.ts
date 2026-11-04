// The reconciler owns every attempt outcome. The sweep calls `tick` every minute; callbacks only
// wake it up. Each step is persisted so a crash resumes instead of restarting.
import { creditFor } from './credits.js'
import type { Deps, RunnerSnapshot, StartRequest } from '../deps.js'
import { RunnerError } from '../deps.js'
import { decrypt, encrypt, sha256Hex } from '../lib/crypto.js'
import {
  RUN_MANIFEST_VERSION,
  feedbackStillPath,
  runManifestKey,
  serializeRunManifest,
  type RunManifest,
} from '../lib/run-manifest.js'
import { getSettings } from './settings.js'
import { contextMeta } from '../generated/context.js'
import { clip } from '../lib/log.js'
import { PROMPT_TEMPLATE_VERSION, buildFitPrompt, buildPrompt, buildRenderUnchangedPrompt } from './prompt.js'
import { NARRATION_SRC } from '../lib/contract.js'
import { setStage } from './videos.js'
import { readReferences } from './bundles.js'
import type { BundleReference } from '../lib/bundle-references.js'
import { MUSIC_POLL_MS, advanceMusicPick, attachTrack, needsMusicPick, newMusicPick } from './music-pick.js'
import { emitTerminalEvent } from './webhooks.js'
import type { AttemptRow, FailureCategory, FrozenBundle } from './types.js'

const MIN = 60_000
const SEND_WINDOW_GRACE_MS = 5 * MIN
const STOP_CONFIRM_MS = 5 * MIN

export interface TickBudget {
  deadline: number
  maxItems: number
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Claims free slots for the oldest queued attempts. Locks queue_control first so two sweeps can't overfill. */
export async function claimSlots(deps: Deps): Promise<number> {
  let claimed = 0
  await getSettings(deps)
  for (;;) {
    const got = await deps.store.tx(async (repo) => {
      await repo.lockQueueControl()
      // Read the pause flag inside the lock, never from the settings cache.
      if ((await repo.getSettings())?.queuePausedReason) return false
      if ((await repo.countSlotHolders()) >= deps.config.maxActiveRuns) return false
      const now = deps.clock.now()
      const next = await repo.claimOldestQueued(now.toISOString())
      if (!next) return false
      const queuedFor = now.getTime() - new Date(next.queuedAt).getTime()
      if (queuedFor > deps.config.queueTimeoutMin * MIN) {
        await setStage(
          repo,
          next,
          'failed',
          terminal(now, 'queue_timeout', 'Waited too long in the queue.'),
          now.toISOString(),
        )
        await emitTerminalEvent(repo, deps, next.id)
        return true
      }
      return setStage(
        repo,
        next,
        'starting',
        { nextActionAt: now.toISOString(), leaseUntil: null },
        now.toISOString(),
      )
    })
    if (!got) return claimed
    claimed++
  }
}

function terminal(now: Date, category: FailureCategory | null, message: string | null) {
  return {
    endedAt: now.toISOString(),
    nextActionAt: null,
    leaseUntil: null,
    errorCategory: category,
    errorMessage: message,
  }
}

/** Takes a lease on an attempt so overlapping sweeps don't process it twice. */
export async function lease(deps: Deps, attempt: AttemptRow, ms: number): Promise<AttemptRow | null> {
  const now = deps.clock.now()
  const until = iso(now.getTime() + ms)
  const ok = await deps.store.leaseAttempt(attempt.id, attempt.stage, now.toISOString(), until)
  return ok ? { ...attempt, leaseUntil: until } : null
}

/** Leases an attempt and runs its next step (false if a sweep holds it); a failed step is retried in a minute. */
async function leaseAndStep(deps: Deps, a: AttemptRow): Promise<boolean> {
  const leased = await lease(deps, a, 2 * MIN)
  if (!leased) return false
  try {
    await step(deps, leased)
  } catch (e) {
    deps.log.error('reconciler.step_failed', { attemptId: a.id, stage: a.stage, error: e })
    await deps.store.updateAttempt(a.id, {
      leaseUntil: null,
      nextActionAt: iso(deps.clock.now().getTime() + MIN),
    })
  }
  return true
}

export async function tick(deps: Deps, budget: TickBudget): Promise<{ claimed: number; processed: number }> {
  const claimed = await claimSlots(deps)
  let processed = 0
  const due = await deps.store.listDueAttempts(deps.clock.now().toISOString(), budget.maxItems)
  for (const a of due) {
    if (Date.now() > budget.deadline) break
    if (await leaseAndStep(deps, a)) processed++
  }
  if (processed > 0 || claimed > 0) await claimSlots(deps)
  return { claimed, processed }
}

export async function step(deps: Deps, a: AttemptRow): Promise<void> {
  switch (a.stage) {
    case 'finding_music':
      return findingMusic(deps, a)
    case 'starting':
      return start(deps, a)
    case 'running':
      return poll(deps, a)
    case 'cancelling':
      return stopping(deps, a)
    case 'finishing':
      return finishing(deps, a)
    default:
      await deps.store.updateAttempt(a.id, { leaseUntil: null, nextActionAt: null })
  }
}

async function handleOf(deps: Deps, a: AttemptRow): Promise<string> {
  if (!a.handleEnc) throw new Error('attempt has no handle')
  return decrypt((await getSettings(deps)).dataEncryptionKey, a.handleEnc)
}

async function startRequest(
  deps: Deps,
  a: AttemptRow,
  callbackToken: string,
): Promise<{ req: StartRequest; parentSha: string | null }> {
  const job = await deps.store.getJob(a.jobId)
  const version = await deps.store.getVersion(a.jobId, a.versionN)
  if (!job || !version) throw new Error('attempt without job/version')
  const author = await deps.store.getUser(version.authorId)
  let revision: {
    /** Null for a remix: it restores the copy of the video it remixes (docs/plans/2026-11-03-remix.md §3.2). */
    parentN: number | null
    sourceKey: string
    sourceSha256: string
    references: BundleReference[]
    /** The parent's recorded narration bus, in samples: locked through the revision (plan 2026-11-02 §6.4). */
    narrationSamples: number | null
  } | null = null
  // Library media for this version, downloaded by prepare-run into video/assets/media/ (plan v2 §9).
  const versionMedia = await deps.store.listVersionMedia(a.jobId, a.versionN)
  const media = versionMedia.length
    ? versionMedia.map((m) => ({ key: m.key, sha256: m.sha256, filename: m.filename, kind: m.kind }))
    : null
  const result = (prompt: string, parentSha: string | null) => ({
    req: {
      requestId: a.id,
      prompt,
      deployId: a.deployId,
      agent: a.agent,
      model: a.model,
      effort: a.effort,
      deadlineMs: (deps.config.authoringDeadlineMin + 3) * MIN,
    },
    parentSha,
  })
  // The frozen bundle as a run restores it: the edited draft, with any lines to re-voice and recorded narration.
  const frozenBundle = (f: FrozenBundle) => ({
    key: f.key,
    sha256: f.sha256,
    manifestHash: f.manifestHash,
    ...(f.revoice ? { revoice: f.revoice } : {}),
    ...(f.references?.length ? { references: f.references } : {}),
    // Recorded narration: prepare-run hydrates its takes into .va-run/, never video/ (plan 2026-11-02 §6.3).
    ...(f.narration ? { narration: f.narration } : {}),
  })
  // Inputs to restore go in a server-written manifest the run verifies by hash (plan v2 §14 rule 21). Returns the hash.
  const putManifest = async (m: Omit<RunManifest, 'v' | 'jobId' | 'attemptId' | 'versionN'>) => {
    const manifest = serializeRunManifest({
      v: RUN_MANIFEST_VERSION,
      jobId: a.jobId,
      attemptId: a.id,
      versionN: a.versionN,
      ...m,
    })
    await deps.blobs.set('sources', runManifestKey(a.jobId, a.id), manifest, {
      contentType: 'application/json',
    })
    return sha256Hex(manifest)
  }
  const runUrls = {
    callbackUrl: `${deps.config.siteUrl}/api/internal/runs/${a.id}/done`,
    checkpointUrl: `${deps.config.siteUrl}/api/internal/runs/${a.id}/checkpoint`,
  }
  // An edit draft rendered as is (plan v2 §8): restore the frozen bundle, check it, render it, change nothing.
  if (version.mode === 'render_unchanged' && version.frozen) {
    const runManifestSha256 = await putManifest({
      kind: 'render_unchanged',
      source: null,
      bundle: frozenBundle(version.frozen),
      media,
      feedback: null,
    })
    const prompt = buildRenderUnchangedPrompt({
      jobId: a.jobId,
      attemptId: a.id,
      versionN: a.versionN,
      editedFromN: version.editedFromN ?? version.parentN ?? 0,
      revoice: version.frozen.revoice?.beats ?? [],
      narration: !!version.frozen.narration,
      runManifestSha256,
      ...runUrls,
      callbackToken,
      upload: { mode: 'blobs' },
    })
    return result(prompt, null)
  }
  // Fit the video to my narration (plan 2026-11-02 §6.4): an authoring run that starts from the frozen edited draft,
  // never the parent's archive, with the narration it mixes and must not change. Every retry restores the same inputs.
  if (version.frozen?.narration) {
    const runManifestSha256 = await putManifest({
      kind: 'author_from_frozen',
      source: null,
      bundle: frozenBundle(version.frozen),
      media,
      feedback: null,
    })
    const prompt = buildFitPrompt({
      jobId: a.jobId,
      attemptId: a.id,
      versionN: a.versionN,
      editedFromN: version.editedFromN ?? version.parentN ?? 0,
      requesterName: author?.name ?? author?.email ?? 'a teammate',
      aspect: job.aspect,
      targetSamples: version.frozen.narration.targetSamples,
      revoice: version.frozen.revoice?.beats ?? [],
      sound: version.sound ?? 'silent',
      runManifestSha256,
      ...runUrls,
      callbackToken,
      upload: { mode: 'blobs' },
    })
    return result(prompt, null)
  }
  if (version.remix) {
    // A remix restores its own copy of the source (never the source video, which may be gone): a revision run.
    const r = version.remix
    if (!(await deps.blobs.list('sources', r.sourceKey)).includes(r.sourceKey))
      throw new SourceUnavailable("The remix's copied source is missing.")
    revision = {
      parentN: null,
      sourceKey: r.sourceKey,
      sourceSha256: r.sourceSha256,
      references: [],
      narrationSamples: null,
    }
  } else if (version.parentN !== null) {
    const parent = await deps.store.getOutput(a.jobId, version.parentN)
    const sha = parent?.sha256['source.tar.gz']
    if (!parent || !sha) throw new SourceUnavailable(`Version ${version.parentN} has no saved composition.`)
    // Its files kept outside the archive (the narration bus), restored by key with it.
    let references: BundleReference[]
    try {
      references = await readReferences(deps, parent)
    } catch (e) {
      throw new SourceUnavailable(`Version ${version.parentN}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // A narrated parent keeps its narration locked; a parent that was itself a revision has no versions.narration,
    // so its bus's length comes from the reference (scripts/narration.ts writes a 44-byte header, PCM16 mono).
    const bus = references.find((r) => r.path === NARRATION_SRC)
    const narrated = bus
      ? ((await deps.store.getVersion(a.jobId, version.parentN))?.narration?.bus.samples ??
        Math.max(0, Math.floor((bus.bytes - 44) / 2)))
      : null
    revision = {
      parentN: version.parentN,
      sourceKey: parent.sourceKey,
      sourceSha256: sha,
      references,
      narrationSamples: narrated,
    }
  }
  // Comments to incorporate, snapshotted on the version; pinned ones get stills from the parent MP4 (plan v2 §5).
  const snapshots = revision ? await deps.store.listVersionComments(a.jobId, a.versionN) : []
  const pins = snapshots.filter((c) => c.timeSec !== null)
  let feedbackVideo: { key: string; sha256: string } | null = null
  if (pins.length && version.parentN !== null) {
    const parent = await deps.store.getOutput(a.jobId, version.parentN)
    const sha = parent?.sha256['video.mp4']
    if (parent && sha) feedbackVideo = { key: parent.videoKey, sha256: sha }
  }
  const feedback = snapshots.map((c) => {
    const i = pins.indexOf(c)
    return {
      author: c.authorName,
      body: c.body,
      timeSec: c.timeSec,
      x: c.x,
      y: c.y,
      still: feedbackVideo && i >= 0 ? feedbackStillPath(i, c.commentId) : null,
      files: c.files ?? null,
    }
  })
  let runManifestSha256: string | null = null
  if (revision || media) {
    runManifestSha256 = await putManifest({
      kind: revision ? 'revision' : 'author',
      source: revision && {
        key: revision.sourceKey,
        sha256: revision.sourceSha256,
        parentN: revision.parentN,
        ...(revision.references.length ? { references: revision.references } : {}),
      },
      bundle: null,
      media,
      feedback: feedbackVideo && {
        video: feedbackVideo,
        pins: pins.map((c) => ({ commentId: c.commentId, timeSec: c.timeSec ?? 0, x: c.x, y: c.y })),
      },
    })
  }
  const prompt = buildPrompt({
    jobId: a.jobId,
    attemptId: a.id,
    versionN: a.versionN,
    requesterName: author?.name ?? author?.email ?? 'a teammate',
    userPrompt: version.prompt,
    aspect: job.aspect,
    targetDurationSec: version.targetDurationSec,
    ...runUrls,
    callbackToken,
    upload: { mode: 'blobs' },
    revision: revision && { parentN: revision.parentN },
    remix: version.remix ?? null,
    runManifestSha256,
    feedback,
    media: await Promise.all(
      versionMedia.map(async (m) => ({
        // PDFs are read, not shown: prepare-run puts them in context/media/ (a repo path, not one in video/).
        file: m.kind === 'pdf' ? `context/media/${m.filename}` : `assets/media/${m.filename}`,
        kind: m.kind,
        caption: m.caption,
        // A track's length helps place it, and a CC BY track says so; the library row outlives a soft delete.
        ...(m.kind === 'audio' ? await trackFacts(deps, m.mediaId) : {}),
      })),
    ),
    plan: version.plan ? { brief: version.plan.brief, qa: version.plan.qa } : null,
    sound: version.sound ?? 'silent',
    voiceover: version.voiceover ?? null,
    brandMusic: contextMeta.music,
    narration: revision?.narrationSamples ? { samples: revision.narrationSamples } : null,
  })
  return result(prompt, revision?.sourceSha256 ?? null)
}

async function trackFacts(deps: Deps, mediaId: string) {
  const m = await deps.store.getMedia(mediaId)
  const credit = m ? creditFor(m.id, m.kind, m) : null
  return { seconds: m?.durationSec ?? null, ...(credit ? { credit: credit.text } : {}) }
}

class SourceUnavailable extends Error {}

async function start(deps: Deps, a: AttemptRow): Promise<void> {
  const now = deps.clock.now()
  const settings = await getSettings(deps)

  // A previous start was ambiguous: reconcile the same logical create instead of starting another.
  if (a.sendWindow && !a.handleEnc && a.startRequestEnc) {
    const req = JSON.parse(decrypt(settings.dataEncryptionKey, a.startRequestEnc)) as StartRequest
    const res = await deps.runner.reconcile(req, a.sendWindow)
    if (res.kind === 'matched') {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'running',
          {
            handleEnc: encrypt(settings.dataEncryptionKey, res.handle),
            runnerId: res.runnerId,
            sessionId: res.sessionId,
            leaseUntil: null,
            nextActionAt: iso(now.getTime() + MIN),
          },
          now.toISOString(),
        ),
      )
      deps.log.info('attempt.reconciled', { attemptId: a.id, runnerId: res.runnerId })
      return
    }
    if (now.getTime() - a.sendWindow.failedAt > SEND_WINDOW_GRACE_MS || res.kind === 'ambiguous') {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'unresolved',
          { leaseUntil: null, nextActionAt: null, errorMessage: `reconcile: ${res.kind}` },
          now.toISOString(),
        ),
      )
      deps.log.warn('attempt.unresolved', { attemptId: a.id, reconcile: res.kind })
      return
    }
    await deps.store.updateAttempt(a.id, { leaseUntil: null, nextActionAt: iso(now.getTime() + MIN) })
    return
  }

  // A run that needs music and has none waits for the server to pick a track first (src/domain/music-pick.ts).
  if (await needsMusicPick(deps, a)) {
    const pick = newMusicPick(now)
    const ok = await deps.store.tx((repo) =>
      setStage(repo, a, 'finding_music', { musicPick: pick }, now.toISOString()),
    )
    if (ok) {
      deps.log.info('attempt.finding_music', { attemptId: a.id })
      await findingMusic(deps, { ...a, stage: 'finding_music', musicPick: pick })
    }
    return
  }

  // Persist the start intent before any network I/O.
  const token = deps.ids.secret(32)
  const deployId = a.deployId ?? (await deps.platform.productionDeployId())
  let req: StartRequest
  let parentSha: string | null
  try {
    ;({ req, parentSha } = await startRequest(deps, { ...a, deployId }, token))
  } catch (e) {
    if (!(e instanceof SourceUnavailable)) throw e
    deps.log.warn('attempt.source_unavailable', {
      attemptId: a.id,
      jobId: a.jobId,
      versionN: a.versionN,
      reason: e.message,
    })
    await deps.store.tx(async (repo) => {
      await setStage(repo, a, 'failed', terminal(now, 'source_unavailable', e.message), now.toISOString())
      await emitTerminalEvent(repo, deps, a.id)
    })
    return
  }
  // failedAt covers a crash anywhere in this function's lifetime (Functions time out within a minute).
  await deps.store.updateAttempt(a.id, {
    deployId,
    callbackTokenHash: sha256Hex(token),
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parentSourceSha256: parentSha,
    startRequestEnc: encrypt(settings.dataEncryptionKey, JSON.stringify(req)),
    sendWindow: { sentAt: now.getTime(), failedAt: now.getTime() + MIN },
  })

  // The whole prompt the agent run gets, minus its one-time callback token.
  deps.log.debug('run.start_request', {
    attemptId: a.id,
    jobId: a.jobId,
    versionN: a.versionN,
    prompt: clip(req.prompt.replaceAll(token, '[redacted]'), 40_000),
  })
  try {
    const res = await deps.runner.start(req)
    const after = deps.clock.now()
    await deps.store.tx((repo) =>
      setStage(
        repo,
        a,
        'running',
        {
          handleEnc: encrypt(settings.dataEncryptionKey, res.handle),
          runnerId: res.runnerId,
          sessionId: res.sessionId,
          sendWindow: null,
          startedAt: after.toISOString(),
          authoringDeadlineAt: iso(after.getTime() + deps.config.authoringDeadlineMin * MIN),
          leaseUntil: null,
          nextActionAt: iso(after.getTime() + MIN),
        },
        after.toISOString(),
      ),
    )
    deps.log.info('attempt.started', { attemptId: a.id, runnerId: res.runnerId, sessionId: res.sessionId })
  } catch (e) {
    const after = deps.clock.now()
    if (e instanceof RunnerError && e.kind === 'ambiguous') {
      await deps.store.updateAttempt(a.id, {
        sendWindow: e.window ?? { sentAt: now.getTime(), failedAt: after.getTime() },
        leaseUntil: null,
        nextActionAt: iso(after.getTime() + 30_000),
      })
      deps.log.warn('attempt.start_ambiguous', { attemptId: a.id })
      return
    }
    if (e instanceof RunnerError && e.kind === 'capacity') {
      const backoff = MIN + Math.floor(Math.random() * MIN)
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'queued',
          { sendWindow: null, leaseUntil: null, nextActionAt: iso(after.getTime() + backoff) },
          after.toISOString(),
        ),
      )
      deps.log.warn('attempt.requeued_capacity', { attemptId: a.id, backoffMs: backoff })
      return
    }
    const credits = e instanceof RunnerError && e.kind === 'credits'
    await deps.store.tx(async (repo) => {
      await setStage(
        repo,
        a,
        'failed',
        terminal(
          after,
          credits ? 'credits_unavailable' : 'start_failed',
          e instanceof Error ? e.message : String(e),
        ),
        after.toISOString(),
      )
      if (credits)
        await repo.updateSettings({ queuePausedReason: 'AI credits are unavailable for this team.' })
      await emitTerminalEvent(repo, deps, a.id)
    })
    deps.log.error('attempt.start_failed', { attemptId: a.id, credits, error: e })
  }
}

/** Moves a music pick on; once it's picked (the track joins the version's media) or skipped, the run starts. */
async function findingMusic(deps: Deps, a: AttemptRow): Promise<void> {
  let pick = await advanceMusicPick(deps, a)
  const now = deps.clock.now()
  if (pick.status === 'searching' || pick.status === 'importing') {
    await deps.store.updateAttempt(
      a.id,
      { musicPick: pick, leaseUntil: null, nextActionAt: iso(now.getTime() + MUSIC_POLL_MS) },
      'finding_music',
    )
    return
  }
  const ok = await deps.store.tx(async (repo) => {
    const fresh = await repo.getAttempt(a.id, { lock: true })
    if (fresh?.stage !== 'finding_music') return false
    if (pick.status === 'picked' && pick.mediaId && !(await attachTrack(repo, a, pick.mediaId)))
      pick = { ...pick, status: 'skipped', reason: "The track didn't fit in the version's media." }
    return setStage(
      repo,
      a,
      'starting',
      { musicPick: pick, nextActionAt: now.toISOString() },
      now.toISOString(),
    )
  })
  if (!ok) return
  deps.log.info('attempt.music_done', {
    attemptId: a.id,
    status: pick.status,
    source: pick.source ?? null,
    mediaId: pick.mediaId,
    tried: pick.tried?.map((t) => `${t.query}: ${t.outcome}`),
  })
  await start(deps, { ...a, stage: 'starting', musicPick: pick })
}

/**
 * openverse-background finished a job a music pick waits on: step that attempt now instead of at the next sweep. The
 * lease keeps it from racing a sweep.
 */
export async function wakeMusicPick(deps: Deps, openverseJobId: string): Promise<void> {
  const job = await deps.store.getOpenverseJob(openverseJobId)
  const attemptId = job?.params.attemptId
  if (typeof attemptId !== 'string') return
  const a = await deps.store.getAttempt(attemptId)
  if (a?.stage !== 'finding_music') return
  await leaseAndStep(deps, a)
}

async function poll(deps: Deps, a: AttemptRow): Promise<void> {
  const snap = await deps.runner.snapshot(await handleOf(deps, a))
  const now = deps.clock.now()
  if (snap.kind === 'running') {
    const patch = {
      latestStep: snap.latestStep,
      usage: snap.usage,
      leaseUntil: null,
      nextActionAt: iso(now.getTime() + MIN),
    }
    const reason =
      snap.state === 'await_input'
        ? 'needs_input'
        : a.authoringDeadlineAt && now.toISOString() > a.authoringDeadlineAt
          ? 'deadline'
          : null
    if (reason) {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'cancelling',
          {
            ...patch,
            cancelRequestedAt: now.toISOString(),
            cancelReason: reason,
            nextActionAt: now.toISOString(),
          },
          now.toISOString(),
        ),
      )
      deps.log.warn(`attempt.${reason}`, { attemptId: a.id })
      return
    }
    // render-job has reported the uploaded files: finish now rather than after the run's wrap-up (writing its results,
    // the runner's preview deploy), which can take minutes more. Finalize reads the files from the receipt.
    if (await deps.store.getReceipt(a.id)) {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'finishing',
          { ...patch, finishingAt: now.toISOString(), nextActionAt: now.toISOString() },
          now.toISOString(),
        ),
      )
      await deps.store.updateAttempt(a.id, { leaseUntil: iso(now.getTime() + 2 * MIN) })
      await deps.platform.dispatchFinalize(a.id)
      return
    }
    await deps.store.updateAttempt(a.id, patch)
    return
  }
  await onTerminal(deps, a, snap)
}

/** A terminal remote state was observed: free the slot, then finalize or record the outcome. */
async function onTerminal(deps: Deps, a: AttemptRow, snap: Extract<RunnerSnapshot, { kind: 'terminal' }>) {
  const now = deps.clock.now()
  const fresh = (await deps.store.getAttempt(a.id)) ?? a
  const base = { usage: snap.usage, leaseUntil: null }
  await deps.store.tx(async (repo) => {
    if (fresh.cancelReason) {
      const stage =
        fresh.cancelReason === 'deadline'
          ? 'timed_out'
          : fresh.cancelReason === 'needs_input'
            ? 'failed'
            : 'cancelled'
      const category = fresh.cancelReason === 'needs_input' ? 'needs_input' : null
      const msg =
        fresh.cancelReason === 'needs_input'
          ? 'The agent stopped to ask a question. Make the request more specific and try again.'
          : fresh.cancelReason === 'deadline'
            ? 'The run took longer than the authoring deadline.'
            : null
      await setStage(repo, fresh, stage, { ...base, ...terminal(now, category, msg) }, now.toISOString())
      await emitTerminalEvent(repo, deps, a.id)
      return
    }
    if (snap.status === 'succeeded') {
      await setStage(
        repo,
        fresh,
        'finishing',
        { ...base, finishingAt: now.toISOString(), nextActionAt: now.toISOString() },
        now.toISOString(),
      )
      await repo.updateAttempt(a.id, {
        latestStep: snap.resultText ? 'Finished authoring' : fresh.latestStep,
        resultText: snap.resultText?.slice(0, 4000) ?? null,
      })
      return
    }
    const stage =
      snap.status === 'cancelled' ? 'cancelled' : snap.status === 'timedOut' ? 'timed_out' : 'failed'
    await setStage(
      repo,
      fresh,
      stage,
      {
        ...base,
        ...terminal(now, stage === 'failed' ? 'runner_failed' : null, snap.failure?.message ?? null),
      },
      now.toISOString(),
    )
    await emitTerminalEvent(repo, deps, a.id)
  })
  if (snap.status === 'succeeded' && !fresh.cancelReason) {
    await deps.store.updateAttempt(a.id, { leaseUntil: iso(now.getTime() + 2 * MIN) })
    await deps.platform.dispatchFinalize(a.id)
  }
}

async function stopping(deps: Deps, a: AttemptRow): Promise<void> {
  const handle = await handleOf(deps, a)
  const snap = await deps.runner.snapshot(handle)
  if (snap.kind === 'terminal') return onTerminal(deps, a, snap)
  try {
    await deps.runner.stop(handle)
  } catch (e) {
    deps.log.warn('attempt.stop_failed', { attemptId: a.id, error: e })
  }
  const now = deps.clock.now()
  const since = a.cancelRequestedAt ? now.getTime() - new Date(a.cancelRequestedAt).getTime() : 0
  if (since > STOP_CONFIRM_MS) deps.log.error('attempt.stop_unconfirmed', { attemptId: a.id, sinceMs: since })
  await deps.store.updateAttempt(a.id, { leaseUntil: null, nextActionAt: iso(now.getTime() + 30_000) })
}

async function finishing(deps: Deps, a: AttemptRow): Promise<void> {
  const now = deps.clock.now()
  const startedFinishing = a.finishingAt ? new Date(a.finishingAt).getTime() : now.getTime()
  if (now.getTime() - startedFinishing > deps.config.finalizeDeadlineMin * MIN) {
    await deps.store.tx(async (repo) => {
      await setStage(
        repo,
        a,
        'failed',
        terminal(
          now,
          'artifacts_missing',
          "The video files didn't arrive, or didn't match what the agent reported, in time.",
        ),
        now.toISOString(),
      )
      await emitTerminalEvent(repo, deps, a.id)
    })
    return
  }
  // The lease taken by tick() covers the background worker; re-dispatch when it expires.
  await deps.store.updateAttempt(a.id, {
    leaseUntil: iso(now.getTime() + 2 * MIN),
    nextActionAt: iso(now.getTime() + 2 * MIN),
  })
  await deps.platform.dispatchFinalize(a.id)
}

/** Admin action for an unresolved start: mark failed and release the slot. */
export async function resolveUnresolved(deps: Deps, attemptId: string) {
  const now = deps.clock.now()
  return deps.store.tx(async (repo) => {
    const a = await repo.getAttempt(attemptId, { lock: true })
    if (!a || a.stage !== 'unresolved') return false
    await setStage(
      repo,
      a,
      'failed',
      terminal(now, 'unresolved_start', 'Marked failed by an admin after an unresolved start.'),
      now.toISOString(),
    )
    await emitTerminalEvent(repo, deps, a.id)
    return true
  })
}
