// Structured JSON-line logging with redaction of secrets. debug() lines (requests, prompts, model calls, MCP tool
// calls) are written only when the logger is verbose: DEBUG_LEVEL=verbose (or debug) in the environment.

const SECRET_KEYS = /token|secret|password|authorization|cookie|handle|signature|sig|nf_jwt|apikey|api_key/i
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g
const KEY_PATTERN = /\bnva_[A-Za-z0-9_]+/g
const OAUTH_PATTERN = /\b(nvat|nvac|nvrt)_[A-Za-z0-9_-]+/g
const SIG_PARAM = /([?&](?:sig|exp|token|code|state)=)[^&\s"]+/g

export type LogFields = Record<string, unknown>

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (typeof value === 'string') {
    return value
      .replace(BEARER, '$1[redacted]')
      .replace(KEY_PATTERN, 'nva_[redacted]')
      .replace(OAUTH_PATTERN, '$1_[redacted]')
      .replace(SIG_PARAM, '$1[redacted]')
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

/** Long text (a prompt, a model's reply) cut to `max` characters for a debug line, with how long it really was. */
export function clip(text: string | null | undefined, max = 4000): string | null {
  if (text == null) return null
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`
}

/** Whether DEBUG_LEVEL asks for debug lines. */
export const verboseFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  /^(verbose|debug|trace)$/i.test(env.DEBUG_LEVEL?.trim() ?? '')

export interface Logger {
  /** Written only when `verbose`: detail for debugging (requests, prompts, model calls). */
  debug(event: string, fields?: LogFields): void
  readonly verbose: boolean
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export function createLogger(
  base: LogFields = {},
  sink: (line: string) => void = (l) => {
    console.log(l)
  },
  opts: { verbose?: boolean } = {},
): Logger {
  const verbose = opts.verbose ?? false
  const write = (level: string, event: string, fields: LogFields = {}) => {
    sink(JSON.stringify(redact({ ts: new Date().toISOString(), level, event, ...base, ...fields })))
  }
  return {
    verbose,
    debug: (e, f) => {
      if (verbose) write('debug', e, f)
    },
    info: (e, f) => {
      write('info', e, f)
    },
    warn: (e, f) => {
      write('warn', e, f)
    },
    error: (e, f) => {
      write('error', e, f)
    },
    child: (fields) => createLogger({ ...base, ...fields }, sink, { verbose }),
  }
}
