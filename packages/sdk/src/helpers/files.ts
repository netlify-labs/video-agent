// files.url and files.download (cli-and-sdk plan §4.1 files row, §4.2 Redirects). The poster and GIF come signed in
// the version DTO, so they need no request. The video, captions, narration audio and transcript go through the file
// route, which 302s to a signed storage URL valid for 5 to 10 minutes: the SDK reads Location without following it
// with the key, then fetches the storage URL at once WITHOUT Authorization.
import { VideoAgentError } from '../errors.js'
import type { components } from '../generated/schema.js'
import type { Exchange } from '../http.js'

type Video = components['schemas']['Video']

export type VersionFile = 'video' | 'poster' | 'gif' | 'captions' | 'narration-audio' | 'transcript'

export interface FileOptions {
  file: VersionFile
  /** Default: the video's latest version. */
  version?: number
}

export interface FileHelperDeps {
  baseUrl: string
  send: (x: Exchange) => Promise<Response>
  /** The plain fetch, never given the key. */
  fetch: typeof fetch
  getVideo: (id: string) => Promise<Video>
}

const SIGNED_IN_DTO = new Set<VersionFile>(['poster', 'gif'])

/** A URL you can fetch without the key: from the DTO when it's signed there, else from the file route's redirect. */
export async function fileUrl(d: FileHelperDeps, video: Video | string, o: FileOptions): Promise<string> {
  if (typeof video !== 'string' && SIGNED_IN_DTO.has(o.file)) {
    const n = o.version ?? video.latestVersion
    const files = video.versions.find((v) => v.n === n)?.files
    const signed = o.file === 'poster' ? files?.poster : files?.gif
    if (signed) return new URL(signed, d.baseUrl).toString()
  }
  const id = typeof video === 'string' ? video : video.id
  const n =
    o.version ?? (typeof video === 'string' ? (await d.getVideo(id)).latestVersion : video.latestVersion)
  const res = await d.send({
    method: 'GET',
    url: `/api/v1/videos/${encodeURIComponent(id)}/versions/${n}/${o.file}`,
  })
  const location = res.headers.get('location')
  await res.body?.cancel()
  if (res.status < 300 || res.status >= 400 || !location)
    throw new VideoAgentError({
      status: res.status,
      code: 'no_redirect',
      message:
        res.type === 'opaqueredirect'
          ? "This runtime hides redirect targets (a browser): use the version's signed links instead."
          : `The file route answered ${res.status} without a redirect.`,
    })
  return new URL(location, d.baseUrl).toString()
}

interface FsPromises {
  open(
    path: string,
    flags: string,
  ): Promise<{ write(b: Uint8Array): Promise<unknown>; close(): Promise<void> }>
  rename(from: string, to: string): Promise<void>
  rm(path: string, o: { force: boolean }): Promise<void>
}

/**
 * Downloads a version's file. With `to` (Node and similar), streams it to that path through a temporary file and a
 * rename, so a failed download leaves nothing behind, and resolves { path, bytes }. Without `to`, resolves the Response.
 */
export async function downloadFile(
  d: FileHelperDeps,
  video: Video | string,
  o: FileOptions & { to: string; signal?: AbortSignal },
): Promise<{ path: string; bytes: number }>
export async function downloadFile(
  d: FileHelperDeps,
  video: Video | string,
  o: FileOptions & { to?: undefined; signal?: AbortSignal },
): Promise<Response>
export async function downloadFile(
  d: FileHelperDeps,
  video: Video | string,
  o: FileOptions & { to?: string | undefined; signal?: AbortSignal },
): Promise<Response | { path: string; bytes: number }> {
  const url = await fileUrl(d, video, o)
  // Straight away (the link is short-lived), and never with the key: this is the storage host.
  const res = await d.fetch(url, o.signal ? { signal: o.signal } : {})
  if (!res.ok)
    throw new VideoAgentError({
      status: res.status,
      code: 'download_failed',
      message: `Downloading ${o.file} failed with ${res.status}.`,
    })
  if (o.to === undefined) return res
  // A runtime-neutral main entry: node:fs loads only when a path is asked for.
  const spec = 'node:fs/promises'
  const fs = (await import(spec)) as FsPromises
  const tmp = `${o.to}.part-${crypto.randomUUID().slice(0, 8)}`
  let bytes = 0
  try {
    const fh = await fs.open(tmp, 'w')
    try {
      const reader = res.body?.getReader()
      for (;;) {
        const chunk = await reader?.read()
        if (!chunk || chunk.done) break
        await fh.write(chunk.value)
        bytes += chunk.value.byteLength
      }
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, o.to)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
  return { path: o.to, bytes }
}
