export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'conflict'
  | 'take_deleted'
  | 'gone'
  | 'rate_limited'
  | 'upstream_error'
  | 'setup_required'
  | 'planning_unavailable'
  | 'internal'

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_ready: 409,
  conflict: 409,
  take_deleted: 409,
  gone: 410,
  rate_limited: 429,
  upstream_error: 502,
  setup_required: 503,
  planning_unavailable: 503,
  internal: 500,
}

export class ApiError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.status = STATUS[code]
  }
}

export const errorBody = (code: ErrorCode, message: string, details?: unknown) => ({
  error: details === undefined ? { code, message } : { code, message, details },
})
