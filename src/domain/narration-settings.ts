// Recorded voice-over settings (voice-over plan §6.1, §12 decisions 4 and 15): on by default, and an admin can turn
// it off, pick how takes are transcribed and size the per-person take quota without a redeploy. They're read from
// the settings row on every use, not the cached copy in settings.ts, so a change reaches every function instance.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { assertCan, type Principal } from './policy.js'
import { remixEnabled } from './remix-settings.js'
import { getSettings } from './settings.js'
import { RECORDING_QUOTA_DEFAULT } from './media-roles.js'
import { NARRATION_SETTING_DEFAULTS, type TranscriptionProvider } from './types.js'

export interface NarrationSettings {
  narrationEnabled: boolean
  transcriptionProvider: TranscriptionProvider
  takeQuotaBytes: number
}

/** The current values; a missing row or column reads as the default. */
export async function narrationSettings(deps: Pick<Deps, 'store'>): Promise<NarrationSettings> {
  const s = await deps.store.getSettings()
  return {
    narrationEnabled: s?.narrationEnabled ?? NARRATION_SETTING_DEFAULTS.narrationEnabled,
    transcriptionProvider: s?.transcriptionProvider ?? NARRATION_SETTING_DEFAULTS.transcriptionProvider,
    takeQuotaBytes: s?.takeQuotaBytes ?? NARRATION_SETTING_DEFAULTS.takeQuotaBytes,
  }
}

/**
 * Whether recorded voice-over is on. The narration op, takes, the lock and narration renders (later beads) call
 * `assertNarrationEnabled` first; when it's off, versions that already have narration keep playing.
 */
export async function narrationEnabled(deps: Pick<Deps, 'store'>): Promise<boolean> {
  return (await narrationSettings(deps)).narrationEnabled
}

/** Refuses a narration operation with 409 narration_disabled when an admin has turned the feature off. */
export async function assertNarrationEnabled(deps: Pick<Deps, 'store'>): Promise<void> {
  if (!(await narrationEnabled(deps)))
    throw new ApiError('narration_disabled', 'Recorded voice-over is turned off for this video agent.')
}

/** Everything on the admin Settings page: the voice-over settings plus the remix switch (remix spec §4). */
export interface AdminSettings extends NarrationSettings {
  remixEnabled: boolean
  /** YouTube as a publish destination (publish destinations §4). */
  youtubeEnabled: boolean
  /** The Google OAuth env is set (read-only). */
  youtubeConfigured: boolean
  /** Stored bytes each person's screen recordings may use (screen-recording plan §4.2). */
  recordingQuotaBytes: number
}

async function adminSettings(deps: Pick<Deps, 'store' | 'config'>): Promise<AdminSettings> {
  return {
    ...(await narrationSettings(deps)),
    remixEnabled: await remixEnabled(deps),
    youtubeEnabled: (await deps.store.getSettings())?.youtubeEnabled ?? false,
    youtubeConfigured: deps.config.google !== null,
    recordingQuotaBytes: (await deps.store.getSettings())?.recordingQuotaBytes ?? RECORDING_QUOTA_DEFAULT,
  }
}

export async function getAdminSettings(deps: Deps, p: Principal): Promise<AdminSettings> {
  assertCan(p, 'settings:manage')
  return adminSettings(deps)
}

/** Changes the fields given; the rest stay as they are. */
export async function updateAdminSettings(
  deps: Deps,
  p: Principal,
  patch: { [K in keyof AdminSettings]?: AdminSettings[K] | undefined },
): Promise<AdminSettings> {
  assertCan(p, 'settings:manage')
  // The row is created on first use; make sure it exists so the update has something to change.
  await getSettings(deps)
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'youtubeConfigured'),
  )
  if (Object.keys(changes).length) await deps.store.updateSettings(changes)
  deps.log.info('settings.updated', { userId: p.userId, changes })
  return adminSettings(deps)
}
