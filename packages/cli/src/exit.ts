// Exit codes (cli-and-sdk plan §6.2). Mapped by HTTP status first, then specific codes override, so a new server
// code needs no CLI change unless it should exit differently from its status.
import { isVideoAgentError } from '../../sdk/src/index.js'

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  videoFailed: 5,
  waitTimeout: 6,
  conflict: 7,
  rateLimited: 8,
  unsupported: 9,
} as const

/** A mistake in how the command was called: exit 2, with an optional "did you mean". */
export class UsageError extends Error {
  readonly code = 'usage'
}

/** A failure the CLI itself decides (not the server's): a code and an exit. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number = EXIT.error,
  ) {
    super(message)
  }
}

const BY_CODE: Record<string, number> = {
  usage: EXIT.usage,
  invalid_ref: EXIT.usage,
  invalid_options: EXIT.usage,
  video_failed: EXIT.videoFailed,
  wait_timeout: EXIT.waitTimeout,
  unsupported_by_server: EXIT.unsupported,
}

const byStatus = (status: number): number => {
  if (status === 400) return EXIT.usage
  if (status === 401) return EXIT.auth
  if (status === 403 || status === 404) return EXIT.notFound
  if (status === 409) return EXIT.conflict
  if (status === 429) return EXIT.rateLimited
  return EXIT.error
}

export function exitCodeFor(e: unknown): number {
  if (e instanceof UsageError) return EXIT.usage
  if (e instanceof CliError) return e.exit
  if (isVideoAgentError(e)) return BY_CODE[e.code] ?? byStatus(e.status)
  return EXIT.error
}

/** The `{ error }` body --json prints, and the code a human message leads with. */
export function errorJson(e: unknown): { error: { code: string; message: string; requestId?: string } } {
  if (isVideoAgentError(e))
    return { error: { code: e.code, message: e.message, ...(e.requestId ? { requestId: e.requestId } : {}) } }
  if (e instanceof UsageError || e instanceof CliError) return { error: { code: e.code, message: e.message } }
  return { error: { code: 'error', message: e instanceof Error ? e.message : String(e) } }
}
