// Recorded voice-over settings (voice-over plan §6.1, §12 decisions 4 and 15): on by default, and an admin can turn
// it off, pick how takes are transcribed and size the per-person take quota without a redeploy. They're read from
// the settings row on every use, not the cached copy in settings.ts, so a change reaches every function instance.
import { enabledEngines } from './engines.js'
import { lookSettings } from './look-settings.js'
import { checkLookSettings } from './looks.js'
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import {
  remotionChanges,
  remotionSettings,
  type RemotionSettings,
  type RemotionSettingsPatch,
} from './engine-settings.js'
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
  /** The look creates get when they omit one (looks plan §6); null: none. */
  defaultLook: string | null
  /** Looks an admin has turned off. */
  disabledLooks: string[]
  /** video-agent login's browser approval (cli-and-sdk plan §5.2). */
  cliLoginEnabled: boolean
  /** The Remotion switch and license record; present only when ENGINES lists Remotion (render-engines §7). */
  remotion?: RemotionSettings
}

async function adminSettings(deps: Pick<Deps, 'store' | 'config'>): Promise<AdminSettings> {
  const row = await deps.store.getSettings()
  const remotion = remotionSettings(deps, row)
  return {
    ...(await narrationSettings(deps)),
    remixEnabled: await remixEnabled(deps),
    youtubeEnabled: row?.youtubeEnabled ?? false,
    youtubeConfigured: deps.config.google !== null,
    recordingQuotaBytes: row?.recordingQuotaBytes ?? RECORDING_QUOTA_DEFAULT,
    ...(await lookSettings(deps)),
    cliLoginEnabled: row?.cliLoginEnabled ?? true,
    ...(remotion ? { remotion } : {}),
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
  patch: {
    [K in Exclude<keyof AdminSettings, 'remotion'>]?: AdminSettings[K] | undefined
  } & RemotionSettingsPatch,
): Promise<AdminSettings> {
  assertCan(p, 'settings:manage')
  // The row is created on first use; make sure it exists so the update has something to change.
  await getSettings(deps)
  const { remotionEnabled, remotionLicense, ...rest } = patch
  const changes: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(rest).filter(([k, v]) => v !== undefined && k !== 'youtubeConfigured'),
    ),
    ...(await remotionChanges(deps, p, { remotionEnabled, remotionLicense })),
  }
  // Looks are checked as they'd be after the patch (looks plan §6).
  if (patch.defaultLook !== undefined || patch.disabledLooks !== undefined)
    Object.assign(
      changes,
      checkLookSettings(
        deps,
        await lookSettings(deps),
        patch,
        (await enabledEngines(deps)).map((e) => e.id),
      ),
    )
  if (Object.keys(changes).length) await deps.store.updateSettings(changes)
  deps.log.info('settings.updated', { userId: p.userId, changes })
  return adminSettings(deps)
}
