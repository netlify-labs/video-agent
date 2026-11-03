// The team media library (plan v2 §9, §14 rules 24-27). Creators and admins upload; everyone sees ready items;
// uploaders also see their own pending ones. Types come from the bytes. SVGs are sanitized, and only the clean copy is
// ever used; the original is served strictly as a download. Deleting is soft: versions that used an item keep it.
import type { Deps } from '../deps.js'
import { signPath, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { classify, MediaError, type Classified } from '../lib/media/classify.js'
import { sanitizeSvg, SvgError } from '../lib/media/svg.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import type { Repo } from '../store/types.js'
import { NO_PROVENANCE, type MediaProvenance, type MediaRow, type VersionMediaRow } from './types.js'
import { licenseLabel, safeUrl } from './credits.js'
import { canSee, decodeCursor, nextCursor } from './videos.js'

/** One request carries at most this much (Netlify's request limit is about 4.5 MB); bigger files use sessions. */
export const SINGLE_UPLOAD_MAX = 4 * 1024 * 1024
export const MEDIA_URL_TTL_SEC = 600

export type MediaFile = 'file' | 'original' | 'poster'
export const mediaKeys = (id: string, ext: string) => ({
  original: `${id}/original.${ext}`,
  clean: `${id}/clean.${ext}`,
  poster: `${id}/poster.jpg`,
})

function cleanName(name: string | undefined, ext: string) {
  const base = (name ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^\w .-]+/g, '')
    .trim()
    .slice(0, 80)
  return `${base || 'upload'}.${ext}`
}

/**
 * Stores verified bytes as a ready item (or, for video clips finished by an upload session, the caller passes the
 * already-classified result). SVGs get their clean copy here.
 */
export async function storeMedia(
  deps: Deps,
  p: Pick<Principal, 'userId'>,
  bytes: Uint8Array,
  c: Classified,
  meta: {
    filename?: string | undefined
    caption?: string | undefined
    id?: string
    poster?: Uint8Array | null
    provenance?: MediaProvenance
  },
) {
  const id = meta.id ?? `med_${deps.ids.uuid().replaceAll('-', '').slice(0, 24)}`
  const keys = mediaKeys(id, c.ext)
  let clean = bytes
  if (c.kind === 'svg') {
    try {
      clean = sanitizeSvg(bytes)
    } catch (e) {
      // A refused SVG is the file's fault; anything else is a bug, logged before it reads as one.
      if (!(e instanceof SvgError)) deps.log.error('media.sanitize_failed', { error: e })
      throw new ApiError('invalid_request', e instanceof SvgError ? e.message : "The SVG couldn't be read.")
    }
  }
  const filename = cleanName(meta.filename, c.ext)
  const md = (b: Uint8Array, disposition: 'inline' | 'attachment') => ({
    contentType: c.mime,
    size: String(b.byteLength),
    filename,
    disposition,
  })
  // The original of an SVG is only ever a download; other originals are what runs use, so the clean key is the same.
  // An SVG's original and a PDF are only ever downloaded: opened in the browser, either could run scripts.
  await deps.blobs.set(
    'media',
    keys.original,
    bytes,
    md(bytes, c.kind === 'svg' || c.kind === 'pdf' ? 'attachment' : 'inline'),
  )
  const cleanKey = c.kind === 'svg' ? keys.clean : keys.original
  if (c.kind === 'svg') await deps.blobs.set('media', keys.clean, clean, md(clean, 'inline'))
  let posterKey: string | null = null
  if (meta.poster) {
    const pc = classify(meta.poster)
    if (pc.ext === 'jpg') {
      await deps.blobs.set('media', keys.poster, meta.poster, {
        contentType: 'image/jpeg',
        size: String(meta.poster.byteLength),
        filename: 'poster.jpg',
        disposition: 'inline',
      })
      posterKey = keys.poster
    }
  }
  // What the /media edge route serves for each variant (it has no database).
  await deps.blobs.set(
    'media',
    `${id}/meta.json`,
    JSON.stringify({ file: cleanKey, original: keys.original, poster: posterKey }),
    { contentType: 'application/json' },
  )
  const now = deps.clock.now().toISOString()
  const row: MediaRow = {
    id,
    uploaderId: p.userId,
    kind: c.kind,
    status: 'ready',
    rejectReason: null,
    filename,
    title: null,
    caption: meta.caption?.trim().slice(0, 500) || null,
    mime: c.mime,
    ext: c.ext,
    bytes: bytes.byteLength,
    originalKey: keys.original,
    originalSha256: sha256Hex(bytes),
    cleanKey,
    cleanSha256: sha256Hex(clean),
    width: c.width,
    height: c.height,
    durationSec: c.durationSec,
    posterKey,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    role: null,
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...(meta.provenance ?? NO_PROVENANCE),
  }
  return row
}

