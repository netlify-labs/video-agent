// The action's one logger (github-action plan §11 Logging): `video-agent: key=value …` lines with a stable prefix that
// integration tests assert on, or one JSON object per line with VIDEO_AGENT_LOG=json. It redacts the API key, bearer
// tokens, cookies and nva_ keys as a second line of defence after core.setSecret.
import type { Core } from './core.js'

export type Fields = Record<string, string | number | boolean | null | undefined>

export interface Log {
  /** One line: `video-agent: <key>=<value> …`. Undefined fields are left out. */
  line(fields: Fields): void
  decision(kind: string, fields?: Fields): void
  /** A Video Agent API call: method, path, status, ms (never the key or a body). */
  api(fields: { method: string; path: string; status: number; ms: number; attempt?: number }): void
  /** A GitHub API call with the rate limit left (x-ratelimit-remaining). */
  gh(fields: { method: string; route: string; status: number; ms: number; remaining?: number | null }): void
  warn(message: string, fields?: Fields): void
  /** Runs fn inside a collapsible log group. */
  group<T>(name: string, fn: () => Promise<T>): Promise<T>
  /** Treat this value as secret from now on. */
  addSecret(value: string): void
}

const PATTERNS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer|token|basic)?\s*[^\s,;"]+/gi, '$1$2 ***'],
  [/(cookie\s*[:=]\s*)[^\n"]+/gi, '$1***'],
  [/\bnva_[A-Za-z0-9_]+/g, 'nva_***'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '***'],
]

export function redact(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***')
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

const fmt = (v: string | number | boolean | null) =>
  typeof v === 'string' && (v === '' || /[\s"=]/.test(v)) ? JSON.stringify(v) : String(v)

export function createLog(core: Core, opts: { json?: boolean; secrets?: string[] } = {}): Log {
  const secrets = new Set(opts.secrets?.filter(Boolean) ?? [])
  const emit = (fields: Fields, warn = false) => {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<
      string,
      string | number | boolean | null
    >
    const text = opts.json
      ? JSON.stringify(clean)
      : `video-agent: ${Object.entries(clean)
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(' ')}`
    const safe = redact(text, secrets)
    if (warn) core.warning(safe)
    else core.info(safe)
  }
  const log: Log = {
    line: (fields) => emit(fields),
    decision: (kind, fields = {}) => emit({ decision: kind, ...fields }),
    api: (f) => emit({ api: f.method, path: f.path, status: f.status, ms: f.ms, attempt: f.attempt }),
    gh: (f) =>
      emit({ gh: f.method, route: f.route, status: f.status, ms: f.ms, remaining: f.remaining ?? undefined }),
    warn: (message, fields = {}) => emit({ warning: message, ...fields }, true),
    group: async (name, fn) => {
      core.startGroup(redact(name, secrets))
      try {
        return await fn()
      } finally {
        core.endGroup()
      }
    },
    addSecret: (value) => {
      if (!value) return
      secrets.add(value)
      core.setSecret(value)
    },
  }
  return log
}
