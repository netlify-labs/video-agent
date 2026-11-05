export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  /** The version can't be changed this way (redo a scene on a version without the editing contract, or its engine). */
  | 'not_editable'
  | 'conflict'
  | 'take_deleted'
  | 'trace_frozen'
  | 'narration_disabled'
  | 'remix_disabled'
  | 'engine_mismatch'
  | 'unknown_look'
  | 'look_disabled'
  | 'look_not_allowed'
  | 'engine_not_supported_by_look'
  | 'engine_disabled'
  | 'narration_locked'
  | 'gone'
  | 'quota_exceeded'
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
  not_editable: 409,
  conflict: 409,
  take_deleted: 409,
  trace_frozen: 409,
  narration_disabled: 409,
  remix_disabled: 409,
  engine_mismatch: 409,
  unknown_look: 400,
  look_disabled: 409,
  /** 400 where a look is never accepted (render-unchanged, fit, a scoped revision); 409 for a restyle of a version with
   * recorded narration, passed as the status override. */
  look_not_allowed: 400,
  engine_not_supported_by_look: 400,
  engine_disabled: 409,
  narration_locked: 409,
  gone: 410,
  quota_exceeded: 413,
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
    /** A code's status is fixed except where one code means two things (look_not_allowed: 400, or 409). */
    opts: { status?: number } = {},
  ) {
    super(message)
    this.status = opts.status ?? STATUS[code]
  }
}

export const errorBody = (code: ErrorCode, message: string, details?: unknown) => ({
  error: details === undefined ? { code, message } : { code, message, details },
})
