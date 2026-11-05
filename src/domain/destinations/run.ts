// The destination worker (publish destinations §2.4): one publication, step by step, under a fenced lease. A worker
// claims the row (lease_until + lease_fence), runs one bounded step, and commits only if the fence, the generation and
// what the person wants (desired) are unchanged. If the row moved on (a newer worker, an unpublish, a delete), the
// commit is refused and the worker stops without writing. Runs in publish-background (15 minutes).
import type { Deps } from '../../deps.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import type { Repo } from '../../store/types.js'
import { signedFilePath, type FileKind } from '../files.js'
import { getSettings } from '../settings.js'
import type { DestinationPublicationRow } from '../types.js'
import { backoffMs, emitEvent } from '../webhooks.js'
import { destinationNames, destinationPublicationDto } from './dto.js'
import { fileKey, type Manifest, type ManifestFileKind, type PublishManifest } from './manifest.js'
import { destinationIdOf, kindFor, loadDestination } from './registry.js'
import { safeError, type StepCtx, type StepResult } from './types.js'
import './kinds.js'

export const LEASE_MS = 2 * 60_000
/** Stop looping this long before the background function's 15 minutes. */
const BUDGET_MS = 14 * 60_000
const MAX_RETRY_AFTER_MS = 3600_000

const FILE_KIND: Record<ManifestFileKind, FileKind> = {
  mp4: 'video',
  poster: 'poster',
  captions: 'captions',
  transcript: 'transcript',
}

const iso = (d: Date) => d.toISOString()
const plus = (t: string, ms: number) => new Date(Date.parse(t) + ms).toISOString()

