// A version's look snapshot (docs/plans/2026-11-04-looks.md §4.3): the look's archive copied into the video's own
// prefix in the sources store, so retries and revisions get exactly those rules even after the look changes. Copied
// before the transaction that creates the version (blob writes can't roll back), under a reservation row the sweep
// deletes if no version adopts it, as remix copies its source. Unlike a remix, a revision reuses the video's id, so the
// reservation's id is deterministic per video and hash and is re-opened rather than inserted twice.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { LookCatalogEntry } from '../lib/looks.js'
import { sha256Hex } from '../lib/run-manifest.js'
import type { Repo } from '../store/types.js'
import { getLook } from './looks.js'
import type { VersionLook } from './types.js'

/** How long an unadopted copy may wait before the sweep deletes it. */
const RESERVATION_MS = 60 * 60 * 1000

export const lookKey = (jobId: string, hash: string) => `${jobId}/looks/${hash}.tar.gz`
export const lookReservationId = (jobId: string, hash: string) => `look-${jobId}-${hash}`

/** Where a snapshot's bytes come from: the deploy's bundled archive (a pick), or a remix source's own snapshot. */
export type SnapshotSource = { from: 'bundle'; entry: LookCatalogEntry } | { from: 'blob'; look: VersionLook }

/** The deploy's archive of a catalog look, checked against the catalog: a mismatch means a corrupt bundle. */
async function bundledArchive(deps: Deps, entry: LookCatalogEntry): Promise<Uint8Array> {
  const bytes = await deps.looks.archive(entry.id)
  if (sha256Hex(bytes) !== entry.sha256) {
    deps.log.error('look.archive_corrupt', { id: entry.id })
    throw new ApiError('internal', `The ${entry.name} look's files are damaged in this deploy.`)
  }
  return bytes
}

/** Whether a committed version of this video already references the key: the only signal that a copy is safe. */
async function adopted(deps: Pick<Deps, 'store'>, jobId: string, key: string): Promise<boolean> {
  return (await deps.store.listVersions(jobId)).some((v) => v.look?.key === key)
}

/**
 * Copies the look into the video's prefix (unless a committed version already uses that copy) and returns the snapshot
 * to store on the new version. Call it before the transaction, then adoptLookSnapshot inside it.
 */
export async function snapshotLook(
  deps: Deps,
  jobId: string,
  source: SnapshotSource,
  restyle: boolean,
): Promise<VersionLook> {
  const started = Date.now()
  const meta =
    source.from === 'bundle'
      ? {
          id: source.entry.id,
          name: source.entry.name,
          hash: source.entry.hash,
          sha256: source.entry.sha256,
          bytes: source.entry.bytes,
          source: source.entry.source,
        }
      : {
          id: source.look.id,
          name: source.look.name,
          hash: source.look.hash,
          sha256: source.look.sha256,
          bytes: source.look.bytes,
          source: source.look.source,
        }
  const key = lookKey(jobId, meta.hash)
  const look: VersionLook = { ...meta, key, restyle }
  if (await adopted(deps, jobId, key)) {
    deps.log.info('look.snapshot', {
      jobId,
      id: look.id,
      hash: look.hash,
      copied: false,
      ms: Date.now() - started,
    })
    return look
  }
  // The bytes: the bundled archive for a pick; a remix's source snapshot, else the bundled archive when the catalog
  // still has that look at the same hash, else nothing to copy.
  let bytes: Uint8Array
  if (source.from === 'bundle') bytes = await bundledArchive(deps, source.entry)
  else {
    const blob = await deps.blobs.get('sources', source.look.key)
    const entry = getLook(deps, source.look.id)
    if (blob && sha256Hex(blob) === source.look.sha256) bytes = blob
    else if (entry && entry.hash === source.look.hash) bytes = await bundledArchive(deps, entry)
    else
      throw new ApiError(
        'conflict',
        "The source video's look snapshot is missing; pick a look for the remix.",
      )
  }
  // The reservation, committed before the copy: inserted once, re-opened by id after an attempt that never adopted it.
  const now = deps.clock.now().getTime()
  const reservation = {
    id: lookReservationId(jobId, look.hash),
    kind: 'delete_prefix' as const,
    store: 'sources' as const,
    prefix: key,
    nextActionAt: new Date(now + RESERVATION_MS).toISOString(),
    doneAt: null,
  }
  await deps.store.insertCleanup(reservation)
  await deps.store.updateCleanup(reservation.id, { doneAt: null, nextActionAt: reservation.nextActionAt })
  // Overwriting an unadopted copy is harmless: the same hash means the same bytes.
  await deps.blobs.set('sources', key, bytes, { contentType: 'application/gzip' })
  const back = await deps.blobs.get('sources', key)
  if (!back || sha256Hex(back) !== look.sha256) throw new Error('look snapshot copy failed verification')
  deps.log.info('look.snapshot', {
    jobId,
    id: look.id,
    hash: look.hash,
    copied: true,
    ms: Date.now() - started,
  })
  return look
}

/** Inside the transaction that inserts the version: the copy is now in use, so the sweep leaves it. */
export async function adoptLookSnapshot(
  repo: Repo,
  deps: Pick<Deps, 'log'>,
  jobId: string,
  look: VersionLook,
  now: string,
) {
  await repo.updateCleanup(lookReservationId(jobId, look.hash), { doneAt: now })
  deps.log.info('look.snapshot_adopted', { jobId, id: look.id, hash: look.hash })
}
