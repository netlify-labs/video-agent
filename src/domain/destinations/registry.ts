// Which destinations exist (publish destinations §2.1). The share page always; YouTube when the Google OAuth env is
// set and an admin turned it on; HTTP destinations from their rows.
import type { Deps } from '../../deps.js'
import type { Repo } from '../../store/types.js'
import type { DestinationKindName } from '../types.js'
import type { Destination, DestinationKind } from './types.js'

export const SHARE_PAGE_ID = 'share_page'
export const YOUTUBE_ID = 'youtube'

const kinds = new Map<DestinationKindName, DestinationKind>()

/** Each kind's module registers itself (kinds.ts imports them all, so nothing depends on import order). */
export function registerKind(k: DestinationKind) {
  kinds.set(k.kind, k)
}

export function kindFor(kind: DestinationKindName): DestinationKind {
  const k = kinds.get(kind)
  if (!k) throw new Error(`no destination kind ${kind}`)
  return k
}

export function youtubeConfigured(deps: Pick<Deps, 'config'>): boolean {
  return deps.config.google !== null
}

export async function youtubeAvailable(deps: Pick<Deps, 'config'>, repo: Repo): Promise<boolean> {
  return youtubeConfigured(deps) && ((await repo.getSettings())?.youtubeEnabled ?? false)
}

/** A destination by id, or null when it doesn't exist (or YouTube isn't available). Disabled HTTP ones are returned. */
export async function loadDestination(
  deps: Pick<Deps, 'config'>,
  repo: Repo,
  id: string,
): Promise<Destination | null> {
  if (id === SHARE_PAGE_ID) return { id, kind: 'share_page', name: 'Share page', row: null }
  if (id === YOUTUBE_ID)
    return (await youtubeAvailable(deps, repo)) ? { id, kind: 'youtube', name: 'YouTube', row: null } : null
  const row = await repo.getDestination(id)
  return row ? { id, kind: 'http', name: row.name, row } : null
}

/** The id a publication row's destination has. */
export const destinationIdOf = (p: { kind: DestinationKindName; destinationId: string | null }) =>
  p.kind === 'http' ? (p.destinationId ?? '') : p.kind === 'youtube' ? YOUTUBE_ID : SHARE_PAGE_ID
