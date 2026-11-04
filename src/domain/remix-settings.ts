// Remixing's admin switch (docs/plans/2026-11-03-remix.md §4): on by default; an admin turns it off without a
// redeploy. Read from the settings row on every use, like the narration switch, so a change reaches every instance.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'

/** Whether remixing is on; a missing row or column reads as on. */
export async function remixEnabled(deps: Pick<Deps, 'store'>): Promise<boolean> {
  return (await deps.store.getSettings())?.remixEnabled ?? true
}

/** Refuses with 409 remix_disabled when an admin has turned remixing off. Remixes already queued still run. */
export async function assertRemixEnabled(deps: Pick<Deps, 'store'>): Promise<void> {
  if (!(await remixEnabled(deps))) throw new ApiError('remix_disabled', 'Remixing is turned off by an admin.')
}