/** One-request upload (up to 4 MB): images, SVGs, fonts and short clips. */
export async function uploadMedia(
  deps: Deps,
  p: Principal,
  bytes: Uint8Array,
  meta: { filename?: string | undefined; caption?: string | undefined },
) {
  assertCan(p, 'media:upload')
  if (bytes.byteLength === 0) throw new ApiError('invalid_request', 'The file is empty.')
  if (bytes.byteLength > SINGLE_UPLOAD_MAX)
    throw new ApiError('invalid_request', 'Files over 4 MB upload in parts: start an upload session.')
  let c: Classified
  try {
    c = classify(bytes)
  } catch (e) {
    if (!(e instanceof MediaError)) deps.log.error('media.classify_failed', { error: e })
    throw new ApiError('invalid_request', e instanceof MediaError ? e.message : "The file couldn't be read.")
  }
  const row = await storeMedia(deps, p, bytes, c, meta)
  await deps.store.insertMedia(row)
  deps.log.info('media.uploaded', { id: row.id, kind: row.kind, bytes: row.bytes })
  return mediaDto(deps, p, row)
}

async function signed(deps: Deps, id: string, file: MediaFile) {
  const { fileSigningSecret } = await getSettings(deps)
  const path = `/media/${id}/${file}`
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + MEDIA_URL_TTL_SEC
  return `${path}?exp=${exp}&sig=${signPath(fileSigningSecret, path, exp)}`
}

export async function mediaDto(deps: Deps, p: Principal, m: MediaRow, usage?: Record<string, string[]>) {
  const uploader = await deps.store.getUser(m.uploaderId)
  // "Used in N videos" counts only videos this person can see.
  const jobs = (usage ?? (await deps.store.mediaUsage([m.id])))[m.id] ?? []
  let usedIn = 0
  for (const jobId of jobs) {
    const job = await deps.store.getJob(jobId)
    if (job && !job.deletedAt && canSee(p, job)) usedIn++
  }
  const ready = m.status === 'ready'
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    rejectReason: m.rejectReason,
    filename: m.filename,
    title: m.title,
    caption: m.caption,
    mime: m.mime,
    bytes: m.bytes,
    width: m.width,
    height: m.height,
    durationSec: m.durationSec,
    uploader: { id: m.uploaderId, name: uploader?.name ?? null, email: uploader?.email ?? null },
    createdAt: m.createdAt,
    usedIn,
    urls: ready
      ? {
          file: await signed(deps, m.id, 'file'),
          original: await signed(deps, m.id, 'original'),
          poster: m.posterKey ? await signed(deps, m.id, 'poster') : null,
        }
      : null,
    canDelete: m.uploaderId === p.userId || p.role === 'admin',
    source: sourceDto(m),
  }
}

/** Where an imported item came from, its licence and whether a credit is required; null for uploads. */
function sourceDto(m: MediaProvenance) {
  if (!m.source || !m.sourceId) return null
  return {
    name: m.source,
    id: m.sourceId,
    url: safeUrl(m.sourceUrl),
    title: m.sourceTitle,
    creator: m.creator,
    creatorUrl: safeUrl(m.creatorUrl),
    license: m.license ?? '',
    licenseVersion: m.licenseVersion,
    licenseLabel: licenseLabel(m.license, m.licenseVersion),
    licenseUrl: safeUrl(m.licenseUrl),
    attribution: m.attribution,
    creditRequired: m.license === 'by',
  }
}

