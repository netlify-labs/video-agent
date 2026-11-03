// Uploading to the media library (plan v2 §9): one request up to 4 MB; bigger files go in a resumable session of
// 4 MB parts, each with its sha256. A session survives a reload: its id is remembered per file, and a retry sends only
// the parts that didn't arrive. Clips get a poster frame captured in the browser. Voice-over recordings (plan
// 2026-11-02 §5.1) always use a session, with their role and video; the recorder passes the sha256 its worker computed
// as it recorded (so the file is never read whole here) and its peaks and speech spans, sent once the parts are in.
import { fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import type { Span } from '../../../src/lib/timeline'

type Session = paths['/api/v1/media/uploads/{id}']['get']['responses'][200]['content']['application/json']
type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
export type UploadRole = NonNullable<Session['role']>

const SINGLE_MAX = 4 * 1024 * 1024

export interface UploadProgress {
  sent: number
  total: number
  phase: 'hashing' | 'uploading' | 'checking'
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** A file's sha256, as the library stores it (for the duplicate check). */
export const fileSha256 = async (f: File) => sha256(await f.arrayBuffer())

/** Who, as what and for which video: a session is only resumed for the same person, role and video. */
interface ResumeScope {
  userId?: string | undefined
  role?: UploadRole | undefined
  scopeJobId?: string | undefined
}
const resumeKey = (f: File, s: ResumeScope) =>
  s.role
    ? `va-upload:${s.userId ?? ''}:${s.role}:${s.scopeJobId ?? ''}:${f.name}:${f.size}:${f.lastModified}`
    : `va-upload:${f.name}:${f.size}:${f.lastModified}`
function remembered(f: File, s: ResumeScope): string | null {
  try {
    return localStorage.getItem(resumeKey(f, s))
  } catch {
    return null
  }
}
function remember(f: File, s: ResumeScope, id: string | null) {
  try {
    if (id) localStorage.setItem(resumeKey(f, s), id)
    else localStorage.removeItem(resumeKey(f, s))
  } catch {
    // private mode: no resume across reloads
  }
}

/** A JPEG of the clip's frame at 30% (or 1 s), as base64, or null when the browser can't decode it. */
export async function posterOf(f: File): Promise<string | null> {
  if (!f.type.startsWith('video/')) return null
  const url = URL.createObjectURL(f)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((ok, bad) => {
      video.onloadeddata = () => {
        ok()
      }
      video.onerror = () => {
        bad(new Error('decode'))
      }
    })
    video.currentTime = Math.min(1, video.duration * 0.3)
    await new Promise<void>((ok) => {
      video.onseeked = () => {
        ok()
      }
    })
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1280 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((ok) => {
      canvas.toBlob(ok, 'image/jpeg', 0.8)
    })
    if (!blob) return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

export class UploadError extends Error {}
const message = (e: unknown, fallback: string) =>
  e && typeof e === 'object' && 'error' in e ? (e as { error: { message: string } }).error.message : fallback

export interface UploadOptions {
  caption?: string
  onProgress?: (p: UploadProgress) => void
  /** The whole file's sha256, when the caller already has it (the recorder's worker): the file isn't read whole. */
  sha256?: string
  /** A voice-over recording: always a session, held to the recordings budget, for the video `scopeJobId`. */
  role?: UploadRole
  scopeJobId?: string
  /** The signed-in person, so a remembered session is only resumed for them. */
  userId?: string
  /** A recording's waveform peaks (peaks.bin) and speech spans, sent after the parts. */
  extra?: { peaks?: Uint8Array; speech?: { version: number; spans: Span[]; samples?: number } }
}

/** Uploads one file; resolves with the media id. Throws UploadError with a message people can act on. */
export async function uploadFile(f: File, opts: UploadOptions = {}): Promise<string> {
  const progress = (sent: number, phase: UploadProgress['phase']) =>
    opts.onProgress?.({ sent, total: f.size, phase })
  const scope: ResumeScope = { userId: opts.userId, role: opts.role, scopeJobId: opts.scopeJobId }
  if (f.size <= SINGLE_MAX && !opts.role) {
    progress(0, 'uploading')
    const { data, error } = await fetchClient.POST('/api/v1/media', {
      params: { query: { filename: f.name, ...(opts.caption ? { caption: opts.caption } : {}) } },
      body: (await f.arrayBuffer()) as unknown as string,
      bodySerializer: (b: unknown) => b as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
    })
    if (!data) throw new UploadError(message(error, "The file couldn't be uploaded."))
    progress(f.size, 'checking')
    return data.id
  }

  progress(0, 'hashing')
  const whole = opts.sha256 ?? (await sha256(await f.arrayBuffer()))
  // Resume the same file's session if one is still open (and is for the same role and video).
  let session: Session | null = null
  const prior = remembered(f, scope)
  if (prior) {
    const { data } = await fetchClient.GET('/api/v1/media/uploads/{id}', { params: { path: { id: prior } } })
    if (
      data &&
      data.status === 'open' &&
      data.role === (opts.role ?? null) &&
      data.scopeJobId === (opts.role ? (opts.scopeJobId ?? null) : null)
    )
      session = data
  }
  if (!session) {
    const { data, error } = await fetchClient.POST('/api/v1/media/uploads', {
      body: {
        filename: f.name,
        size: f.size,
        sha256: whole,
        ...(opts.caption ? { caption: opts.caption } : {}),
        ...(opts.role ? { role: opts.role, scopeJobId: opts.scopeJobId } : {}),
      },
    })
    if (!data) throw new UploadError(message(error, "The upload couldn't start."))
    session = data
    remember(f, scope, data.id)
  }
  const id = session.id
  const done = new Set(session.uploaded)
  let sent = [...done].reduce((s, i) => s + Math.min(session.partSize, f.size - i * session.partSize), 0)
  progress(sent, 'uploading')
  for (let i = 0; i < session.partCount; i++) {
    if (done.has(i)) continue
    const chunk = await f
      .slice(i * session.partSize, Math.min(f.size, (i + 1) * session.partSize))
      .arrayBuffer()
    const { error, response } = await fetchClient.PUT('/api/v1/media/uploads/{id}/parts/{index}', {
      params: { path: { id, index: i }, header: { 'x-part-sha256': await sha256(chunk) } },
      body: chunk as unknown as string,
      bodySerializer: (b: unknown) => b as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
    })
    if (!response.ok)
      throw new UploadError(
        message(error, `Part ${i + 1} of ${session.partCount} didn't arrive. Try again to resume.`),
      )
    sent += chunk.byteLength
    progress(sent, 'uploading')
  }
  progress(f.size, 'checking')
  const poster = await posterOf(f)
  const { data, error, response } = await fetchClient.POST('/api/v1/media/uploads/{id}/complete', {
    params: { path: { id } },
    body: poster ? { poster } : {},
  })
  if (!data) {
    // A whole-file hash mismatch fails the session, so it can't be resumed: start afresh next time.
    if (response.status === 400) remember(f, scope, null)
    throw new UploadError(message(error, "The upload couldn't finish. Try again to resume."))
  }
  remember(f, scope, null)
  const mediaId = data.mediaId ?? ''
  if (mediaId && opts.extra) await sendExtras(mediaId, opts.extra)
  return mediaId
}

/** A recording's peaks and speech spans; the recording is already uploaded, so a failure here only loses the waveform. */
async function sendExtras(mediaId: string, extra: NonNullable<UploadOptions['extra']>) {
  if (extra.peaks) {
    const { error } = await fetchClient.PUT('/api/v1/media/{id}/peaks', {
      params: { path: { id: mediaId } },
      body: extra.peaks as unknown as string,
      bodySerializer: (b: unknown) => b as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
    })
    if (error) throw new UploadError(message(error, "The recording's waveform couldn't be saved."))
  }
  if (extra.speech) {
    const { error } = await fetchClient.PUT('/api/v1/media/{id}/speech', {
      params: { path: { id: mediaId } },
      body: extra.speech,
    })
    if (error) throw new UploadError(message(error, "The recording's speech spans couldn't be saved."))
  }
}

const sleep = (ms: number) =>
  new Promise<void>((ok) => {
    setTimeout(ok, ms)
  })

/**
 * Waits until an uploaded item is checked: resolves with it once ready, throws UploadError with the reason when it's
 * rejected or the wait runs out. Completion returns while the file is still being checked, so anything that uses the
 * item (a draft save referencing a take) waits here first. Polls with backoff: 250 ms doubling to 4 s.
 */
export async function waitReady(
  mediaId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; wait?: (ms: number) => Promise<void> } = {},
): Promise<Media> {
  const wait = opts.wait ?? sleep
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
    if (opts.signal?.aborted) throw new UploadError('Stopped waiting for the upload.')
    const { data, error } = await fetchClient.GET('/api/v1/media/{id}', { params: { path: { id: mediaId } } })
    if (!data) throw new UploadError(message(error, "The uploaded file couldn't be found."))
    if (data.status === 'ready') return data
    if (data.status === 'rejected') throw new UploadError(data.rejectReason ?? 'The file was rejected.')
    if (Date.now() + delay > deadline)
      throw new UploadError('The file is taking too long to check. Try again in a minute.')
    await wait(delay)
  }
}
