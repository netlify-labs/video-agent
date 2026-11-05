// Redo a scene in the UI (regenerate-beat plan §4.12): which scene a time falls in, the chip labels, and which chips
// can be picked. The rules mirror the server's scopeRules (src/lib/scope.ts) so people rarely hit a 400.
// No UI imports: test/ui-scenes.test.ts checks its copies of the server's strings against src/lib/scope.ts.

export type Beat = { id: string; label: string | null; start: number; duration: number }

/** The held last frame under recorded narration: a beat in the composition, never a scene to redo. */
export const HOLD_BEAT = 'va-hold'
/** The most scenes one scoped revision may redo (MAX_SCOPED_BEATS). */
export const MAX_PICKS = 20
/** A scope refusal's message starts with one of these (src/lib/scope.ts SCOPE_VIOLATED, SCOPE_REFUSED_PREFIX). */
export const SCOPE_VIOLATED = 'scope_violated'
export const SCOPE_REFUSED_PREFIX =
  'This run changed parts of the video outside the scenes it was asked to redo'

export const HELD_REASON =
  'This scene ends the video under your recorded narration and holds its last frame; redo it with a whole-video revision.'
export const EVERY_REASON = "That's every scene: choose Whole video instead"
export const MAX_REASON = `Pick at most ${MAX_PICKS} scenes`

const real = (beats: readonly Beat[]) => beats.filter((b) => b.id !== HOLD_BEAT)

/** The beat whose [start, start + duration) holds the time; at or past the end (or in the held frame), the last one. */
export function beatAt(beats: readonly Beat[], timeSec: number): Beat | null {
  const scenes = real(beats)
  if (timeSec <= 0) return scenes[0] ?? null
  return scenes.find((b) => timeSec >= b.start && timeSec < b.start + b.duration) ?? scenes.at(-1) ?? null
}

export const sceneName = (b: { id: string; label: string | null }) => b.label ?? b.id

const mss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

/** '2. Features · 0:04–0:10' for the scene at index i (from 0). */
export function sceneChipLabel(i: number, b: Beat): string {
  return `${i + 1}. ${sceneName(b)} · ${mss(b.start)}–${mss(b.start + b.duration)}`
}

/** The chips to show (never the held frame), each with why it can't be picked right now, if it can't. */
export function pickable(
  beats: readonly Beat[],
  picked: readonly string[],
): { beat: Beat; picked: boolean; disabled: string | null }[] {
  const scenes = real(beats)
  const held = scenes.length < beats.length
  const last = scenes.at(-1)?.id
  const on = new Set(picked.filter((p) => scenes.some((b) => b.id === p)))
  return scenes.map((beat) => {
    const isOn = on.has(beat.id)
    const disabled =
      held && beat.id === last
        ? HELD_REASON
        : isOn
          ? null
          : on.size >= MAX_PICKS
            ? MAX_REASON
            : !held && on.size === scenes.length - 1
              ? EVERY_REASON
              : null
    return { beat, picked: isOn, disabled }
  })
}

/** 'Redid Features', 'Redid Hook and Demo', 'Redid Hook, Demo and End card'. */
export function redidLabel(scope: { beats: { id: string; label: string | null }[] }): string {
  const names = scope.beats.map(sceneName)
  const list =
    names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
  return `Redid ${list}`
}

/** Whether a failed version's error is a scope refusal (isScopeRefusal in src/lib/scope.ts). */
export const isScopeRefusal = (message: string | null | undefined): boolean =>
  !!message && (message.startsWith(`${SCOPE_VIOLATED}:`) || message.startsWith(SCOPE_REFUSED_PREFIX))
