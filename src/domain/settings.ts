// Generated secrets live in the one-row settings table. Env vars can't be used: changes only take
// effect on the next deploy, so the deploy that generated them could never read them.
import type { Deps } from '../deps.js'
import type { SettingsRow } from './types.js'

let cached: SettingsRow | null = null

export function resetSettingsCache() {
  cached = null
}

/** Edge functions can't use the database, so they read this Blobs mirror (strong consistency). */
export const EDGE_CONFIG_KEY = 'edge-config.json'

export async function getSettings(deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>): Promise<SettingsRow> {
  if (cached) return cached
  const existing = await deps.store.getSettings()
  const row =
    existing ??
    (await deps.store.insertSettingsIfAbsent({
      id: 1,
      fileSigningSecret: deps.ids.secret(32),
      dataEncryptionKey: deps.ids.secret(32),
      queuePausedReason: null,
      createdAt: deps.clock.now().toISOString(),
    }))
  if (!existing) {
    await deps.blobs.set('internal', EDGE_CONFIG_KEY, JSON.stringify({ fileSigningSecret: row.fileSigningSecret }))
  }
  cached = row
  return row
}

/** Re-writes the edge mirror (setup checks call this so a lost write heals itself). */
export async function syncEdgeConfig(deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>) {
  const s = await getSettings(deps)
  await deps.blobs.set('internal', EDGE_CONFIG_KEY, JSON.stringify({ fileSigningSecret: s.fileSigningSecret }))
}
