// Looks' admin settings (docs/plans/2026-11-04-looks.md §6): a default look for creates that omit one (none unless an
// admin sets it; the owner kept None after spike K2) and the looks an admin has turned off. Read from the settings row
// on every use, like the remix switch, so a change reaches every instance.
import type { Deps } from '../deps.js'

export interface LookSettings {
  defaultLook: string | null
  disabledLooks: string[]
}

/** The look settings; a missing row or column reads as no default and nothing disabled. */
export async function lookSettings(deps: Pick<Deps, 'store'>): Promise<LookSettings> {
  const s = await deps.store.getSettings()
  return { defaultLook: s?.defaultLook ?? null, disabledLooks: s?.disabledLooks ?? [] }
}
