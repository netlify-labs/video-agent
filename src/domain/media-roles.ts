// What a media role means (screen-recording plan §4.2, "The role table"). Every role-specific upload rule is a field
// here, so a new role is one row instead of another `isTakeRole` branch. A field is added only when two roles differ
// on it; the whole-file hash at completion is a plain rule for every role.
import type { MediaRole } from './types.js'

/** Narration takes: recorded or uploaded voice-over audio (voice-over plan §5.1). */
export const TAKE_ROLES = ['narration-take', 'narration-upload'] as const satisfies readonly MediaRole[]

export const isTakeRole = (role: string | null | undefined): role is (typeof TAKE_ROLES)[number] =>
  role === 'narration-take' || role === 'narration-upload'

/** Take uploads each person may start in an hour (voice-over plan §8). */
export const TAKE_UPLOADS_PER_HOUR = 30

export interface RolePolicy {
  /** The assembled file must be audio. */
  audioOnly: boolean
  /** The session names the video it's recorded for (scopeJobId); without the role it's refused. */
  needsScope: boolean
  /** The setting that caps the person's stored bytes for this role. */
  quotaSetting: 'takeQuotaBytes' | 'recordingQuotaBytes'
  /** Uploads of this role each person may start in an hour. */
  perHour: number
  /** The setting that must be on to upload this role. */
  gatedBy: 'narration' | null
  /** Peaks and speech spans are computed at assembly. */
  samples: boolean
}

const TAKE: RolePolicy = {
  audioOnly: true,
  needsScope: true,
  quotaSetting: 'takeQuotaBytes',
  perHour: TAKE_UPLOADS_PER_HOUR,
  gatedBy: 'narration',
  samples: true,
}

export const ROLES: Record<MediaRole, RolePolicy> = {
  'narration-take': TAKE,
  'narration-upload': TAKE,
  'screen-recording': {
    audioOnly: false,
    needsScope: false,
    quotaSetting: 'recordingQuotaBytes',
    perHour: 10,
    gatedBy: null,
    samples: false,
  },
}

/**
 * A raw screen recording: private to its uploader until a version uses it (canReadRecording), and never a plain
 * library pick. It reaches a version through the recording field, which checks who may read it.
 */
export const isScreenRecording = (m: { role: string | null }) => m.role === 'screen-recording'

/** Takes and screen recordings reach a version through their own paths (narration, recording), never as picks. */
export const isLibraryPick = (m: { role: string | null }) => !isTakeRole(m.role) && !isScreenRecording(m)

/** The roles createUploadSession accepts. */
export const UPLOAD_ROLES: readonly MediaRole[] = [...TAKE_ROLES, 'screen-recording']

/** The roles that share a role's budgets: the same policy (takes and uploaded takes count together). */
export const budgetRoles = (role: MediaRole): MediaRole[] =>
  (Object.keys(ROLES) as MediaRole[]).filter((r) => ROLES[r] === ROLES[role])