/** Ready items (and the caller's own pending ones), newest first. */
export async function listMedia(
  deps: Deps,
  p: Principal,
  q: {
    kind?: MediaRow['kind'] | undefined
    q?: string | undefined
    sort?: 'newest' | 'oldest' | 'name' | undefined
    cursor?: string | undefined
    limit?: number | undefined
  },
) {
  assertCan(p, 'video:read')
  const limit = Math.min(Math.max(q.limit ?? 48, 1), 100)
  const sort = q.sort ?? 'newest'
  const before = decodeCursor(q.cursor)
  const rows = await deps.store.listMedia({
    kind: q.kind,
    search: q.q,
    sort,
    includePendingOf: p.userId,
    before,
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  const usage = await deps.store.mediaUsage(page.map((m) => m.id))
  return {
    items: await Promise.all(page.map((m) => mediaDto(deps, p, m, usage))),
    // Only newest-first pages continue; the other orders return the first `limit` matches.
    nextCursor: sort === 'newest' ? nextCursor(rows.length, limit, page) : null,
  }
}

/**
 * What's already in the library for files about to be uploaded: the same file (identical bytes, so the upload can
 * be skipped) or a different file with the same name (so the person can replace it, keep both or skip).
 */
export async function checkMedia(deps: Deps, p: Principal, files: { filename: string; sha256: string }[]) {
  assertCan(p, 'media:upload')
  const rows = await deps.store.findMediaMatches({
    sha256s: [...new Set(files.map((f) => f.sha256))],
    filenames: [...new Set(files.map((f) => f.filename))],
    includePendingOf: p.userId,
  })
  const usage = await deps.store.mediaUsage(rows.map((m) => m.id))
  const dto = (m: MediaRow | undefined) => (m ? mediaDto(deps, p, m, usage) : Promise.resolve(null))
  return {
    files: await Promise.all(
      files.map(async (f) => ({
        filename: f.filename,
        sha256: f.sha256,
        sameFile: await dto(rows.find((m) => m.originalSha256 === f.sha256)),
        sameName: await dto(rows.find((m) => m.filename === f.filename && m.originalSha256 !== f.sha256)),
      })),
    ),
  }
}

async function loadMedia(deps: Deps, p: Principal, id: string) {
  const m = await deps.store.getMedia(id)
  if (!m || m.deletedAt || (m.status !== 'ready' && m.uploaderId !== p.userId))
    throw new ApiError('not_found', 'Media not found.')
  return m
}

export async function getMedia(deps: Deps, p: Principal, id: string) {
  assertCan(p, 'video:read')
  return mediaDto(deps, p, await loadMedia(deps, p, id))
}

/** Renames an item or changes its notes (uploader or admin). Fields left out stay; empty ones are cleared. */
export async function updateMedia(
  deps: Deps,
  p: Principal,
  id: string,
  patch: { caption?: string | null | undefined; title?: string | null | undefined },
) {
  const m = await loadMedia(deps, p, id)
  if (m.uploaderId !== p.userId && p.role !== 'admin')
    throw new ApiError('forbidden', 'Only the uploader or an admin can change this item.')
  const next: Partial<MediaRow> = {}
  if (patch.caption !== undefined) next.caption = patch.caption?.trim().slice(0, 500) || null
  if (patch.title !== undefined) next.title = patch.title?.replace(/\s+/g, ' ').trim().slice(0, 120) || null
  await deps.store.updateMedia(id, { ...next, updatedAt: deps.clock.now().toISOString() })
  return mediaDto(deps, p, { ...m, ...next })
}

/** Soft delete: it leaves the library, but versions that used it keep their bytes. */
export async function deleteMedia(deps: Deps, p: Principal, id: string) {
  const m = await loadMedia(deps, p, id)
  if (m.uploaderId !== p.userId && p.role !== 'admin')
    throw new ApiError('forbidden', 'Only the uploader or an admin can delete this item.')
  await deps.store.updateMedia(id, { deletedAt: deps.clock.now().toISOString() })
}

export const MEDIA_PER_VERSION = 12
const MEDIA_BYTES_PER_VERSION = 300 * 1024 * 1024

/**
 * The media a new version is made with (plan v2 §9, §14 rule 27): what it inherits, plus new picks, which must be
 * ready library items. Snapshotted (key, hash, caption) so later library changes never alter what the run gets.
 */
export async function snapshotMedia(
  repo: Repo,
  jobId: string,
  n: number,
  picks: string[],
  inherited: VersionMediaRow[],
): Promise<VersionMediaRow[]> {
  const rows: VersionMediaRow[] = inherited.map((r, i) => ({ ...r, jobId, versionN: n, position: i }))
  for (const id of [...new Set(picks)]) {
    if (rows.some((r) => r.mediaId === id)) continue
    const m = await repo.getMedia(id)
    if (!m || m.deletedAt || m.status !== 'ready')
      throw new ApiError('invalid_request', `Media ${id} isn't a ready item in the library.`)
    rows.push({
      jobId,
      versionN: n,
      mediaId: m.id,
      position: rows.length,
      kind: m.kind,
      key: m.cleanKey,
      sha256: m.cleanSha256,
      filename: `${m.id}.${m.ext}`,
      caption: m.caption,
    })
  }
  if (rows.length > MEDIA_PER_VERSION)
    throw new ApiError('invalid_request', `Use at most ${MEDIA_PER_VERSION} media items in one version.`)
  let bytes = 0
  for (const r of rows) bytes += (await repo.getMedia(r.mediaId))?.bytes ?? 0
  if (bytes > MEDIA_BYTES_PER_VERSION)
    throw new ApiError('invalid_request', 'That media adds up to more than 300 MB.')
  return rows
}
