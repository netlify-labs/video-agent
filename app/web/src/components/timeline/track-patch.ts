// Applying a lane control change to the op's tracks (the music layer's own level is an `audio` op, so it isn't
// here). Kept apart from the components so the editor and tests can use it without React.
import type { NarrationTracks } from '../../../../server/lib/timeline'
import type { TrackPatch } from './types'

/** The tracks with `patch` applied; unchanged (the same object) for a music level patch. */
export function applyTrackPatch(tracks: NarrationTracks, patch: TrackPatch): NarrationTracks {
  switch (patch.lane) {
    case 'narration':
      return { ...tracks, narration: { ...tracks.narration, ...patch.set } }
    case 'aiVoice':
      return { ...tracks, aiVoice: { ...tracks.aiVoice, ...patch.set } }
    case 'music':
      return { ...tracks, music: { ...tracks.music, ...patch.set } }
    case 'musicLevel':
      return tracks
  }
}
