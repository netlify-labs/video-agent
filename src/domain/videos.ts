// Creating, revising, retrying, cancelling, renaming, deleting and publishing videos.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import type { Repo } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
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
  type VersionRow,
} from './types.js'

const IDEMPOTENCY_TTL_MS = 24 * 3600_000

export interface CreateVideoInput {
  prompt: string
  aspect?: Aspect | undefined
  durationSec?: number | undefined
  title?: string | undefined
  webhookUrl?: string | undefined
}

export interface ReviseInput {
  prompt: string
  fromVersion?: number | undefined
  durationSec?: number | undefined
  webhookUrl?: string | undefined
}

function checkWebhook(principal: Principal, url: string | undefined) {
  if (url === undefined) return
  if (principal.kind !== 'apiKey') {
    throw new ApiError('invalid_request', 'webhookUrl is only accepted on API-key requests. The web app has in-app notifications.')
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ApiError('invalid_request', 'webhookUrl must be a valid URL.')
  }
  if (u.protocol !== 'https:') throw new ApiError('invalid_request', 'webhookUrl must use https.')
}

export function newAttempt(deps: Pick<Deps, 'ids' | 'config'>, jobId: string, versionN: number, now: string): AttemptRow {
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
  }
  const status = statusForStage(stage)
  await repo.updateVersion(attempt.jobId, attempt.versionN, { status })
  const job = await repo.getJob(attempt.jobId)
  if (job && job.latestVersion === attempt.versionN) {
    await repo.updateJob(job.id, { status, updatedAt: now, version: job.version + 1 })
  }
  return true
}

