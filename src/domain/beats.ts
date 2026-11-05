// Which scenes a version has (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.2): the beats of its saved
// composition, read once (at finalize, or on first request for older versions) and stored on the version, so the
// video DTO and scoped revisions never unpack an archive.
import { load, read } from '../lib/contract.js'
import type { BeatInfo } from './types.js'

/** The beats of a composition's files; null unless index.html declares editing contract v1 and can be read. */
export function beatsOf(files: Map<string, Uint8Array>): BeatInfo[] | null {
  const raw = files.get('index.html')
  if (!raw) return null
  const html = new TextDecoder().decode(raw)
  if (!/data-va-contract\s*=\s*["']1["']/.test(html)) return null
  try {
    // The held last frame (va-hold) is listed too: a scoped revision has to see it to refuse it.
    return read(load(html)).beats.map((b) => ({
      id: b.id,
      label: b.label,
      start: b.start,
      duration: b.duration,
    }))
  } catch {
    return null
  }
}
