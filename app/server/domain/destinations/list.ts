// GET /api/v1/destinations (publish destinations §6.1): every destination this person may see in Publish ▾, each
// with whether it's ready for them and, when not, why.
import type { Deps } from '../../deps.js'
import type { Principal } from '../policy.js'
import type { DestinationCapabilities } from '../types.js'
import { kindFor, loadDestination, SHARE_PAGE_ID, YOUTUBE_ID, youtubeAvailable } from './registry.js'
import type { Destination } from './types.js'
import './kinds.js'

export interface DestinationListItem {
  id: string
  kind: Destination['kind']
  name: string
  ready: boolean
  reason: string | null
  capabilities: {
    targets: boolean
    targetNoun: string | null
    instructions: boolean
    instructionsLabel: string | null
    instructionsHint: string | null
  }
  optionsSchema: unknown
  unpublishOptionsSchema: unknown
}

const caps = (c: DestinationCapabilities | undefined) => ({
  targets: c?.targets ?? false,
  targetNoun: c?.targetNoun ?? null,
  instructions: c?.instructions ?? false,
  instructionsLabel: c?.instructionsLabel ?? null,
  instructionsHint: c?.instructionsHint ?? null,
})

export async function listDestinations(deps: Deps, principal: Principal): Promise<DestinationListItem[]> {
  const ids = [SHARE_PAGE_ID]
  if (await youtubeAvailable(deps, deps.store)) ids.push(YOUTUBE_ID)
  for (const r of await deps.store.listDestinations()) if (r.enabled) ids.push(r.id)
  const out: DestinationListItem[] = []
  for (const id of ids) {
    const d = await loadDestination(deps, deps.store, id)
    if (!d) continue
    const kind = kindFor(d.kind)
    const ready = await kind.ready({ deps, repo: deps.store, destination: d, principal })
    out.push({
      id: d.id,
      kind: d.kind,
      name: d.name,
      ready: ready.ok,
      reason: ready.ok ? null : ready.reason,
      capabilities: caps(d.row?.capabilities),
      optionsSchema: kind.optionsSchema(d),
      unpublishOptionsSchema: kind.unpublishOptionsSchema(d),
    })
  }
  return out
}
