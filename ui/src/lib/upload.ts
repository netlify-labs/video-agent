// Uploading to the media library (plan v2 §9): one request up to 4 MB; bigger files go in a resumable session of
// 4 MB parts, each with its sha256. A session survives a reload: its id is remembered per file, and a retry sends only
// the parts that didn't arrive. Clips get a poster frame captured in the browser.
import { fetchClient } from '../api/client'
import type { paths } from '../api/schema'

type Session = paths['/api/v1/media/uploads/{id}']['get']['responses'][200]['content']['application/json']

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

const resumeKey = (f: File) => `va-upload:${f.name}:${f.size}:${f.lastModified}`
function remembered(f: File): string | null {
  try {
    return localStorage.getItem(resumeKey(f))
  } catch {
    return null
  }
}
function remember(f: File, id: string | null) {
  try {
    if (id) localStorage.setItem(resumeKey(f), id)
    else localStorage.removeItem(resumeKey(f))
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

class UploadError extends Error {}
const message = (e: unknown, fallback: string) =>
  e && typeof e === 'object' && 'error' in e ? (e as { error: { message: string } }).error.message : fallback

/** Uploads one file; resolves with the media id. Throws UploadError with a message people can act on. */
export async function uploadFile(
  f: File,
  opts: { caption?: string; onProgress?: (p: UploadProgress) => void } = {},
): Promise<string> {
  const progress = (sent: number, phase: UploadProgress['phase']) =>
    opts.onProgress?.({ sent, total: f.size, phase })
  if (f.size <= SINGLE_MAX) {
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
  const whole = await sha256(await f.arrayBuffer())
  // Resume the same file's session if one is still open.
  let session: Session | null = null
  const prior = remembered(f)
  if (prior) {
    const { data } = await fetchClient.GET('/api/v1/media/uploads/{id}', { params: { path: { id: prior } } })
    if (data && data.status === 'open') session = data
  }
  if (!session) {
    const { data, error } = await fetchClient.POST('/api/v1/media/uploads', {
      body: {
        filename: f.name,
        size: f.size,
        sha256: whole,
        ...(opts.caption ? { caption: opts.caption } : {}),
      },
    })
    if (!data) throw new UploadError(message(error, "The upload couldn't start."))
    session = data
    remember(f, data.id)
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
  const { data, error } = await fetchClient.POST('/api/v1/media/uploads/{id}/complete', {
    params: { path: { id } },
    body: poster ? { poster } : {},
  })
  if (!data) throw new UploadError(message(error, "The upload couldn't finish. Try again to resume."))
  remember(f, null)
  return data.mediaId ?? ''
}
