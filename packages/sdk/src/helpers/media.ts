// media.upload and music.importAndWait (cli-and-sdk plan §4.1 media and music rows; §2 gotcha 16). Up to 4 MB is one
// POST; bigger files use an upload session: 4 MB parts, each with its own sha256, sent again after a failure only when
// the session doesn't list them as received, then complete. Either way the item must reach `ready` before a video can
// use it, so upload waits for that (or throws media_rejected with the reason).
import { VideoAgentError } from '../errors.js'
import type { components } from '../generated/schema.js'
import type { Exchange } from '../http.js'

type Media = components['schemas']['Media']
type Session = components['schemas']['UploadSession']
type MediaCheckResult = components['schemas']['MediaCheckResult']
type OpenverseJob = components['schemas']['OpenverseJob']

/** The server's single-upload limit and session part size (src/domain/media-uploads.ts PART_SIZE). */
export const SINGLE_UPLOAD_MAX = 4 * 1024 * 1024

export interface UploadProgress {
  /** Bytes the server has acknowledged. */
  sent: number
  total: number
  phase: 'checking' | 'uploading' | 'verifying' | 'done'
}

export interface UploadOptions {
  /** Default: the path's or File's name. */
  filename?: string
  caption?: string
  /** A voice-over recording; needs scopeJobId (the video it's for). Always goes through a session. */
  role?: 'narration-take' | 'narration-upload'
  scopeJobId?: string
  /** Return an identical file already in the library instead of uploading (default true). */
  dedupe?: boolean
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
  /** How often to poll for assembly and verification. Default 2 s. */
  pollIntervalMs?: number
}

export interface MediaHelperDeps {
  send: (x: Exchange) => Promise<Response>
  /** Retries for one part. */
  retries: number
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error)
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason as Error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
export const sha256 = async (b: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', b))

async function json<T>(res: Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

/** The bytes and name of a path (Node, loaded lazily), a Blob or File, or raw bytes. */
async function bytesOf(file: string | Blob | Uint8Array, o: UploadOptions) {
  if (typeof file === 'string') {
    const spec = 'node:fs/promises'
    const fs = (await import(spec)) as { readFile(p: string): Promise<Uint8Array> }
    const raw = await fs.readFile(file)
    return { bytes: new Uint8Array(raw), filename: o.filename ?? file.split(/[\\/]/).pop() ?? 'upload' }
  }
  if (file instanceof Uint8Array) return { bytes: new Uint8Array(file), filename: o.filename ?? 'upload' }
  const name = (file as Blob & { name?: string }).name
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: o.filename ?? name ?? 'upload' }
}

export async function uploadMedia(
  d: MediaHelperDeps,
  file: string | Blob | Uint8Array,
  o: UploadOptions = {},
) {
  const { bytes, filename } = await bytesOf(file, o)
  const total = bytes.byteLength
  const progress = (sent: number, phase: UploadProgress['phase']) => o.onProgress?.({ sent, total, phase })
  progress(0, 'checking')
  const whole = await sha256(bytes)
  if (o.dedupe !== false && !o.role) {
    const check = await json<MediaCheckResult>(
      d.send({
        method: 'POST',
        url: '/api/v1/media/check',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ filename, sha256: whole }] }),
        signal: o.signal,
      }),
    )
    const same = check.files[0]?.sameFile
    if (same) {
      d.log?.('media.upload_deduped', { mediaId: same.id, bytes: total })
      progress(total, 'done')
      return same
    }
  }
  let mediaId: string
  if (total <= SINGLE_UPLOAD_MAX && !o.role) {
    progress(0, 'uploading')
    const qs = new URLSearchParams({ filename, ...(o.caption ? { caption: o.caption } : {}) })
    const item = await json<Media>(
      d.send({
        method: 'POST',
        url: `/api/v1/media?${qs.toString()}`,
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
        signal: o.signal,
      }),
    )
    mediaId = item.id
  } else {
    mediaId = await sessionUpload(d, bytes, filename, whole, o, progress)
  }
  progress(total, 'verifying')
  for (;;) {
    o.signal?.throwIfAborted()
    const item = await json<Media>(
      d.send({ method: 'GET', url: `/api/v1/media/${mediaId}`, signal: o.signal }),
    )
    if (item.status === 'ready') {
      progress(total, 'done')
      return item
    }
    if (item.status === 'rejected')
      throw new VideoAgentError({
        status: 0,
        code: 'media_rejected',
        message: `${filename} was rejected: ${item.rejectReason ?? 'no reason given'}`,
        details: { mediaId, rejectReason: item.rejectReason },
      })
    await sleep(o.pollIntervalMs ?? 2_000, o.signal)
  }
}