async function withIdempotency<T>(
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
    if (prior.requestHash !== hash) throw new ApiError('conflict', 'This Idempotency-Key was used with a different request.')
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

export async function createVideo(deps: Deps, principal: Principal, input: CreateVideoInput, idemKey?: string) {
  assertCan(principal, 'video:create')
  checkWebhook(principal, input.webhookUrl)
  return deps.store.tx((repo) =>
    withIdempotency(repo, deps, principal, 'videos.create', idemKey, input, async () => {
      const now = deps.clock.now().toISOString()
      const jobId = deps.ids.videoId()
      const job: JobRow = {
        id: jobId,
        title: input.title?.trim() || deriveTitle(input.prompt),
        aspect: input.aspect ?? '16:9',
        ownerId: principal.userId,
        status: 'queued',
        latestVersion: 1,
        nextVersionN: 2,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      }
      await repo.insertJob(job)
      await repo.insertVersion({
        jobId,
        n: 1,
        prompt: input.prompt,
        authorId: principal.userId,
        apiKeyId: principal.apiKeyId,
        targetDurationSec: input.durationSec ?? null,
        parentN: null,
        webhookUrl: input.webhookUrl ?? null,
        status: 'queued',
        createdAt: now,
      })
      await repo.insertAttempt(newAttempt(deps, jobId, 1, now))
      return { status: 202, body: await videoDto(repo, deps, jobId) }
    }),
  )
}

export function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57).trimEnd()}…`
}

async function loadJob(repo: Repo, id: string, lock = false): Promise<JobRow> {
  const job = await repo.getJob(id, { lock })
  if (!job || job.deletedAt) throw new ApiError('not_found', 'Video not found.')
  return job
}

async function hasUnfinished(repo: Repo, jobId: string): Promise<boolean> {
  return (await repo.listVersions(jobId)).some((v) => UNFINISHED_STATUSES.includes(v.status))
}

export async function reviseVideo(deps: Deps, principal: Principal, jobId: string, input: ReviseInput, idemKey?: string) {
  assertCan(principal, 'version:create')
  checkWebhook(principal, input.webhookUrl)
  return deps.store.tx((repo) =>
    withIdempotency(repo, deps, principal, `versions.create:${jobId}`, idemKey, input, async () => {
      const job = await loadJob(repo, jobId, true)
      if (await hasUnfinished(repo, jobId)) throw new ApiError('conflict', 'Another version of this video is still in progress.')
      const versions = await repo.listVersions(jobId)
      const parent =
        input.fromVersion !== undefined
          ? versions.find((v) => v.n === input.fromVersion)
          : versions.find((v) => v.status === 'ready')
      if (!parent) throw new ApiError('conflict', 'There is no ready version to revise from.')
      if (parent.status !== 'ready') throw new ApiError('conflict', `Version ${parent.n} isn't ready, so it can't be revised.`)
      const now = deps.clock.now().toISOString()
      const n = job.nextVersionN
      await repo.insertVersion({
        jobId,
        n,
        prompt: input.prompt,
        authorId: principal.userId,
        apiKeyId: principal.apiKeyId,
        targetDurationSec: input.durationSec ?? (await repo.getVersion(jobId, parent.n))?.targetDurationSec ?? null,
        parentN: parent.n,
        webhookUrl: input.webhookUrl ?? null,
        status: 'queued',
        createdAt: now,
      })
      await repo.insertAttempt(newAttempt(deps, jobId, n, now))
      await repo.updateJob(jobId, { latestVersion: n, nextVersionN: n + 1, status: 'queued', updatedAt: now, version: job.version + 1 })
      return { status: 202, body: await videoDto(repo, deps, jobId) }
    }),
  )
}

export async function retryVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
    const version = await repo.getVersion(jobId, n)
    if (!version) throw new ApiError('not_found', 'Version not found.')
    assertCan(principal, 'version:retry', { ownerId: job.ownerId, authorId: version.authorId })
    if (!['failed', 'cancelled', 'timed_out'].includes(version.status)) {
      throw new ApiError('conflict', 'Only failed, cancelled or timed-out versions can be tried again.')
    }
    if (job.latestVersion !== n) throw new ApiError('conflict', 'Only the latest version can be tried again.')
    if (await hasUnfinished(repo, jobId)) throw new ApiError('conflict', 'Another version of this video is still in progress.')
    const now = deps.clock.now().toISOString()
    await repo.insertAttempt(newAttempt(deps, jobId, n, now))
    await repo.updateVersion(jobId, n, { status: 'queued' })
    await repo.updateJob(jobId, { status: 'queued', updatedAt: now, version: job.version + 1 })
    return videoDto(repo, deps, jobId)
  })
}

export async function cancelVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
    const version = await repo.getVersion(jobId, n)
    if (!version) throw new ApiError('not_found', 'Version not found.')
    assertCan(principal, 'version:cancel', { ownerId: job.ownerId, authorId: version.authorId })
    const attempt = await repo.latestAttempt(jobId, n)
    if (!attempt || isTerminal(attempt.stage)) throw new ApiError('conflict', 'This version is not in progress.')
    await requestCancel(repo, deps, attempt, 'user')
    return videoDto(repo, deps, jobId)
  })
}

/** Queued: cancel now. Running: persist intent; the sweep stops the session. */
export async function requestCancel(repo: Repo, deps: Pick<Deps, 'clock'>, attempt: AttemptRow, reason: 'user' | 'needs_input' | 'deadline') {
  const now = deps.clock.now().toISOString()
  if (attempt.stage === 'queued') {
    await setStage(repo, attempt, 'cancelled', { endedAt: now, cancelRequestedAt: now, cancelReason: reason, nextActionAt: null }, now)
    return
  }
  if (attempt.stage === 'unresolved') throw new ApiError('conflict', 'This start is unresolved; an admin has to resolve it.')
  if (attempt.stage === 'finishing') {
    await repo.updateAttempt(attempt.id, { cancelRequestedAt: now, cancelReason: reason })
    return
  }
  if (attempt.stage === 'cancelling') return
  await setStage(repo, attempt, 'cancelling', { cancelRequestedAt: now, cancelReason: reason, nextActionAt: now, leaseUntil: null }, now)
}

export async function renameVideo(deps: Deps, principal: Principal, jobId: string, title: string) {
  return deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
    assertCan(principal, 'video:rename', { ownerId: job.ownerId })
    await repo.updateJob(jobId, { title: title.trim(), updatedAt: deps.clock.now().toISOString(), version: job.version + 1 })
    return videoDto(repo, deps, jobId)
  })
}

export async function deleteVideo(deps: Deps, principal: Principal, jobId: string) {
  const slugs = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
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
    for (const a of await repo.listAttempts(jobId)) {
      if (!isTerminal(a.stage) && a.stage !== 'unresolved') await requestCancel(repo, deps, a, 'user')
    }
    for (const store of ['videos', 'sources'] as const) {
      await repo.insertCleanup({ id: deps.ids.uuid(), kind: 'delete_prefix', store, prefix: `${jobId}/`, nextActionAt: now, doneAt: null })
    }
    return ended
  })
  for (const slug of slugs) await deps.blobs.delete('internal', pubKey(slug))
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
  keys: { video: string; poster: string; gif: string; captions: string }
}

export async function publishVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  const { pub, mirror } = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    const output = await repo.getOutput(jobId, n)
    const version = await repo.getVersion(jobId, n)
    if (!version || version.status !== 'ready' || !output) throw new ApiError('not_ready', 'Only ready versions can be published.')
    const active = (await repo.listPublications(jobId)).find((p) => p.versionN === n && !p.unpublishedAt)
    if (active) return { pub: active, mirror: mirrorFor(active, job, output) }
    const row: PublicationRow = {
      slug: deps.ids.slug(),
      jobId,
      versionN: n,
      publishedBy: principal.userId,
      publishedAt: deps.clock.now().toISOString(),
      unpublishedAt: null,
    }
    await repo.insertPublication(row)
    return { pub: row, mirror: mirrorFor(row, job, output) }
  })
  await deps.blobs.set('internal', pubKey(pub.slug), JSON.stringify(mirror))
  return publicationDto(deps, pub)
}

function mirrorFor(p: PublicationRow, job: JobRow, o: OutputRow): PublicationMirror {
  return {
    slug: p.slug,
    jobId: job.id,
    versionN: p.versionN,
    title: o.title || job.title,
    width: o.width,
    height: o.height,
    durationSec: o.durationSec,
    keys: { video: o.videoKey, poster: o.posterKey, gif: o.gifKey, captions: o.captionsKey },
  }
}

export async function unpublishVersion(deps: Deps, principal: Principal, jobId: string, n: number) {
  const slugs = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    const now = deps.clock.now().toISOString()
    const active = (await repo.listPublications(jobId)).filter((p) => p.versionN === n && !p.unpublishedAt)
    if (active.length === 0) throw new ApiError('not_found', 'This version is not published.')
    for (const p of active) await repo.updatePublication(p.slug, { unpublishedAt: now })
    return active.map((p) => p.slug)
  })
  for (const slug of slugs) await deps.blobs.delete('internal', pubKey(slug))
}

// ───────────── DTOs ─────────────

export function publicationDto(deps: Pick<Deps, 'config'>, p: PublicationRow) {
  const base = `${deps.config.siteUrl}/v/${p.slug}`
  return {
    slug: p.slug,
    versionN: p.versionN,
    publishedAt: p.publishedAt,
    unpublishedAt: p.unpublishedAt,
    urls: p.unpublishedAt
      ? null
      : { page: base, mp4: `${base}.mp4`, poster: `${base}.jpg`, gif: `${base}.gif`, captions: `${base}.vtt` },
    embed: p.unpublishedAt
      ? null
      : `<video controls playsinline poster="${base}.jpg" src="${base}.mp4"><track kind="captions" src="${base}.vtt" default></video>`,
  }
}

function versionDto(
  deps: Pick<Deps, 'config' | 'runner'>,
  jobId: string,
  v: VersionRow,
  a: AttemptRow | null,
  attemptsCount: number,
  o: OutputRow | null,
  pubs: PublicationRow[],
) {
  const fileBase = `${deps.config.siteUrl}/api/v1/videos/${jobId}/versions/${v.n}`
  return {
    n: v.n,
    status: v.status,
    prompt: v.prompt,
    authorId: v.authorId,
    parentN: v.parentN,
    targetDurationSec: v.targetDurationSec,
    createdAt: v.createdAt,
    attempts: attemptsCount,
    stage: a?.stage ?? null,
    latestStep: a?.latestStep ?? null,
    error: a?.errorCategory ? { category: a.errorCategory, message: a.errorMessage ?? '' } : null,
    agent: a ? { agent: a.agent, model: a.model, effort: a.effort, deployId: a.deployId, promptTemplateVersion: a.promptTemplateVersion } : null,
    usage: a?.usage ?? null,
    timings: a
      ? { queuedAt: a.queuedAt, startedAt: a.startedAt, finishingAt: a.finishingAt, endedAt: a.endedAt }
      : null,
    output: o
      ? { durationSec: o.durationSec, width: o.width, height: o.height, bytes: o.bytes, title: o.title, summary: o.agentSummary }
      : null,
    links: {
      video: `${fileBase}/video`,
      poster: `${fileBase}/poster`,
      gif: `${fileBase}/gif`,
      captions: `${fileBase}/captions`,
      netlifyRun: a?.runnerId ? deps.runner.runUrl(a.runnerId, a.sessionId) : null,
    },
    publications: pubs.filter((p) => p.versionN === v.n).map((p) => publicationDto(deps, p)),
  }
}

export async function videoDto(repo: Repo, deps: Pick<Deps, 'config' | 'runner'>, jobId: string) {
  const job = await repo.getJob(jobId)
  if (!job || job.deletedAt) throw new ApiError('not_found', 'Video not found.')
  const [versions, attempts, pubs] = await Promise.all([repo.listVersions(jobId), repo.listAttempts(jobId), repo.listPublications(jobId)])
  const out = await Promise.all(
    versions.map(async (v) => {
      const mine = attempts.filter((a) => a.versionN === v.n)
      return versionDto(deps, jobId, v, mine[0] ?? null, mine.length, await repo.getOutput(jobId, v.n), pubs)
    }),
  )
  const owner = await repo.getUser(job.ownerId)
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
    etag: `"${job.id}-${job.version}"`,
    versions: out,
    published: pubs.some((p) => !p.unpublishedAt),
    links: { self: `${deps.config.siteUrl}/api/v1/videos/${job.id}` },
  }
}

export type VideoDto = Awaited<ReturnType<typeof videoDto>>

export async function listVideos(
  deps: Deps,
  principal: Principal,
  q: { owner?: 'me' | 'all' | undefined; status?: JobRow['status'] | undefined; published?: boolean | undefined; q?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
) {
  assertCan(principal, 'video:read')
  const limit = Math.min(Math.max(q.limit ?? 24, 1), 50)
  let cursor: { createdAt: string; id: string } | undefined
  if (q.cursor && q.cursor !== 'undefined') {
    try {
      cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { createdAt: string; id: string }
    } catch {
      throw new ApiError('invalid_request', 'Invalid cursor.')
    }
  }
  const rows = await deps.store.listJobs({
    ...(q.owner === 'me' ? { ownerId: principal.userId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.published !== undefined ? { published: q.published } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(cursor ? { cursor } : {}),
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  const items = await Promise.all(page.map((j) => videoDto(deps.store, deps, j.id)))
  const last = page.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : null,
  }
}
