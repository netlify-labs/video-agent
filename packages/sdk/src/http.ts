// One HTTP exchange with retries: auth, User-Agent, no redirect following, jittered
// backoff on network errors, 429 (Retry-After, capped at 60 s) and 5xx, for GETs and requests with an
// Idempotency-Key only. The body is sent as the same bytes on every attempt, because the server replays an
// idempotent request only when the body's hash matches (app/server/domain/videos.ts).
import { errorFromResponse, retryAfterOf, VideoAgentError } from './errors.js'

export type Logger = (event: string, fields: Record<string, unknown>) => void

export interface HttpOptions {
  baseUrl: string
  apiKey: string | undefined
  userAgent: string
  fetch: typeof fetch
  retries: number
  logger: Logger | undefined
}

export interface Exchange {
  method: string
  /** The path and query, starting with /. */
  url: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array<ArrayBuffer> | undefined
  signal?: AbortSignal | undefined
  /** False for routes that need no key (the SDK still never sends one anywhere but its own deployment). */
  auth?: boolean
}

const MAX_RETRY_AFTER_SEC = 60
const BACKOFF_MS = 500

/** @internal Waits ms, or rejects with the signal's reason when it aborts (the helpers poll with it too). */
export const sleep = (ms: number, signal?: AbortSignal) =>
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

/** Sends one request, retrying what's safe to retry. Resolves with a 2xx or 3xx Response; throws otherwise. */
export async function send(o: HttpOptions, x: Exchange): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': o.userAgent,
    ...x.headers,
  }
  if (o.apiKey && x.auth !== false) headers.authorization = `Bearer ${o.apiKey}`
  const retryable = x.method === 'GET' || x.method === 'HEAD' || 'idempotency-key' in headers
  const path = x.url.split('?')[0] ?? x.url
  for (let attempt = 1; ; attempt++) {
    const started = Date.now()
    let res: Response
    try {
      res = await o.fetch(`${o.baseUrl}${x.url}`, {
        method: x.method,
        headers,
        ...(x.body !== undefined ? { body: x.body } : {}),
        redirect: 'manual',
        ...(x.signal ? { signal: x.signal } : {}),
      })
    } catch (e) {
      if (x.signal?.aborted) throw e
      o.logger?.('request', {
        method: x.method,
        path,
        status: 0,
        ms: Date.now() - started,
        attempt,
        error: 'network',
      })
      if (retryable && attempt <= o.retries) {
        await sleep(jitter(BACKOFF_MS * 2 ** (attempt - 1)), x.signal)
        continue
      }
      throw new VideoAgentError({
        status: 0,
        code: 'network',
        message: `Couldn't reach ${o.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      })
    }
    const requestId = res.headers.get('x-nf-request-id') ?? undefined
    o.logger?.('request', {
      method: x.method,
      path,
      status: res.status,
      ms: Date.now() - started,
      attempt,
      requestId,
    })
    if (res.status < 400 || res.type === 'opaqueredirect') return res
    if (retryable && attempt <= o.retries && (res.status === 429 || res.status >= 500)) {
      const after = res.status === 429 ? retryAfterOf(res) : undefined
      await res.body?.cancel()
      await sleep(
        after !== undefined
          ? Math.min(after, MAX_RETRY_AFTER_SEC) * 1000
          : jitter(BACKOFF_MS * 2 ** (attempt - 1)),
        x.signal,
      )
      continue
    }
    throw await errorFromResponse(res)
  }
}

/** Full jitter between half and all of the backoff. */
const jitter = (ms: number) => ms / 2 + Math.random() * (ms / 2)
