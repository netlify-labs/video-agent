// Credits for Openverse media. Library items are credited from the provenance of the media a version was made with;
// music and effects a run fetched itself (scripts/openverse.ts) from the credits.json finalize read from the run's
// saved composition and checked strictly (src/lib/openverse-rules.ts). Either way a CC BY work is credited on the
// video, its share page and embed.
import { licenseLabel, safeUrl, type RunCredit } from '../lib/openverse-rules.js'
import type { MediaProvenance, MediaRow, VersionProvenanceRow, VersionRow } from './types.js'

// The licence helpers are shared with the Openverse search and the run's helper script; re-exported for callers here.
export { licenseLabel, safeUrl } from '../lib/openverse-rules.js'

export interface Credit {
  /** The library item, or null for a file the run fetched from Openverse itself. */
  mediaId: string | null
  kind: MediaRow['kind']
  /** "Music" for audio, "Media" otherwise. */
  role: string
  title: string
  creator: string | null
  creatorUrl: string | null
  license: string
  licenseLabel: string
  licenseUrl: string | null
  /** The work's landing page. */
  sourceUrl: string | null
  source: string
  /** One line: "Title" by Creator, CC BY 4.0, <landing page>. */
  text: string
}

export function creditFor(mediaId: string | null, kind: MediaRow['kind'], p: MediaProvenance): Credit | null {
  if (!p.source || p.license !== 'by') return null
  const title = p.sourceTitle?.trim() || 'Untitled'
  const label = licenseLabel(p.license, p.licenseVersion)
  const sourceUrl = safeUrl(p.sourceUrl)
  const text = [`"${title}"${p.creator ? ` by ${p.creator}` : ''}`, label, sourceUrl]
    .filter(Boolean)
    .join(', ')
  return {
    mediaId,
    kind,
    role: kind === 'audio' ? 'Music' : 'Media',
    title,
    creator: p.creator,
    creatorUrl: safeUrl(p.creatorUrl),
    license: p.license,
    licenseLabel: label,
    licenseUrl: safeUrl(p.licenseUrl),
    sourceUrl,
    source: p.source,
    text,
  }
}

/** The credit for a file a run fetched itself (CC BY only; CC0 needs none). */
export function runCreditFor(c: RunCredit): Credit | null {
  const credit = creditFor(null, 'audio', {
    source: 'openverse',
    sourceId: c.openverseId,
    sourceUrl: c.sourceUrl,
    sourceTitle: c.title,
    license: c.license,
    licenseVersion: c.licenseVersion,
    licenseUrl: c.licenseUrl,
    creator: c.creator,
    creatorUrl: c.creatorUrl,
    attribution: c.attribution,
  })
  return credit && c.file.startsWith('assets/sfx/') ? { ...credit, role: 'Sound effect' } : credit
}

/**
 * The credits one version needs. Audio is only given to runs with sound (or a voice-over, where the editor can swap a
 * track in), so a silent version's picked track isn't credited; anything else it was made with is. Then the files
 * the run fetched itself (`run`, from its output), skipping any Openverse work the library already credits.
 */
export function versionCredits(
  rows: VersionProvenanceRow[],
  v: Pick<VersionRow, 'n' | 'sound' | 'voiceover'>,
  run: RunCredit[] | null | undefined = null,
): Credit[] {
  const audible = (v.sound ?? 'silent') !== 'silent' || Boolean(v.voiceover)
  const out: Credit[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.versionN !== v.n || (r.kind === 'audio' && !audible)) continue
    if (r.source === 'openverse' && r.sourceId) seen.add(r.sourceId)
    const c = creditFor(r.mediaId, r.kind, r)
    if (c && !out.some((x) => x.mediaId === c.mediaId)) out.push(c)
  }
  // Run credits were checked when the version was recorded: each plays in the composition.
  for (const r of run ?? []) {
    if (seen.has(r.openverseId)) continue
    seen.add(r.openverseId)
    const c = runCreditFor(r)
    if (c) out.push(c)
  }
  return out
}
