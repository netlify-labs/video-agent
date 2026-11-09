// Which track Add audio offers an item to first (owner, 2026-11-06): music imported from Openverse goes to Music, a
// take or a recording made for a video to Narration, anything else to the selected track.

/** The tracks audio can be added to. */
export type AddTarget = 'narration' | 'music'

/** Where an item goes unless the person says otherwise. */
export const defaultTarget = (
  m: { source?: { name: string } | null; role?: string | null } | null,
  selected: AddTarget,
): AddTarget => (m?.role ? 'narration' : m?.source?.name === 'openverse' ? 'music' : selected)
