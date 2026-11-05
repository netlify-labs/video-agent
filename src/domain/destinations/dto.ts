// The Version DTO's `destinations` list (publish destinations §6.1): the share page's entries derived from
// `publications`, then each destination publication. Never secrets, tokens, state or manifests.
import { sha256Hex } from '../../lib/crypto.js'
import type { DestinationPublicationRow, DestinationRow, PublicationRow } from '../types.js'
import { SHARE_PAGE_ID, YOUTUBE_ID } from './registry.js'

export interface DestinationPublicationDto {
  id: string
  kind: DestinationPublicationRow['kind']
  destination: { id: string; name: string }
  target: { name: string; url: string | null } | null
  status: DestinationPublicationRow['status']
  desired: DestinationPublicationRow['desired']
  url: string | null
  message: string | null
  warnings: string[]
  error: { code: string; message: string } | null
  hasSecret: boolean
  secretLabel: string | null
  publishedAt: string
  liveAt: string | null
}

export function destinationPublicationDto(
  p: DestinationPublicationRow,
  names: Map<string, string>,
  now: string,
): DestinationPublicationDto {
  const destId = p.kind === 'http' ? (p.destinationId ?? '') : YOUTUBE_ID
  const hasSecret =
    p.secretOnceEnc !== null && p.secretOnceConsumedAt === null && (p.secretOnceExpiresAt ?? '') > now
  return {
    id: p.id,
    kind: p.kind,
    destination: {
      id: destId,
      name: names.get(destId) ?? (p.kind === 'youtube' ? 'YouTube' : 'Destination'),
    },
    target: p.target ? { name: p.target.name, url: p.target.url } : null,
    status: p.status,
    desired: p.desired,
    url: p.url,
    message: p.message,
    warnings: p.warnings ?? [],
    error: p.error,
    hasSecret,
    secretLabel: hasSecret ? p.secretOnceLabel : null,
    publishedAt: p.createdAt,
    liveAt: p.liveAt,
  }
}

/** The share page's entry for one publication (it has no destination_publications row). */
export function sharePageEntry(p: PublicationRow, pageUrl: string): DestinationPublicationDto {
  return {
    id: `${SHARE_PAGE_ID}:${p.slug}`,
    kind: 'share_page',
    destination: { id: SHARE_PAGE_ID, name: 'Share page' },
    target: null,
    status: p.unpublishedAt ? 'removed' : 'live',
    desired: p.unpublishedAt ? 'removed' : 'published',
    url: p.unpublishedAt ? null : pageUrl,
    message: null,
    warnings: [],
    error: null,
    hasSecret: false,
    secretLabel: null,
    publishedAt: p.publishedAt,
    liveAt: p.publishedAt,
  }
}

export function destinationNames(rows: DestinationRow[]): Map<string, string> {
  return new Map([
    [YOUTUBE_ID, 'YouTube'],
    [SHARE_PAGE_ID, 'Share page'],
    ...rows.map((r) => [r.id, r.name] as const),
  ])
}

/** Part of the video's ETag: any change to a destination publication changes it (the page must not get a 304). */
export function destinationTag(rows: DestinationPublicationRow[]): string {
  if (!rows.length) return ''
  const parts = rows
    .map((p) => `${p.id}:${p.status}:${p.generation}:${p.updatedAt}:${p.secretOnceConsumedAt ?? ''}`)
    .sort()
  return `-d${sha256Hex(parts.join(',')).slice(0, 8)}`
}
