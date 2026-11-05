// Looks in the web app (plan 2026-11-04-looks §6): the catalog's DTO and the pure rules the pickers share.
import type { paths } from '../api/schema'

export type Looks = paths['/api/v1/looks']['get']['responses'][200]['content']['application/json']
export type Look = Looks['looks'][number]

const ALL_ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const

/** Looks a person can pick: an admin's disabled ones are hidden (versions already made with one keep it). */
export const pickable = (looks: readonly Look[]): Look[] => looks.filter((l) => l.enabled)

/**
 * Picker order: with a plan's template, the looks made for it come first (catalog order otherwise kept). `fits` says
 * which ones get the "Fits a launch" note.
 */
export function sortForTemplate(
  looks: readonly Look[],
  template?: string | null,
): { look: Look; fits: boolean }[] {
  const rows = looks.map((look) => ({ look, fits: !!template && look.bestFor.includes(template) }))
  return [...rows.filter((r) => r.fits), ...rows.filter((r) => !r.fits)]
}

/** "Made for 16:9 and 9:16" when the look's rules don't cover every shape; null when they do. */
export function aspectNote(look: Pick<Look, 'aspects'>): string | null {
  if (ALL_ASPECTS.every((a) => look.aspects.includes(a))) return null
  const list =
    look.aspects.length > 1
      ? `${look.aspects.slice(0, -1).join(', ')} and ${look.aspects.at(-1)}`
      : look.aspects[0]
  return `Made for ${list}`
}

/**
 * The screen-recording demo picker's looks: enabled, made with HyperFrames, and not hiding recordings
 * (recording: false).
 */
export const looksForDemo = (looks: readonly Look[]): Look[] =>
  pickable(looks).filter((l) => l.recording !== false && l.engines.includes('hyperframes'))

/** The look a create gets when it leaves Look untouched: the admin default, if it's still enabled. */
export function defaultLook(data: Looks | undefined): Look | null {
  if (!data?.default) return null
  return data.looks.find((l) => l.id === data.default && l.enabled) ?? null
}
