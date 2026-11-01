// Structured JSON-line logging with redaction of secrets.

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

export interface Logger {
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
): Logger {
  const write = (level: string, event: string, fields: LogFields = {}) => {
    sink(JSON.stringify(redact({ ts: new Date().toISOString(), level, event, ...base, ...fields })))
  }
  return {
    info: (e, f) => {
      write('info', e, f)
    },
    warn: (e, f) => {
      write('warn', e, f)
    },
    error: (e, f) => {
      write('error', e, f)
    },
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  }
}

export const silentLogger: Logger = createLogger({}, () => undefined)