async function sessionUpload(
  d: MediaHelperDeps,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  whole: string,
  o: UploadOptions,
  progress: (sent: number, phase: UploadProgress['phase']) => void,
): Promise<string> {
  let session = await json<Session>(
    d.send({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename,
        size: bytes.byteLength,
        sha256: whole,
        ...(o.caption ? { caption: o.caption } : {}),
        ...(o.role ? { role: o.role, scopeJobId: o.scopeJobId } : {}),
      }),
      signal: o.signal,
    }),
  )
  const path = `/api/v1/media/uploads/${session.id}`
  try {
    const part = (i: number) => bytes.subarray(i * session.partSize, (i + 1) * session.partSize)
    const sentBytes = () => session.uploaded.reduce((n, i) => n + part(i).byteLength, 0)
    progress(sentBytes(), 'uploading')
    for (let i = 0; i < session.partCount; i++) {
      for (let attempt = 1; !session.uploaded.includes(i); attempt++) {
        o.signal?.throwIfAborted()
        const started = Date.now()
        const body = part(i)
        try {
          await d.send({
            method: 'PUT',
            url: `${path}/parts/${i}`,
            headers: { 'content-type': 'application/octet-stream', 'x-part-sha256': await sha256(body) },
            body,
            signal: o.signal,
          })
          session = { ...session, uploaded: [...session.uploaded, i] }
          d.log?.('media.part', {
            uploadId: session.id,
            index: i,
            bytes: body.byteLength,
            ms: Date.now() - started,
            attempt,
          })
          progress(sentBytes(), 'uploading')
        } catch (e) {
          d.log?.('media.part_failed', { uploadId: session.id, index: i, attempt, ms: Date.now() - started })
          if (o.signal?.aborted || attempt > d.retries) throw e
          await sleep(500 * 2 ** (attempt - 1), o.signal)
          // Resume from what the server has: a part that did arrive isn't sent again.
          session = await json<Session>(d.send({ method: 'GET', url: path, signal: o.signal }))
        }
      }
    }
    session = await json<Session>(d.send({ method: 'POST', url: `${path}/complete`, signal: o.signal }))
  } catch (e) {
    // Give back the reserved quota; best effort, and never with the aborted signal.
    await d.send({ method: 'DELETE', url: path }).catch(() => undefined)
    throw e
  }
  progress(bytes.byteLength, 'verifying')
  for (;;) {
    if (session.mediaId) return session.mediaId
    if (session.status === 'failed')
      throw new VideoAgentError({
        status: 0,
        code: 'media_rejected',
        message: `${filename} couldn't be assembled: ${session.error ?? 'no reason given'}`,
        details: { uploadId: session.id, error: session.error },
      })
    await sleep(o.pollIntervalMs ?? 2_000, o.signal)
    session = await json<Session>(d.send({ method: 'GET', url: path, signal: o.signal }))
  }
}

/** Imports an Openverse track; when Openverse is slow (202), follows the job until it's done or failed. */
export async function importMusicAndWait(
  d: MediaHelperDeps,
  input: { id: string; caption?: string },
  o: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<Media> {
  const res = await d.send({
    method: 'POST',
    url: '/api/v1/media/openverse/import',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: o.signal,
  })
  if (res.status !== 202) return (await res.json()) as Media
  let job = (await res.json()) as OpenverseJob
  for (;;) {
    if (job.status === 'done' && job.media) return job.media
    if (job.status === 'failed' || (job.status === 'done' && !job.media))
      throw new VideoAgentError({
        status: 0,
        code: 'music_import_failed',
        message: `Importing Openverse track ${input.id} failed${job.error ? `: ${job.error.message}` : '.'}`,
        details: { jobId: job.id, error: job.error },
      })
    await sleep(o.pollIntervalMs ?? 2_000, o.signal)
    job = await json<OpenverseJob>(
      d.send({ method: 'GET', url: `/api/v1/media/openverse/jobs/${job.id}`, signal: o.signal }),
    )
  }
}
