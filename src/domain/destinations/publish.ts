// Starting and retrying a destination publication (publish destinations §2.4, §6.1).
import type { Deps } from '../../deps.js'
import { ApiError } from '../../lib/errors.js'
import { validateOptions } from '../../lib/options-schema.js'
import { assertCan, type Principal } from '../policy.js'
import type { DestinationPublicationRow, Target } from '../types.js'
import { loadJob, publishVersion, withIdempotency } from '../videos.js'
import {
  destinationNames,
  destinationPublicationDto,
  sharePageEntry,
  type DestinationPublicationDto,
} from './dto.js'
import { assertCanLeave, buildPublishManifest } from './manifest.js'
import { kindFor, loadDestination, SHARE_PAGE_ID } from './registry.js'
import { validTarget } from './targets.js'
import './kinds.js'

export const PUBLISH_DEADLINE_MS = 24 * 3600_000
export const INSTRUCTIONS_MAX = 4000

export interface PublishInput {
  destination: string
  options?: Record<string, unknown> | undefined
  target?: unknown
  instructions?: string | null | undefined
  includeTranscript?: boolean | undefined
}

const sameRequest = (
  p: DestinationPublicationRow,
  options: Record<string, unknown>,
  target: Target | null,
  instr: string | null,
) =>
  JSON.stringify(p.options) === JSON.stringify(options) &&
  JSON.stringify(p.target) === JSON.stringify(target) &&
  (p.instructions ?? null) === instr

export async function publishToDestination(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
  input: PublishInput,
  idemKey?: string,
): Promise<DestinationPublicationDto> {
  if (input.destination === SHARE_PAGE_ID) {
    const pub = await publishVersion(deps, principal, jobId, n, { showTranscript: input.includeTranscript })
    const row = (await deps.store.listPublications(jobId)).find((p) => p.slug === pub.slug)
    if (!row) throw new ApiError('internal', 'The publication disappeared.')
    return sharePageEntry(row, pub.urls?.page ?? `${deps.config.siteUrl}/v/${pub.slug}`)
  }
  const { body: created } = await deps.store.tx(async (repo) =>
    withIdempotency(repo, deps, principal, `destinations.publish:${jobId}:${n}`, idemKey, input, async () => {
      const job = await loadJob(repo, principal, jobId, true)
      assertCan(principal, 'video:publish', { ownerId: job.ownerId })
      const v = await repo.getVersion(jobId, n)
      const o = await repo.getOutput(jobId, n)
      if (!v || v.status !== 'ready' || !o)
        throw new ApiError('not_ready', 'Only ready versions can be published.')
      assertCanLeave(job)
      const destination = await loadDestination(deps, repo, input.destination)
      if (!destination) throw new ApiError('not_found', 'Destination not found.')
      if (destination.row && !destination.row.enabled)
        throw new ApiError('conflict', 'This destination is turned off.')
      const kind = kindFor(destination.kind)
      const ready = await kind.ready({ deps, repo, destination, principal })
      if (!ready.ok) throw new ApiError('conflict', ready.reason)

      const opts = validateOptions(kind.optionsSchema(destination), input.options ?? {})
      if (!opts.ok) throw new ApiError('invalid_request', opts.errors.join(' '))
      const caps = destination.row?.capabilities ?? {}
      let target: Target | null = null
      if (input.target != null) {
        if (!caps.targets) throw new ApiError('invalid_request', 'This destination has no existing targets.')
        target = validTarget(input.target)
        if (!target) throw new ApiError('invalid_request', 'That target is not valid.')
      }
      const instructions =
        typeof input.instructions === 'string' && input.instructions.trim() ? input.instructions.trim() : null
      if (instructions !== null) {
        if (!caps.instructions)
          throw new ApiError('invalid_request', 'This destination takes no instructions.')
        if (instructions.length > INSTRUCTIONS_MAX)
          throw new ApiError('invalid_request', `Instructions can be at most ${INSTRUCTIONS_MAX} characters.`)
      }

      const id = `dpub_${deps.ids.uuid().replace(/-/g, '').slice(0, 20)}`
      let connectionId: string | null = null
      let targetKey = target?.id ?? id
      if (destination.kind === 'youtube') {
        const conn = await repo.getUserConnection(principal.userId, 'youtube')
        if (!conn || conn.status !== 'ok') throw new ApiError('conflict', 'Connect YouTube first.')
        connectionId = conn.id
        targetKey = conn.accountId
      }
      const key = {
        jobId,
        versionN: n,
        kind: destination.kind,
        destinationId: destination.row?.id ?? null,
        targetKey,
      }
      const existing = await repo.findActiveDestinationPublication(key)
      if (existing) {
        if (!sameRequest(existing, opts.value, target, instructions))
          throw new ApiError('conflict', 'This version is already published there with other settings.')
        return { status: 200, body: { id: existing.id, dispatch: false } }
      }
      const live = (await repo.listPublications(jobId)).find((p) => p.versionN === n && !p.unpublishedAt)
      const manifest = await buildPublishManifest(repo, deps, job, v, o, {
        includeTranscript: input.includeTranscript ?? false,
        sharePage: live ? `${deps.config.siteUrl}/v/${live.slug}` : null,
      })
      const now = deps.clock.now().toISOString()
      await repo.insertDestinationPublication({
        id,
        ...key,
        destinationRevision: destination.row?.revision ?? null,
        connectionId,
        target,
        options: opts.value,
        instructions,
        desired: 'published',
        status: 'queued',
        generation: 1,
        operation: 'publish',
        manifest,
        stateEnc: null,
        externalId: null,
        url: null,
        message: null,
        warnings: null,
        error: null,
        attempts: 0,
        nextRunAt: now,
        deadlineAt: new Date(Date.parse(now) + PUBLISH_DEADLINE_MS).toISOString(),
        leaseUntil: null,
        leaseFence: 0,
        secretOnceEnc: null,
        secretOnceLabel: null,
        secretOnceIssuedAt: null,
        secretOnceExpiresAt: null,
        secretOnceConsumedAt: null,
        publishedBy: principal.userId,
        createdAt: now,
        updatedAt: now,
        liveAt: null,
        removedAt: null,
      })
      deps.log.info('destination.publish', {
        id,
        jobId,
        versionN: n,
        kind: destination.kind,
        destination: destination.id,
      })
      return { status: 201, body: { id, dispatch: true } }
    }),
  )
  if (created.dispatch) await dispatch(deps, created.id)
  return publicationDtoById(deps, created.id)
}

