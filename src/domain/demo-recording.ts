// A demo's recording across versions and runs (screen-recording plan §5.5): revisions and editor versions inherit the
// parent's inputs (the frozen trace, the person's boxes and trim), and every run of such a version gets them in its
// manifest, next to the recording's own library media entry.
import type { RunMedia, RunRecording } from '../lib/run-manifest.js'
import type { VersionRecording } from './types.js'

/** The inputs a new version keeps from its parent's recording; the results (summary, hidden areas) are its run's. */
export function inheritRecording(parent: VersionRecording | null | undefined): VersionRecording | null {
  if (!parent) return null
  return {
    mediaId: parent.mediaId,
    trace: parent.trace,
    trim: parent.trim,
    boxes: parent.boxes,
    compose: parent.compose,
    summary: null,
    hidden: [],
  }
}

/**
 * The manifest's recording block: the version's recording and the media entry it downloads as. Null when the version
 * has no recording, or its media entry is missing (the run then has no recording to work from).
 */
export function manifestRecording(
  r: VersionRecording | null | undefined,
  media: RunMedia[] | null,
): RunRecording | null {
  if (!r) return null
  const item = media?.find((m) => m.kind === 'video' && m.key.startsWith(`${r.mediaId}/`))
  if (!item) return null
  return {
    mediaId: r.mediaId,
    key: item.key,
    sha256: item.sha256,
    filename: item.filename,
    ...(r.trace ? { trace: r.trace } : {}),
    boxes: r.boxes,
    ...(r.trim ? { trim: r.trim } : {}),
    ...(r.compose ? { compose: true } : {}),
  }
}