export function readState(
  key: string,
  p: Pick<DestinationPublicationRow, 'stateEnc'>,
): Record<string, unknown> {
  if (!p.stateEnc) return {}
  try {
    return JSON.parse(decrypt(key, p.stateEnc)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Signed links for a publish manifest's files, after checking the video still exists and may still go out. */
export async function manifestLinks(
  deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs' | 'config'>,
  p: Pick<DestinationPublicationRow, 'jobId' | 'versionN'>,
  m: PublishManifest,
): Promise<Record<string, string>> {
  const job = await deps.store.getJob(p.jobId)
  if (!job || job.deletedAt) throw new ApiError('gone', 'The video was deleted.')
  if (job.private) throw new ApiError('forbidden', 'The video is private now.')
  const out: Record<string, string> = {}
  for (const f of m.files) {
    const path = await signedFilePath(deps, job, p.versionN, FILE_KIND[f.kind], { ttlSec: 600, name: f.name })
    out[f.kind] = `${deps.config.siteUrl}${path}`
  }
  return out
}

/** What a step result becomes on the row. */
export function patchFor(
  p: DestinationPublicationRow,
  r: StepResult,
  now: string,
  key: string,
): Partial<DestinationPublicationRow> {
  const base = { updatedAt: now, leaseUntil: null as string | null }
  const working = p.operation === 'remove' ? 'removing' : 'running'
  const state = (s: object | undefined) => (s ? { stateEnc: encrypt(key, JSON.stringify(s)) } : {})
  switch (r.status) {
    case 'continue':
      return { ...base, ...state(r.state), status: working, leaseUntil: plus(now, LEASE_MS) }
    case 'waiting':
      return {
        ...base,
        ...state(r.state),
        status: p.operation === 'remove' ? 'removing' : 'waiting',
        message: r.message ?? p.message,
        ...(r.externalId ? { externalId: r.externalId } : {}),
        nextRunAt: r.checkAfterSec === null ? null : plus(now, r.checkAfterSec * 1000),
      }
    case 'retry': {
      const wait =
        r.retryAfterSec !== undefined
          ? Math.min(r.retryAfterSec * 1000, MAX_RETRY_AFTER_MS)
          : backoffMs(p.attempts)
      return {
        ...base,
        ...state(r.state),
        status: working,
        attempts: p.attempts + 1,
        error: r.error,
        nextRunAt: plus(now, wait),
      }
    }
    case 'live':
      if (p.operation === 'remove')
        return {
          ...base,
          status: 'failed',
          error: safeError('bad_result', 'A removal answered "live".'),
          nextRunAt: null,
        }
      return {
        ...base,
        status: 'live',
        url: r.url,
        externalId: r.externalId ?? p.externalId,
        warnings: r.warnings ?? null,
        message: r.message ?? null,
        error: null,
        liveAt: now,
        nextRunAt: null,
      }
    case 'removed':
      return { ...base, status: 'removed', removedAt: now, nextRunAt: null, error: null }
    case 'failed':
      return { ...base, status: 'failed', error: r.error, nextRunAt: null }
  }
}

/** Applies a patch with the fence check; terminal outcomes emit their webhook event in the same transaction. */
export async function commitStep(
  deps: Deps,
  p: DestinationPublicationRow,
  fence: number,
  patch: Partial<DestinationPublicationRow>,
): Promise<boolean> {
  return deps.store.tx(async (repo) => {
    const ok = await repo.commitDestinationPublication(
      p.id,
      { fence, generation: p.generation, desired: p.desired },
      patch,
    )
    if (ok && patch.status && patch.status !== p.status) await emitTerminal(repo, deps, { ...p, ...patch })
    return ok
  })
}

export async function emitTerminal(repo: Repo, deps: Deps, p: DestinationPublicationRow) {
  const type =
    p.status === 'live'
      ? 'destination.live'
      : p.status === 'failed'
        ? 'destination.failed'
        : p.status === 'removed'
          ? 'destination.removed'
          : null
  if (!type) return
  const names = destinationNames(await repo.listDestinations())
  await emitEvent(repo, deps, {
    type,
    jobId: p.jobId,
    versionN: p.versionN,
    data: { destinationPublication: destinationPublicationDto(p, names, iso(deps.clock.now())) },
  })
  deps.log.info(type, {
    id: p.id,
    kind: p.kind,
    jobId: p.jobId,
    versionN: p.versionN,
    generation: p.generation,
  })
}

export type RunOutcome = 'busy' | 'missing' | 'lost_fence' | 'done' | 'paused'

/** Drives one publication until it waits, retries, finishes, or the time budget runs out. */
export async function runPublication(deps: Deps, id: string, budgetMs = BUDGET_MS): Promise<RunOutcome> {
  const started = Date.now()
  const { dataEncryptionKey } = await getSettings(deps)
  let now = iso(deps.clock.now())
  const claimed = await deps.store.claimDestinationPublication(id, now, plus(now, LEASE_MS))
  if (!claimed) return (await deps.store.getDestinationPublication(id)) ? 'busy' : 'missing'
  let p = claimed
  const fence = p.leaseFence
  for (;;) {
    if (!['queued', 'running', 'waiting', 'removing'].includes(p.status)) {
      await deps.store.commitDestinationPublication(
        p.id,
        { fence, generation: p.generation, desired: p.desired },
        { leaseUntil: null },
      )
      return 'done'
    }
    now = iso(deps.clock.now())
    const t0 = Date.now()
    const result = await step(deps, p, fence, dataEncryptionKey)
    const patch = patchFor(p, result, now, dataEncryptionKey)
    const ok = await commitStep(deps, p, fence, patch)
    deps.log.info('destination.step', {
      id: p.id,
      kind: p.kind,
      operation: p.operation,
      generation: p.generation,
      attempt: p.attempts,
      result: result.status,
      ...(result.status === 'retry' || result.status === 'failed' ? { code: result.error.code } : {}),
      committed: ok,
      ms: Date.now() - t0,
    })
    if (!ok) return 'lost_fence'
    if (result.status !== 'continue') return 'done'
    if (Date.now() - started > budgetMs) {
      // Hand over to the next invocation: save, release, and let the sweep dispatch it at once.
      await deps.store.commitDestinationPublication(
        p.id,
        { fence, generation: p.generation, desired: p.desired },
        { leaseUntil: null, nextRunAt: iso(deps.clock.now()) },
      )
      return 'paused'
    }
    const next = await deps.store.getDestinationPublication(p.id)
    if (!next || next.leaseFence !== fence) return 'lost_fence'
    p = next
  }
}

async function step(
  deps: Deps,
  p: DestinationPublicationRow,
  fence: number,
  key: string,
): Promise<StepResult> {
  const destination = await loadDestination(deps, deps.store, destinationIdOf(p))
  if (!destination) {
    // A removal whose destination is gone has nothing left to remove; a publish can't go anywhere.
    return p.operation === 'remove'
      ? { status: 'removed' }
      : { status: 'failed', error: safeError('destination_gone', 'This destination no longer exists.') }
  }
  const manifest = p.manifest as Manifest
  const connection = p.connectionId ? await deps.store.getDestinationConnection(p.connectionId) : null
  const ctx: StepCtx = {
    deps,
    destination,
    publication: p,
    operation: {
      action: p.operation,
      generation: p.generation,
      fence,
      id: `${p.id}:${p.operation}:${p.generation}`,
    },
    state: readState(key, p),
    manifest,
    connection,
    files: async () => {
      if (manifest.action !== 'publish') return {}
      return manifestLinks(deps, p, manifest)
    },
    stream: async (kind, range) => {
      if (manifest.action !== 'publish') return null
      const f = manifest.files.find((x) => x.kind === kind)
      if (!f) return null
      const job = await deps.store.getJob(p.jobId)
      const o = await deps.store.getOutput(p.jobId, p.versionN)
      if (!job || job.deletedAt || !o) return null
      return deps.blobs.stream('videos', fileKey(job, p.versionN, o, f.name), range)
    },
  }
  try {
    return await kindFor(p.kind).step(ctx)
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'gone' || e.code === 'forbidden'))
      return {
        status: 'failed',
        error: safeError(e.code === 'gone' ? 'video_deleted' : 'video_private', e.message),
      }
    deps.log.warn('destination.step_error', { id: p.id, kind: p.kind, error: e })
    return { status: 'retry', error: safeError('step_error', 'Something went wrong; trying again.') }
  }
}