/** Try again on a failed publication: a new operation on the same publication, so the far side can reconcile. */
export async function retryDestinationPublication(deps: Deps, principal: Principal, id: string) {
  await deps.store.tx(async (repo) => {
    const p = await repo.getDestinationPublication(id, { lock: true })
    if (!p) throw new ApiError('not_found', 'Not found.')
    const job = await loadJob(repo, principal, p.jobId, true)
    assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    if (p.status !== 'failed') throw new ApiError('conflict', 'Only a failed publication can be tried again.')
    const now = deps.clock.now().toISOString()
    if (p.operation === 'publish') assertCanLeave(job)
    await repo.updateDestinationPublication(id, {
      generation: p.generation + 1,
      status: p.operation === 'remove' ? 'removing' : 'queued',
      attempts: 0,
      error: null,
      message: null,
      nextRunAt: now,
      deadlineAt: new Date(Date.parse(now) + PUBLISH_DEADLINE_MS).toISOString(),
      leaseUntil: null,
      updatedAt: now,
    })
  })
  await dispatch(deps, id)
  return publicationDtoById(deps, id)
}

export async function dispatch(deps: Deps, id: string) {
  try {
    await deps.platform.dispatchPublish(id)
  } catch (e) {
    // The sweep dispatches it again within a minute.
    deps.log.warn('destination.dispatch_failed', { id, error: e })
  }
}

export async function publicationDtoById(deps: Deps, id: string): Promise<DestinationPublicationDto> {
  const p = await deps.store.getDestinationPublication(id)
  if (!p) throw new ApiError('not_found', 'Not found.')
  const names = destinationNames(await deps.store.listDestinations())
  return destinationPublicationDto(p, names, deps.clock.now().toISOString())
}
