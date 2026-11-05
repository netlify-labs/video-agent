// Signed, expiring URLs for a version's files (served by the files edge function).
import type { Deps } from '../deps.js'
import { signPath } from '../lib/crypto.js'
import { isPreviewFile, type PreviewFile } from '../lib/media/previews.js'
import type { JobRow, OutputRow, VersionPoster, VersionRow } from './types.js'
import { getSettings } from './settings.js'

export const FILE_NAMES = {
  video: 'video.mp4',
  poster: 'poster.jpg',
  gif: 'preview.gif',
  captions: 'captions.vtt',
  // Recorded narration's downloads (plan 2026-11-02 §6.7): only narrated versions have them. Not `narration`: that
  // path is the version's narration op (plan §7).
  'narration-audio': 'narration.mp3',
  transcript: 'transcript.txt',
} as const
export type FileKind = keyof typeof FILE_NAMES

/** The stored name of one of a version's files, or null when the version has none (no narration, no transcript). */
export function versionFileName(
  v: Pick<VersionRow, 'captions' | 'poster'>,
  o: Pick<OutputRow, 'sha256'>,
  file: FileKind,
): string | null {
  // A caption revision (src/domain/captions.ts) has its own immutable names, so each one is a new URL.
  if (file === 'captions') return v.captions?.files.vtt ?? FILE_NAMES.captions
  // So does a picked poster (src/domain/poster.ts).
  if (file === 'poster') return v.poster?.custom?.files.jpg ?? FILE_NAMES.poster
  if (file === 'transcript')
    return v.captions?.files.transcript ?? (o.sha256[FILE_NAMES.transcript] ? FILE_NAMES.transcript : null)
  if (file === 'narration-audio')
    return o.sha256[FILE_NAMES['narration-audio']] ? FILE_NAMES['narration-audio'] : null
  return FILE_NAMES[file]
}

/** A published version's poster keys: the pick's files (src/domain/poster.ts), or the render's. posterWebp null: none. */
export function posterKeys(
  jobId: string,
  n: number,
  o: Pick<OutputRow, 'posterKey' | 'previews'>,
  poster: VersionPoster | null | undefined,
): { poster: string; posterWebp: string | null } {
  const key = (name: string) => `${jobId}/v${n}/${name}`
  const c = poster?.custom
  if (c) {
    const webp = c.files.webp960 ?? c.files.webp480
    return { poster: key(c.files.jpg), posterWebp: webp ? key(webp) : null }
  }
  return {
    poster: o.posterKey,
    posterWebp: o.previews?.files['poster-960.webp'] ? key('poster-960.webp') : null,
  }
}

/** The poster's blurred placeholder: a picked poster's own, else the render's; null when there's none. */
export function posterLqip(
  o: Pick<OutputRow, 'previews'>,
  poster: VersionPoster | null | undefined,
): string | null {
  return poster?.custom ? poster.custom.lqip : (o.previews?.lqip ?? null)
}

/** Private-video file URLs last at most this long (plan v2 §14 rule 4). */
export const PRIVATE_URL_TTL_SEC = 600

/** File URLs in the video DTO last this long for public videos (private ones: PRIVATE_URL_TTL_SEC). */
export const PUBLIC_URL_TTL_SEC = 3600

/**
 * An expiry snapped to a window of ttl/2, so every URL minted in the same window is identical and the browser can
 * cache the file. The lifetime stays in (ttl/2, ttl]: never longer than an unsnapped URL.
 */
export function stableExp(nowSec: number, ttlSec: number): number {
  const window = Math.max(1, Math.floor(ttlSec / 2))
  return Math.floor((Math.floor(nowSec) + ttlSec) / window) * window
}

/** The signed-URL lifetime for a job: `ttlSec`, capped for private videos. */
export const fileTtl = (job: Pick<JobRow, 'private'>, ttlSec: number) =>
  job.private ? Math.min(ttlSec, PRIVATE_URL_TTL_SEC) : ttlSec

/** Signs one file path for a known expiry (the job's access epoch is bound in for private videos). Preview variants
 * are named by their file name; `name` overrides a kind's fixed one (versionFileName). */
export function signFile(
  secret: string,
  job: Pick<JobRow, 'id' | 'private' | 'accessEpoch'>,
  n: number,
  file: FileKind | PreviewFile,
  exp: number,
  name?: string,
): string {
  const path = `/files/${job.id}/v${n}/${name ?? (isPreviewFile(file) ? file : FILE_NAMES[file])}`
  const epoch = job.private ? job.accessEpoch : undefined
  const sig = signPath(secret, path, exp, epoch)
  return `${path}?exp=${exp}${epoch === undefined ? '' : `&e=${epoch}`}&sig=${sig}`
}

export async function signedFilePath(
  deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>,
  job: Pick<JobRow, 'id' | 'private' | 'accessEpoch'>,
  n: number,
  file: FileKind,
  o: { ttlSec?: number; download?: boolean; stable?: boolean; name?: string | undefined } = {},
): Promise<string> {
  const { fileSigningSecret } = await getSettings(deps)
  const ttl = fileTtl(job, o.ttlSec ?? 600)
  const nowSec = Math.floor(deps.clock.now().getTime() / 1000)
  const exp = o.stable ? stableExp(nowSec, ttl) : nowSec + ttl
  return `${signFile(fileSigningSecret, job, n, file, exp, o.name)}${o.download ? '&download=1' : ''}`
}

export const accessKey = (jobId: string) => `access/${jobId}.json`

/** Mirrors a job's privacy and access epoch for the files edge function. Written inside the transaction that
 * changes them, so a failure leaves the mirror stricter than the database, never looser. */
export async function writeAccessMirror(
  deps: Pick<Deps, 'blobs'>,
  job: Pick<JobRow, 'id' | 'private' | 'accessEpoch'>,
) {
  await deps.blobs.set(
    'internal',
    accessKey(job.id),
    JSON.stringify({ private: job.private, epoch: job.accessEpoch }),
  )
}
