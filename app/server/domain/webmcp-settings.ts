// WebMCP's admin switch (va-qago): the web app offers its tools to browser agents through document.modelContext unless
// an admin turns it off. Read from the settings row on every use, like the remix switch, so a change reaches every
// instance; the 'webmcp' feature in GET /api/v1/config is what the web app checks.
import type { Deps } from '../deps.js'

/** Whether WebMCP is on; a missing row or column reads as on. */
export async function webmcpEnabled(deps: Pick<Deps, 'store'>): Promise<boolean> {
  // SettingsRow gains webmcpEnabled with the next types.ts change; the column is read as is until then.
  const row = (await deps.store.getSettings()) as { webmcpEnabled?: boolean } | null
  return row?.webmcpEnabled ?? true
}
