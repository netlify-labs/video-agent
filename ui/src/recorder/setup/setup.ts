// The setup panel's value and what it maps to (plan 2026-11-02 §2.1 step 2): recorder options for createRecorder, the
// monitor's level while recording, and the NarrationOp track patch the editor applies. The chosen mic is remembered
// per browser; storage can be missing or throw (private windows, blocked site data), which just forgets it.
import type { NarrationTracks } from '../../../../src/lib/timeline'
import type { RecorderOptions } from '../recorder'

export type OutputMode = 'headphones' | 'speakers'
export type MonitorDuringRecord = 'mute' | 'duck'
/** What the panel offers for the AI voice-over; 'keep' (untouched) isn't a recording choice. */
export type SetupAiVoiceMode = 'replace' | 'under'
export type OriginalAudio = SetupAiVoiceMode | 'muteAll'

export interface RecordingSetupValue {
  /** The chosen input; null for the browser's default. */
  deviceId: string | null
  outputMode: OutputMode
  /** Speakers mode only: the monitor mix while recording. */
  monitorDuringRecord: MonitorDuringRecord
  aiVoiceMode: SetupAiVoiceMode
  /** The AI voice's level under yours ('under'). */
  aiVoiceDb: number
  muteAll: boolean
  /** On in speakers mode, off with headphones; follows outputMode (withOutputMode). */
  echoCancellation: boolean
}

export type TrackPatch = Pick<NarrationTracks, 'aiVoice' | 'original'>

export const DUCK_DB = -30
export const UNDER_DB = -12
export const AI_VOICE_DB_MIN = -40
export const AI_VOICE_DB_MAX = 0

const MIC_KEY = 'va.recorder.mic'

function storage(): Storage | null {
  try {
    return 'localStorage' in globalThis ? globalThis.localStorage : null
  } catch {
    return null
  }
}

export function loadDeviceId(s: Storage | null = storage()): string | null {
  try {
    return s?.getItem(MIC_KEY) || null
  } catch {
    return null
  }
}

export function saveDeviceId(id: string | null, s: Storage | null = storage()) {
  try {
    if (id) s?.setItem(MIC_KEY, id)
    else s?.removeItem(MIC_KEY)
  } catch {
    // Not remembered; the default mic next time.
  }
}

export function defaultSetup(deviceId: string | null = loadDeviceId()): RecordingSetupValue {
  return {
    deviceId,
    outputMode: 'headphones',
    monitorDuringRecord: 'mute',
    aiVoiceMode: 'replace',
    aiVoiceDb: UNDER_DB,
    muteAll: false,
    echoCancellation: false,
  }
}

export const withOutputMode = (v: RecordingSetupValue, outputMode: OutputMode): RecordingSetupValue => ({
  ...v,
  outputMode,
  echoCancellation: outputMode === 'speakers',
})

export const originalAudio = (v: RecordingSetupValue): OriginalAudio =>
  v.muteAll ? 'muteAll' : v.aiVoiceMode

/** Picking an original-audio option: muting all keeps the AI voice choice underneath for when it's turned back off. */
export const withOriginalAudio = (v: RecordingSetupValue, o: OriginalAudio): RecordingSetupValue =>
  o === 'muteAll' ? { ...v, muteAll: true } : { ...v, aiVoiceMode: o, muteAll: false }

/** The createRecorder options this setup asks for (the caller adds context, owner and callbacks). */
export function setupToRecorderOptions(
  v: RecordingSetupValue,
): Pick<RecorderOptions, 'deviceId' | 'echoCancellation'> {
  return { ...(v.deviceId ? { deviceId: v.deviceId } : {}), echoCancellation: v.outputMode === 'speakers' }
}

/** The monitor mix's gain in dB while recording: null for muted, 0 with headphones. Fixed for the take. */
export function monitorDbWhileRecording(v: RecordingSetupValue): number | null {
  if (v.outputMode === 'headphones') return 0
  return v.monitorDuringRecord === 'mute' ? null : DUCK_DB
}

export const clampAiVoiceDb = (db: number) =>
  Math.round(Math.min(AI_VOICE_DB_MAX, Math.max(AI_VOICE_DB_MIN, Number.isFinite(db) ? db : UNDER_DB)))

/** The NarrationOp tracks this setup sets; the editor merges it into its op. */
export function setupToTrackPatch(v: RecordingSetupValue): TrackPatch {
  return {
    aiVoice: { mode: v.aiVoiceMode, volumeDb: clampAiVoiceDb(v.aiVoiceDb) },
    original: { muteAll: v.muteAll },
  }
}

/** The original-audio part of a setup from an existing op's tracks ('keep' shows as under at 0 dB). */
export function setupFromTracks(
  tracks: TrackPatch,
  base: RecordingSetupValue = defaultSetup(),
): RecordingSetupValue {
  const { mode, volumeDb } = tracks.aiVoice
  return {
    ...base,
    aiVoiceMode: mode === 'replace' ? 'replace' : 'under',
    aiVoiceDb: mode === 'keep' ? 0 : clampAiVoiceDb(volumeDb),
    muteAll: tracks.original.muteAll,
  }
}
