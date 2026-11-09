// A screen recording into the library (screen-recording plan §4.3; va-rsk5.4.1): the sha256 streams over the file
// (app/web/src/recorder/sha256.ts) so 150 MB is never one buffer on the main thread, then an upload session with the
// screen-recording role (always a session, even under 4 MB), then the pointer trace when one came with the file.
import { fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import { Sha256 } from '../recorder/sha256'
import { UploadError, uploadFile, waitReady, type UploadProgress } from './upload'

export type Trace = paths['/api/v1/media/{id}/trace']['put']['requestBody']['content']['application/json']

const SLICE = 4 * 1024 * 1024

/** The file's sha256, read 4 MB at a time. */
export async function streamSha256(f: Blob, onProgress?: (done: number) => void): Promise<string> {
  const h = new Sha256()
  for (let at = 0; at < f.size; at += SLICE) {
    h.update(new Uint8Array(await f.slice(at, Math.min(f.size, at + SLICE)).arrayBuffer()))
    onProgress?.(Math.min(f.size, at + SLICE))
  }
  return h.hex()
}

/** A trace.json dropped beside the recording: parsed, or an UploadError saying why not. */
export async function readTrace(f: File): Promise<Trace> {
  try {
    // Untrusted until the server checks it; this only catches a file that isn't a trace at all.
    const t = JSON.parse(await f.text()) as Record<string, unknown> | null
    if (t?.v !== 1 || typeof t.frame !== 'object') throw new Error('shape')
    return t as unknown as Trace
  } catch {
    throw new UploadError(`${f.name} isn't a pointer trace from video-agent record.`)
  }
}

/** Uploads a normalized recording (and its trace); resolves once the library has checked it. */
export async function uploadRecording(
  file: File,
  opts: { trace?: Trace | null; userId?: string; onProgress?: (p: UploadProgress) => void } = {},
): Promise<string> {
  opts.onProgress?.({ sent: 0, total: file.size, phase: 'hashing' })
  const sha256 = await streamSha256(file, (done) =>
    opts.onProgress?.({ sent: done, total: file.size, phase: 'hashing' }),
  )
  const id = await uploadFile(file, {
    role: 'screen-recording',
    sha256,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  })
  await waitReady(id, { timeoutMs: 5 * 60_000 })
  if (opts.trace) {
    const { error } = await fetchClient.PUT('/api/v1/media/{id}/trace', {
      params: { path: { id } },
      body: opts.trace,
    })
    if (error) throw new UploadError(error.error.message)
  }
  return id
}
