// Hand-written video helpers (cli-and-sdk plan §4.1 videos row, §4.2 Waiting): wait for a version to finish,
// page through a list, and turn what a person pastes (an id, a web URL, a share URL) into a video id.
import { VideoAgentError } from '../errors.js'
import type { components } from '../generated/schema.js'
import type { Exchange } from '../http.js'
import type { CallOptions } from '../transport.js'

type Video = components['schemas']['Video']
type Progress = components['schemas']['Progress']

export interface WaitProgress {
  version: number
  status: string
  stage: string | null
  step: string | null
}

export interface WaitOptions {
  /** The version to wait for. Default: the latest version at the first poll. */
  version?: number
  /** Give up after this long (code wait_timeout). No default: a busy queue can take longer than any fixed limit. */
  timeoutMs?: number
  /** Poll interval. Default: 3 s for the first minute, then 8 s. */
  intervalMs?: number
  /** Called whenever the version, status, stage or step changes. */
  onProgress?: (p: WaitProgress) => void
  signal?: AbortSignal
}

const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'timed_out'])
const LIVE = new Set(['running', 'finishing'])

export interface VideoHelperDeps {
  send: (x: Exchange) => Promise<Response>
  progress: (id: string) => Promise<Progress>
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

/** Polls the video with If-None-Match (an unchanged video is a bodyless 304) until the version is ready. */
export async function waitForVideo(d: VideoHelperDeps, id: string, o: WaitOptions = {}): Promise<Video> {
  const started = Date.now()
  const deadline = o.timeoutMs === undefined ? Infinity : started + o.timeoutMs
  let etag: string | null = null
  let video: Video | null = null
  let n = o.version
  let last = ''
  for (;;) {
    o.signal?.throwIfAborted()
    const res = await d.send({
      method: 'GET',
      url: `/api/v1/videos/${encodeURIComponent(id)}`,
      headers: etag ? { 'if-none-match': etag } : {},
      signal: o.signal,
    })
    if (res.status === 304 && video) await res.body?.cancel()
    else {
      video = (await res.json()) as Video
      etag = res.headers.get('etag')
    }
    n ??= video.latestVersion
    const v = video.versions.find((x) => x.n === n)
    if (!v)
      throw new VideoAgentError({
        status: 404,
        code: 'not_found',
        message: `Video ${id} has no version ${n}.`,
      })
    let stage: string | null = v.stage
    let step: string | null = v.latestStep
    // The video's ETag moves with status, not with the agent's live step, so a running version reads /progress too.
    if (LIVE.has(v.status)) {
      const p = await d.progress(id)
      if (p.versionN === n) {
        stage = p.stage
        step = p.step
      }
    }
    const now = JSON.stringify([n, v.status, stage, step])
    if (now !== last) {
      last = now
      o.onProgress?.({ version: n, status: v.status, stage, step })
    }
    if (v.status === 'ready') return video
    if (TERMINAL_FAILURES.has(v.status))
      throw new VideoAgentError({
        status: 0,
        code: 'video_failed',
        message: `Version ${n} of ${id} ${v.status === 'timed_out' ? 'timed out' : v.status}${v.error ? `: ${v.error.message}` : '.'}`,
        details: { videoId: id, version: n, status: v.status, error: v.error },
      })
    const interval = o.intervalMs ?? (Date.now() - started < 60_000 ? 3_000 : 8_000)
    if (Date.now() >= deadline)
      throw new VideoAgentError({
        status: 0,
        code: 'wait_timeout',
        message: `Version ${n} of ${id} is still ${v.status} after ${Math.round((Date.now() - started) / 1000)} s.`,
        details: { videoId: id, version: n, status: v.status },
      })
    await sleep(Math.min(interval, deadline - Date.now()), o.signal)
  }
}

/** An operation that pages with { items, nextCursor } and takes a cursor. Lists without a cursor don't fit. */
export type Pageable<I, T> = (
  input: I & { cursor?: string },
  opts?: { signal?: AbortSignal },
) => Promise<{ items: T[]; nextCursor: string | null }>

/** Every item of a paged list, fetching the next page only when the previous one is used up. */
export async function* listAll<I extends { cursor?: string }, T>(
  list: Pageable<I, T>,
  input: Omit<I, 'cursor'> = {} as Omit<I, 'cursor'>,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<T> {
  let cursor: string | null = null
  do {
    const page: { items: T[]; nextCursor: string | null } = await list(
      { ...input, ...(cursor ? { cursor } : {}) } as I,
      opts,
    )
    yield* page.items
    cursor = page.nextCursor
  } while (cursor)
}

export interface ResolvedVideo {
  id: string
  versionN?: number
}

/**
 * A video id (vid_…), a web URL (<site>/videos/{id}, or …/edit/{n} for a version) or a share URL (<host>/v/{slug},
 * read through its public /v/{slug}.json, never with the key) → { id, versionN? }.
 */
export async function resolveVideo(fetchImpl: typeof fetch, ref: string): Promise<ResolvedVideo> {
  const s = ref.trim()
  if (/^vid_[0-9a-z]+$/i.test(s)) return { id: s }
  let url: URL | null = null
  try {
    url = new URL(s)
  } catch {
    // not a URL
  }
  if (url && /^https?:$/.test(url.protocol)) {
    const web = /^\/videos\/(vid_[0-9a-z]+)(?:\/edit\/(\d+))?\/?$/i.exec(url.pathname)
    if (web?.[1]) return { id: web[1], ...(web[2] ? { versionN: Number(web[2]) } : {}) }
    const share = /^\/v\/([a-z2-9]{6,32})(?:\.json)?\/?$/.exec(url.pathname)
    if (share?.[1]) {
      const res = await fetchImpl(`${url.origin}/v/${share[1]}.json`, {
        headers: { accept: 'application/json' },
      })
      if (res.status === 404)
        throw new VideoAgentError({ status: 404, code: 'not_found', message: `${s} isn't published.` })
      if (!res.ok)
        throw new VideoAgentError({
          status: res.status,
          code: `http_${res.status}`,
          message: `Couldn't read ${s}.`,
        })
      const body = (await res.json()) as { video_agent?: { videoId?: unknown; versionN?: unknown } }
      const id = body.video_agent?.videoId
      if (typeof id === 'string')
        return {
          id,
          ...(typeof body.video_agent?.versionN === 'number' ? { versionN: body.video_agent.versionN } : {}),
        }
    }
  }
  throw new VideoAgentError({
    status: 0,
    code: 'invalid_ref',
    message: `${s} isn't a video id (vid_…), a video's web address or a share link.`,
  })
}

type ReviseInput = components['schemas']['Revise']

export interface RedoScenesInput extends Omit<ReviseInput, 'scope' | 'fromVersion'> {
  /** Scene ids from the version's beats (`versions.beats`, or the version's `beats`). */
  beats: string[]
  /** The version the scenes are from. Default: the latest ready version. */
  fromVersion?: number
}

export interface RedoScenesDeps {
  get: (id: string) => Promise<Video>
  revise: (id: string, input: ReviseInput, opts?: CallOptions) => Promise<Video>
}

/**
 * Redo some scenes of a version (regenerate-beat plan §4.13): a revision with a scope. Fills fromVersion from the
 * latest ready version when it's left out. The generated revise checks the server lists scoped_revision (else
 * unsupported_by_server) and sends an Idempotency-Key.
 */
export async function redoScenes(
  d: RedoScenesDeps,
  id: string,
  input: RedoScenesInput,
  opts?: CallOptions,
): Promise<Video> {
  const { beats, fromVersion, ...rest } = input
  let from = fromVersion
  if (from === undefined) {
    const video = await d.get(id)
    from = video.versions.find((v) => v.status === 'ready')?.n
    if (from === undefined)
      throw new VideoAgentError({
        status: 0,
        code: 'not_ready',
        message: `Video ${id} has no ready version to redo scenes of.`,
        details: { videoId: id },
      })
  }
  return d.revise(id, { ...rest, fromVersion: from, scope: { beats } }, opts)
}
