// Signed, expiring URLs for a version's files (served by the files edge function).
import type { Deps } from '../deps.js'
import { signPath } from '../lib/crypto.js'
import { getSettings } from './settings.js'

export const FILE_NAMES = {
  video: 'video.mp4',
  poster: 'poster.jpg',
  gif: 'preview.gif',
  captions: 'captions.vtt',
} as const
export type FileKind = keyof typeof FILE_NAMES

export async function signedFilePath(
  deps: Pick<Deps, 'store' | 'ids' | 'clock' | 'blobs'>,
  jobId: string,
  n: number,
  file: FileKind,
  ttlSec = 600,
  download = false,
): Promise<string> {
  const { fileSigningSecret } = await getSettings(deps)
  const path = `/files/${jobId}/v${n}/${FILE_NAMES[file]}`
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + ttlSec
  return `${path}?exp=${exp}&sig=${signPath(fileSigningSecret, path, exp)}${download ? '&download=1' : ''}`
}
