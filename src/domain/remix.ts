// Remix a video (docs/plans/2026-11-03-remix.md §3.1, §3.3-§3.5, §4, §5): a NEW video, owned by whoever remixes,
// whose v1 starts from another video's finished composition plus a change request. The source's composition is
// copied (and cleaned of recorded narration) under the new video's own prefix, so every run-side check stays per-job,
// a Try again never touches the source, and deleting the source can't break the remix.
//
// The copy's lifecycle (gotcha 7): a reservation cleanup row is committed BEFORE the copy, with a prefix narrower
// than the video's own ({id}/remix-source, so it never collides with deleteVideo's {id}/ row under the unique
// (store, prefix) index) and due in an hour. The transaction that creates the video adopts it (marks it done). A
// failed or lost transaction, or a crash, leaves it open, and the sweep deletes the orphan copy.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import type { Language } from '../lib/language.js'
import { clip } from '../lib/log.js'
import { cleanRemixSource, RemixSourceError } from '../lib/remix-source.js'
import type { Repo } from '../store/types.js'
import { writeAccessMirror } from './files.js'
import { snapshotMedia } from './media.js'
import { assertCan, type Principal } from './policy.js'
import { assertRemixEnabled } from './remix-settings.js'
import type { Aspect, JobRow, OutputRow, VersionRemix, VersionRow, VideoSound } from './types.js'
import {
  checkWebhook,
  consumePlan,
  deriveTitle,
  loadJob,
  newAttempt,
  videoDto,
  withIdempotency,
} from './videos.js'
import { voiceoverFrom, type VoiceoverInput } from './voiceover.js'

export interface RemixInput {
  prompt: string
  /** Omitted: the source's latest ready version. */
  fromVersion?: number | undefined
  aspect?: Aspect | undefined
  language?: Language | undefined
  durationSec?: number | undefined
  sound?: VideoSound | undefined
  voiceover?: VoiceoverInput | undefined
  /** The final media list (it replaces the source's set); omitted keeps the source's set. */
  mediaIds?: string[] | undefined
  planId?: string | undefined
  /** The remixer's own (API keys only); the source's is never copied. */
  webhookUrl?: string | undefined
}

/** How much of the source's history the snapshot keeps (§3.3). */
export const REMIX_HISTORY_MAX_ENTRIES = 8
export const REMIX_HISTORY_MAX_CHARS = 4000
export const REMIX_SUMMARY_MAX_CHARS = 1000
/** How long an unadopted copy waits before the sweep deletes it. */
export const REMIX_RESERVATION_MS = 60 * 60_000

export const remixSourceKey = (jobId: string) => `${jobId}/remix-source.tar.gz`
export const remixReservationId = (jobId: string) => `remix-source-${jobId}`

/** The source's prompts up to `n`, oldest first (a remixed source's own history first), newest kept within caps. */
export function remixHistory(versions: VersionRow[], n: number): string[] {
  const own = versions
    .filter((v) => v.n <= n)
    .sort((a, b) => a.n - b.n)
    .map((v) => v.prompt)
  const inherited = versions.find((v) => v.n === 1)?.remix?.history ?? []
  const all = [...inherited, ...own].map((p) => p.replace(/\s+/g, ' ').trim().slice(0, 1000))
  const kept = all.slice(-REMIX_HISTORY_MAX_ENTRIES)
  while (kept.length > 1 && kept.reduce((t, p) => t + p.length, 0) > REMIX_HISTORY_MAX_CHARS) kept.shift()
  return kept
}

/** The source version to remix: the asked one, else the latest ready one. It must be ready. */
async function sourceVersion(repo: Repo, job: JobRow, fromVersion: number | undefined) {
  const versions = await repo.listVersions(job.id)
  const version =
    fromVersion !== undefined
      ? versions.find((v) => v.n === fromVersion)
      : [...versions].sort((a, b) => b.n - a.n).find((v) => v.status === 'ready')
  if (!version) {
    if (fromVersion !== undefined) throw new ApiError('not_found', `Version ${fromVersion} not found.`)
    throw new ApiError('not_ready', 'This video has no ready version to remix yet.')
  }
  if (version.status !== 'ready')
    throw new ApiError('not_ready', `Version ${version.n} isn't ready, so it can't be remixed.`)
  const output = await repo.getOutput(job.id, version.n)
  if (!output?.sha256['source.tar.gz'])
    throw new ApiError('conflict', `Version ${version.n} has no saved composition to remix.`)
  return { versions, version, output }
}

