// Connected accounts (publish destinations §4): a person's YouTube channel. Disconnecting revokes the grant at
// Google; existing publications stay where they are (decision D3) and their removal uses the pinned connection.
import type { Deps } from '../../deps.js'
import { ApiError } from '../../lib/errors.js'
import type { Principal } from '../policy.js'
import { revoke } from './google.js'
import { youtubeAvailable, youtubeConfigured } from './registry.js'

export async function listConnections(deps: Deps, p: Principal) {
  const rows = await deps.store.listUserConnections(p.userId)
  return {
    youtube: {
      configured: youtubeConfigured(deps),
      available: await youtubeAvailable(deps, deps.store),
      connectUrl: '/auth/google/start',
    },
    items: rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      account: c.accountLabel,
      accountId: c.accountId,
      status: c.status,
      connectedAt: c.createdAt,
    })),
  }
}

export async function deleteConnection(deps: Deps, p: Principal, id: string) {
  const c = await deps.store.getDestinationConnection(id)
  if (!c || c.userId !== p.userId) throw new ApiError('not_found', 'Not found.')
  await revoke(deps, c)
  await deps.store.deleteDestinationConnection(id)
  deps.log.info('youtube.disconnected', { userId: p.userId })
}
