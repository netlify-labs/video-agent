// The reconciler owns every attempt outcome. The sweep calls `tick` every minute; callbacks only
// wake it up. Each step is persisted so a crash resumes instead of restarting.
import type { Deps, RunnerSnapshot, StartRequest } from '../deps.js'
import { RunnerError } from '../deps.js'
import { decrypt, encrypt, sha256Hex } from '../lib/crypto.js'
import { RUN_MANIFEST_VERSION, runManifestKey, serializeRunManifest } from '../lib/run-manifest.js'
import { getSettings } from './settings.js'
import { PROMPT_TEMPLATE_VERSION, buildPrompt } from './prompt.js'
import { setStage } from './videos.js'
import { emitTerminalEvent } from './webhooks.js'
import type { AttemptRow, FailureCategory } from './types.js'

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

export async function tick(deps: Deps, budget: TickBudget): Promise<{ claimed: number; processed: number }> {
  const claimed = await claimSlots(deps)
  let processed = 0
  const due = await deps.store.listDueAttempts(deps.clock.now().toISOString(), budget.maxItems)
  for (const a of due) {
    if (Date.now() > budget.deadline) break
    const leased = await lease(deps, a, 2 * MIN)
    if (!leased) continue
    try {
      await step(deps, leased)
    } catch (e) {
      deps.log.error('reconciler.step_failed', { attemptId: a.id, stage: a.stage, error: e })
      await deps.store.updateAttempt(a.id, {
        leaseUntil: null,
        nextActionAt: iso(deps.clock.now().getTime() + MIN),
      })
    }
    processed++
  }
  if (processed > 0 || claimed > 0) await claimSlots(deps)
  return { claimed, processed }
}

export async function step(deps: Deps, a: AttemptRow): Promise<void> {
  switch (a.stage) {
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
  let revision: { parentN: number; sourceKey: string; sourceSha256: string } | null = null
  if (version.parentN !== null) {
    const parent = await deps.store.getOutput(a.jobId, version.parentN)
    const sha = parent?.sha256['source.tar.gz']
    if (!parent || !sha) throw new SourceUnavailable(`Version ${version.parentN} has no saved composition.`)
    revision = { parentN: version.parentN, sourceKey: parent.sourceKey, sourceSha256: sha }
  }
  // Inputs to restore go in a server-written manifest the run verifies by hash (plan v2 §14 rule 21).
  let runManifestSha256: string | null = null
  if (revision) {
    const manifest = serializeRunManifest({
      v: RUN_MANIFEST_VERSION,
      jobId: a.jobId,
      attemptId: a.id,
      versionN: a.versionN,
      kind: 'revision',
      source: { key: revision.sourceKey, sha256: revision.sourceSha256, parentN: revision.parentN },
      bundle: null,
    })
    await deps.blobs.set('sources', runManifestKey(a.jobId, a.id), manifest, {
      contentType: 'application/json',
    })
    runManifestSha256 = sha256Hex(manifest)
  }
  const prompt = buildPrompt({
    jobId: a.jobId,
    attemptId: a.id,
    versionN: a.versionN,
    requesterName: author?.name ?? author?.email ?? 'a teammate',
    userPrompt: version.prompt,
    aspect: job.aspect,
    targetDurationSec: version.targetDurationSec,
    callbackUrl: `${deps.config.siteUrl}/api/internal/runs/${a.id}/done`,
    callbackToken,
    upload: { mode: 'blobs' },
    revision: revision && { parentN: revision.parentN },
    runManifestSha256,
    plan: version.plan ? { brief: version.plan.brief, qa: version.plan.qa } : null,
  })
  return {
    req: {
      requestId: a.id,
      prompt,
      deployId: a.deployId,
      agent: a.agent,
      model: a.model,
      effort: a.effort,
      deadlineMs: (deps.config.authoringDeadlineMin + 3) * MIN,
    },
    parentSha: revision?.sourceSha256 ?? null,
  }
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

  // Persist the start intent before any network I/O.
  const token = deps.ids.secret(32)
  const deployId = a.deployId ?? (await deps.platform.productionDeployId())
  let req: StartRequest
  let parentSha: string | null
  try {
    ;({ req, parentSha } = await startRequest(deps, { ...a, deployId }, token))
  } catch (e) {
    if (!(e instanceof SourceUnavailable)) throw e
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
    if (snap.state === 'await_input') {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'cancelling',
          {
            ...patch,
            cancelRequestedAt: now.toISOString(),
            cancelReason: 'needs_input',
            nextActionAt: now.toISOString(),
          },
          now.toISOString(),
        ),
      )
      deps.log.warn('attempt.needs_input', { attemptId: a.id })
      return
    }
    if (a.authoringDeadlineAt && now.toISOString() > a.authoringDeadlineAt) {
      await deps.store.tx((repo) =>
        setStage(
          repo,
          a,
          'cancelling',
          {
            ...patch,
            cancelRequestedAt: now.toISOString(),
            cancelReason: 'deadline',
            nextActionAt: now.toISOString(),
          },
          now.toISOString(),
        ),
      )
      deps.log.warn('attempt.deadline', { attemptId: a.id })
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
