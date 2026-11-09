// Stale picture (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1, §5.3): a take is recorded against the
// base version's MP4, so recording waits while a pending op would move time in the render. Retime, reorder and
// delete always do. A voice op re-speaks its line in the run, which lengthens the beat only when the new line no
// longer fits (applyRevoice): that's estimated here from the old clip's pace, with headroom, since the new length is
// known only once it's spoken. Text, colour, media, audio (music level or mute) and the narration op itself don't
// move time. Pure and browser-safe: the editor's Record button and the tests share it.
import { frames, normalizeLine } from './contract.js'

/** What timingChanged reads of an op: only its kind and the fields of the ones that can move time. */
export type PendingOp =
  | { op: 'retime'; beat: string; duration: number }
  | { op: 'reorder'; order: string[] }
  | { op: 'delete'; beat: string }
  | { op: 'voice'; beat: string; text: string }
  | { op: string }

/** What timingChanged reads of the base composition (contract `read`, or the edit DTO's `base`). */
export interface PictureBase {
  beats: readonly {
    id: string
    duration: number
    voice: { start: number; duration: number } | null
  }[]
  narration: readonly { beat: string; text: string }[]
}

/** Seconds a beat keeps after its voice ends: VOICE_TAIL in app/server/lib/voice.ts (node-only, so not imported here). */
export const VOICE_TAIL = 0.4
/**
 * How much slower than the old line's pace a re-spoken line is assumed to be: Kokoro's pace varies a little from line
 * to line, and this margin keeps a line that's estimated to fit from growing its beat anyway.
 */
export const REVOICE_HEADROOM = 1.25

/** The shortest a beat can be with a voice of `voiceSeconds` (minBeatSeconds in app/server/lib/voice.ts). */
const minBeat = (lead: number, voiceSeconds: number) =>
  Math.ceil((lead + voiceSeconds + VOICE_TAIL) * 10) / 10
/** Letters and digits: what takes time to say (spaces and punctuation are mostly pauses, kept by the phrase split). */
const sayable = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').length

/** Whether re-speaking `text` in `beatId` may lengthen the beat (conservative: unknown lines and beats say yes). */
export function voiceMovesTime(base: PictureBase, beatId: string, text: string): boolean {
  const beat = base.beats.find((b) => b.id === beatId)
  const was = base.narration.find((l) => l.beat === beatId)
  if (!beat?.voice || !was) return true
  if (normalizeLine(text) === normalizeLine(was.text)) return false // back to the spoken line: nothing re-speaks
  const before = sayable(was.text)
  if (before === 0 || !(beat.voice.duration > 0)) return true
  const estimate = (beat.voice.duration * sayable(text) * REVOICE_HEADROOM) / before
  // applyRevoice grows a beat only for a longer voice that no longer fits in it.
  return estimate > beat.voice.duration && minBeat(beat.voice.start, estimate) > beat.duration + 1e-9
}

/** True when a pending op would make the render's timing differ from the base version's picture. */
export function timingChanged(ops: readonly PendingOp[], base: PictureBase): boolean {
  const ids = base.beats.map((b) => b.id)
  return ops.some((o) => {
    if (o.op === 'delete') return true
    if (o.op === 'retime' && 'duration' in o) {
      const b = base.beats.find((x) => x.id === o.beat)
      return !b || frames(b.duration) !== frames(o.duration)
    }
    if (o.op === 'reorder' && 'order' in o) return o.order.join() !== ids.join()
    if (o.op === 'voice' && 'text' in o) return voiceMovesTime(base, o.beat, o.text)
    return false
  })
}
