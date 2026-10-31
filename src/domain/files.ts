// Signed, expiring URLs for a version's files (served by the files edge function).
import type { Deps } from '../deps.js'
import { signPath } from '../lib/crypto.js'
import type { JobRow } from './types.js'
import { getSettings } from './settings.js'

export const FILE_NAMES = {
  video: 'video.mp4',
  poster: 'poster.jpg',
  gif: 'preview.gif',
  captions: 'captions.vtt',
} as const
export type FileKind = keyof typeof FILE_NAMES

/** Private-video file URLs last at most this long (plan v2 §14 rule 4). */
export const PRIVATE_URL_TTL_SEC = 600

export async function signedFilePath(
  deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>,
  job: Pick<JobRow, 'id' | 'private' | 'accessEpoch'>,
  n: number,
  file: FileKind,
  ttlSec = 600,
  download = false,
): Promise<string> {
  const { fileSigningSecret } = await getSettings(deps)
  const path = `/files/${job.id}/v${n}/${FILE_NAMES[file]}`
  const ttl = job.private ? Math.min(ttlSec, PRIVATE_URL_TTL_SEC) : ttlSec
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + ttl
  const epoch = job.private ? job.accessEpoch : undefined
  const sig = signPath(fileSigningSecret, path, exp, epoch)
  return `${path}?exp=${exp}${epoch === undefined ? '' : `&e=${epoch}`}&sig=${sig}${download ? '&download=1' : ''}`
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
