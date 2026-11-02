// Credits for imported media (Openverse). The server derives them from the provenance of the media a version was made
// with, never from what the agent wrote, so a CC BY track is always credited on the video, its share page and embed.
import type { MediaProvenance, MediaRow, VersionProvenanceRow, VersionRow } from './types.js'

/** The only licences imported: free for commercial use and edits. CC BY needs a credit; CC0 doesn't. */
export const IMPORT_LICENSES = ['cc0', 'by'] as const
export type ImportLicense = (typeof IMPORT_LICENSES)[number]

export const isImportLicense = (l: string | null | undefined): l is ImportLicense =>
  (IMPORT_LICENSES as readonly string[]).includes(l ?? '')

/** "CC BY 4.0", "CC0 1.0", or the slug in capitals for anything else. */
export function licenseLabel(license: string | null, version: string | null): string {
  if (!license) return ''
  const v = version ? ` ${version}` : ''
  if (license === 'cc0') return `CC0${v || ' 1.0'}`
  if (license === 'pdm') return 'Public Domain Mark'
  return `CC ${license.toUpperCase()}${v}`
}

/** An http(s) URL as given, or null: anything else never becomes a link. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export interface Credit {
  mediaId: string
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

export function creditFor(mediaId: string, kind: MediaRow['kind'], p: MediaProvenance): Credit | null {
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

/**
 * The credits one version needs. Audio is only given to runs with sound (or a voice-over, where the editor can swap a
 * track in), so a silent version's picked track isn't credited; anything else it was made with is.
 */
export function versionCredits(
  rows: VersionProvenanceRow[],
  v: Pick<VersionRow, 'n' | 'sound' | 'voiceover'>,
): Credit[] {
  const audible = (v.sound ?? 'silent') !== 'silent' || Boolean(v.voiceover)
  const out: Credit[] = []
  for (const r of rows) {
    if (r.versionN !== v.n || (r.kind === 'audio' && !audible)) continue
    const c = creditFor(r.mediaId, r.kind, r)
    if (c && !out.some((x) => x.mediaId === c.mediaId)) out.push(c)
  }
  return out
}
