// Every failure the SDK reports is a VideoAgentError (cli-and-sdk plan §4.2 Errors). `code` is the server's
// ({ error: { code, message } }), or one of the SDK's own: unsupported_by_server, network, and the helpers' codes.

export class VideoAgentError extends Error {
  override readonly name = 'VideoAgentError'
  /** The HTTP status; 0 when no response decided it (a network failure, a feature the server lacks). */
  readonly status: number
  readonly code: string
  /** Seconds the server asked to wait (Retry-After), when it said. */
  readonly retryAfterSec: number | undefined
  /** Netlify's x-nf-request-id, so an admin can find the request in the function logs. */
  readonly requestId: string | undefined
  readonly details: unknown

  constructor(o: {
    status: number
    code: string
    message: string
    retryAfterSec?: number | undefined
    requestId?: string | undefined
    details?: unknown
    cause?: unknown
  }) {
    super(o.message, o.cause === undefined ? undefined : { cause: o.cause })
    this.status = o.status
    this.code = o.code
    this.retryAfterSec = o.retryAfterSec
    this.requestId = o.requestId
    this.details = o.details
  }
}

/** Whether `e` is a VideoAgentError, optionally with this code. */
export function isVideoAgentError(e: unknown, code?: string): e is VideoAgentError {
  return e instanceof VideoAgentError && (code === undefined || e.code === code)
}

/** The error a non-2xx response stands for, from the server's { error: { code, message } } body when it has one. */
export async function errorFromResponse(res: Response): Promise<VideoAgentError> {
  const text = await res.text().catch(() => '')
  let code = `http_${res.status}`
  let message = `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`
  let details: unknown
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
    details = body.error?.details
  } catch {
    // not JSON (a proxy's HTML page, an empty body): keep the status-based code
  }
  return new VideoAgentError({
    status: res.status,
    code,
    message,
    retryAfterSec: retryAfterOf(res),
    requestId: res.headers.get('x-nf-request-id') ?? undefined,
    details,
  })
}

export function retryAfterOf(res: Response): number | undefined {
  const v = res.headers.get('retry-after')
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec)) return Math.max(0, sec)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}