/**
 * Copies the source's composition (cleaned of recorded narration) to the new video's prefix, under a committed
 * reservation row. Returns the copy's hash and whether narration was dropped.
 */
async function copySource(
  deps: Deps,
  newJobId: string,
  version: VersionRow,
  output: OutputRow,
): Promise<{ sha256: string; narrationDropped: boolean }> {
  const now = deps.clock.now().getTime()
  await deps.store.insertCleanup({
    id: remixReservationId(newJobId),
    kind: 'delete_prefix',
    store: 'sources',
    prefix: `${newJobId}/remix-source`,
    nextActionAt: new Date(now + REMIX_RESERVATION_MS).toISOString(),
    doneAt: null,
  })
  const expected = output.sha256['source.tar.gz']
  const bytes = await deps.blobs.get('sources', output.sourceKey)
  if (!bytes || sha256Hex(bytes) !== expected)
    throw new ApiError('conflict', `Version ${version.n}'s saved composition is missing or damaged.`)
  const narrated = !!version.narration || output.sha256['references.json'] !== undefined
  let cleaned
  try {
    cleaned = cleanRemixSource(bytes, { narrated })
  } catch (e) {
    if (e instanceof RemixSourceError) {
      deps.log.warn('remix.source_unusable', { jobId: output.jobId, n: version.n, problem: e.problem })
      throw new ApiError('invalid_request', 'This version is too large or damaged to remix.')
    }
    throw e
  }
  const key = remixSourceKey(newJobId)
  await deps.blobs.set('sources', key, cleaned.bytes, { contentType: 'application/gzip' })
  const back = await deps.blobs.get('sources', key)
  if (!back || sha256Hex(back) !== cleaned.sha256) throw new Error('remix source copy failed verification')
  return { sha256: cleaned.sha256, narrationDropped: cleaned.narrationDropped }
}

