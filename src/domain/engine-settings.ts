// The Remotion switch and license choice (render-engines plan §7): admin only, offered only when ENGINES lists
// Remotion, and recorded with who chose and when. No key or secret is stored: the server only checks that
// VIDEO_AGENT_REMOTION_KEY is set for a Company License. Turning it off keeps the record, and existing Remotion videos
// keep playing, revising and editing; only new ones stop.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { remotionConfigured } from './engines.js'
import type { Principal } from './policy.js'
import type { RemotionLicenseAck, SettingsRow } from './types.js'

export interface RemotionSettings {
  enabled: boolean
  /** The recorded choice; admin-only, never in GET /api/v1/engines or a video. */
  license: RemotionLicenseAck | null
  /** Whether VIDEO_AGENT_REMOTION_KEY is set (its value is never read here). */
  keySet: boolean
}

export interface RemotionSettingsPatch {
  remotionEnabled?: boolean | undefined
  remotionLicense?: { tier: 'free' | 'company'; note?: string | null | undefined } | undefined
}

/** The admin's view; undefined when this deployment doesn't list Remotion, so nothing about it shows. */
export function remotionSettings(
  deps: Pick<Deps, 'config'>,
  row: SettingsRow | null,
): RemotionSettings | undefined {
  if (!remotionConfigured(deps)) return undefined
  return {
    enabled: row?.remotionEnabled ?? false,
    license: row?.remotionLicenseAck ?? null,
    keySet: deps.config.remotionKeySet,
  }
}

/** The settings columns a Remotion patch writes, after its checks; {} when it has no Remotion fields. */
export async function remotionChanges(
  deps: Pick<Deps, 'config' | 'store' | 'clock' | 'log'>,
  p: Principal,
  patch: RemotionSettingsPatch,
): Promise<Partial<SettingsRow>> {
  if (patch.remotionEnabled === undefined && patch.remotionLicense === undefined) return {}
  if (!remotionConfigured(deps))
    throw new ApiError(
      'engine_disabled',
      "Remotion isn't offered here: add remotion to ENGINES on the project first.",
    )
  const row = await deps.store.getSettings()
  const changes: Partial<SettingsRow> = {}
  if (patch.remotionLicense) {
    if (patch.remotionLicense.tier === 'company' && !deps.config.remotionKeySet)
      throw new ApiError(
        'remotion_key_missing',
        "Set VIDEO_AGENT_REMOTION_KEY on the project first; the server only checks that it's set.",
      )
    changes.remotionLicenseAck = {
      by: p.userId,
      email: p.email,
      at: deps.clock.now().toISOString(),
      tier: patch.remotionLicense.tier,
      note: patch.remotionLicense.note?.trim().slice(0, 500) || null,
    }
  }
  if (patch.remotionEnabled !== undefined) {
    const license = changes.remotionLicenseAck ?? row?.remotionLicenseAck ?? null
    if (patch.remotionEnabled && !license)
      throw new ApiError(
        'remotion_license_required',
        'Choose the license your organisation has before turning Remotion on.',
      )
    if (patch.remotionEnabled && license?.tier === 'company' && !deps.config.remotionKeySet)
      throw new ApiError(
        'remotion_key_missing',
        "Set VIDEO_AGENT_REMOTION_KEY on the project first; the server only checks that it's set.",
      )
    changes.remotionEnabled = patch.remotionEnabled
  }
  deps.log.info('settings.remotion_saved', {
    by: p.userId,
    tier: changes.remotionLicenseAck?.tier ?? row?.remotionLicenseAck?.tier ?? null,
    enabled: changes.remotionEnabled ?? row?.remotionEnabled ?? false,
  })
  return changes
}