export async function remixVideo(
  deps: Deps,
  principal: Principal,
  sourceId: string,
  input: RemixInput,
  idemKey?: string,
) {
  assertCan(principal, 'video:create')
  await assertRemixEnabled(deps)
  checkWebhook(principal, input.webhookUrl)
  deps.log.debug('video.remix_requested', {
    userId: principal.userId,
    via: principal.kind,
    sourceId,
    fromVersion: input.fromVersion ?? null,
    change: clip(input.prompt),
    planId: input.planId ?? null,
    mediaIds: input.mediaIds ?? null,
  })
  const operation = `videos.remix:${sourceId}`
  // Visibility before anything else, a replay included: a key can't replay a remix of a video you can't see now.
  const source = await loadJob(deps.store, principal, sourceId)
  const prior = idemKey ? await deps.store.getIdempotency(principal.userId, operation, idemKey) : null
  const replay = !!prior && prior.expiresAt > deps.clock.now().toISOString()
  // Checked and copied outside the transaction: blob writes can't roll back, so the reservation must be committed.
  let copy: { sha256: string; narrationDropped: boolean } | null = null
  let newJobId = ''
  if (!replay) {
    const { version, output } = await sourceVersion(deps.store, source, input.fromVersion)
    newJobId = deps.ids.videoId()
    copy = await copySource(deps, newJobId, version, output)
  }
  const res = await deps.store.tx(async (repo) => {
    await loadJob(repo, principal, sourceId)
    return withIdempotency(repo, deps, principal, operation, idemKey, input, async () => {
      if (!copy) throw new ApiError('conflict', 'Try the remix again.')
      // Re-read inside the transaction: the source may have changed while the copy was made.
      const job = await loadJob(repo, principal, sourceId)
      const { versions, version, output } = await sourceVersion(repo, job, input.fromVersion)
      const now = deps.clock.now().toISOString()
      const planned = input.planId
        ? await consumePlan(repo, deps, principal, input.planId, {
            jobId: null,
            n: 1,
            newJobId,
            remixFrom: { jobId: job.id, n: version.n },
          })
        : null
      const owner = await repo.getUser(job.ownerId)
      const remix: VersionRemix = {
        sourceKey: remixSourceKey(newJobId),
        sourceSha256: copy.sha256,
        fromJobId: job.id,
        fromN: version.n,
        fromTitle: job.title,
        fromOwnerName: owner?.name ?? owner?.email.split('@')[0] ?? null,
        history: remixHistory(versions, version.n),
        fromSummary: output.agentSummary.slice(0, REMIX_SUMMARY_MAX_CHARS),
        narrationDropped: copy.narrationDropped,
        sourceSound: version.sound ?? 'silent',
      }
      const created: JobRow = {
        id: newJobId,
        title: planned?.title || deriveTitle(input.prompt),
        aspect: input.aspect ?? planned?.aspect ?? job.aspect,
        ownerId: principal.userId,
        status: 'queued',
        latestVersion: 1,
        nextVersionN: 2,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
        // A remix of a private video stays private (§5).
        private: job.private,
        accessEpoch: 0,
        language: input.language ?? job.language,
        remixOfJobId: job.id,
        remixOfN: version.n,
      }
      await repo.insertJob(created)
      if (created.private) await writeAccessMirror(deps, created)
      // The source's media as removable chips: kept items keep their snapshot (even if deleted from the library
      // since); new ones must be live library items. Omitted mediaIds keep the whole set.
      const inherited = await repo.listVersionMedia(job.id, version.n)
      const finalIds = input.mediaIds
      const kept = finalIds ? inherited.filter((m) => finalIds.includes(m.mediaId)) : inherited
      const picks = [...(planned?.mediaIds ?? []), ...(finalIds ?? [])]
      const media = await snapshotMedia(repo, newJobId, 1, picks, kept)
      const sourceSound = version.sound ?? 'silent'
      const newAudio = media.some(
        (m) => m.kind === 'audio' && !inherited.some((r) => r.mediaId === m.mediaId),
      )
      await repo.insertVersion({
        jobId: newJobId,
        n: 1,
        prompt: input.prompt,
        authorId: principal.userId,
        apiKeyId: principal.apiKeyId,
        targetDurationSec: input.durationSec ?? planned?.durationSec ?? version.targetDurationSec,
        parentN: null,
        // Always authored by the agent, even when the source was an edit rendered as is.
        mode: 'author',
        webhookUrl: input.webhookUrl ?? null,
        status: 'queued',
        createdAt: now,
        plan: planned?.frozen ?? null,
        sound:
          input.sound ?? planned?.sound ?? (sourceSound === 'silent' && newAudio ? 'music' : sourceSound),
        voiceover: input.voiceover
          ? voiceoverFrom(input.voiceover)
          : (planned?.voiceover ?? version.voiceover ?? null),
        remix,
      })
      await repo.insertVersionMedia(media)
      await repo.insertAttempt(newAttempt(deps, newJobId, 1, now))
      // Adopt the copy: the reservation row is done, so the sweep never deletes it.
      await repo.updateCleanup(remixReservationId(newJobId), { doneAt: now })
      deps.log.info('video.remixed', {
        sourceId: job.id,
        fromN: version.n,
        jobId: newJobId,
        userId: principal.userId,
        narrationDropped: copy.narrationDropped,
        media: media.length,
      })
      return { status: 202, body: await videoDto(repo, deps, newJobId, principal) }
    })
  })
  // A replay (or losing a race on the same key) leaves this call's copy unadopted: the sweep removes it.
  if (res.replayed && copy) deps.log.info('remix.copy_unadopted', { jobId: newJobId })
  return res
}
