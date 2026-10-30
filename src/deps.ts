// Everything the app touches outside its own code goes through these ports, so tests and spec
// generation inject fakes (test/fakes.ts) and production wires real adapters (src/adapters).
import type { Logger } from './lib/log.js'
import type { Ids } from './lib/ids.js'
import type { Store } from './store/types.js'
import type { Usage } from './domain/types.js'

export interface Config {
  allowedEmailDomains: string[] | 'invite-only' | null
  adminEmails: string[]
  agent: string
  agentModel: string | null
  agentEffort: string | null
  maxActiveRuns: number
  authoringDeadlineMin: number
  queueTimeoutMin: number
  finalizeDeadlineMin: number
  siteId: string | null
  siteUrl: string
  allowedOrigins: string[]
  runnerTokenPresent: boolean
  uploadMode: 'blobs' | 'signed'
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  const domains = list(env.ALLOWED_EMAIL_DOMAINS)
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    allowedEmailDomains: domains.length === 0 ? null : domains.includes('invite-only') ? 'invite-only' : domains,
    adminEmails: list(env.ADMIN_EMAILS),
    agent: env.AGENT ?? 'claude',
    agentModel: env.AGENT_MODEL ?? null,
    agentEffort: env.AGENT_EFFORT ?? null,
    maxActiveRuns: num(env.MAX_ACTIVE_RUNS, 3),
    authoringDeadlineMin: num(env.AUTHORING_DEADLINE_MIN, 22),
    queueTimeoutMin: num(env.QUEUE_TIMEOUT_MIN, 60),
    finalizeDeadlineMin: num(env.FINALIZE_DEADLINE_MIN, 10),
    siteId: env.SITE_ID ?? null,
    siteUrl: (env.URL ?? 'http://localhost:8888').replace(/\/$/, ''),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    runnerTokenPresent: Boolean(env.RUNNER_API_TOKEN),
    uploadMode: env.UPLOAD_MODE === 'signed' ? 'signed' : 'blobs',
  }
}

/** Identity as seen from a request: the cookie session, live lookups and site settings. */
export interface IdentityUser {
  id: string
  email: string
  name: string | null
  confirmed: boolean
  invited: boolean
}

export interface IdentitySettings {
  autoconfirm: boolean
  disableSignup: boolean
}

export interface IdentityPort {
  /** The user behind the request's nf_jwt cookie, or null. */
  sessionUser(req: Request): Promise<IdentityUser | null>
  /** Live lookup; throws on outage, returns null when the user doesn't exist. */
  liveUser(id: string): Promise<IdentityUser | null>
  settings(): Promise<IdentitySettings | null>
}

export type BlobStoreName = 'uploads' | 'videos' | 'sources' | 'internal'

export interface BlobsPort {
  get(store: BlobStoreName, key: string): Promise<Uint8Array | null>
  set(store: BlobStoreName, key: string, data: Uint8Array | string, metadata?: Record<string, string>): Promise<void>
  delete(store: BlobStoreName, key: string): Promise<void>
  list(store: BlobStoreName, prefix: string): Promise<string[]>
}

export interface StartRequest {
  requestId: string
  prompt: string
  deployId: string | null
  agent: string
  model: string | null
  effort: string | null
  deadlineMs: number
}

export type RunnerSnapshot =
  | { kind: 'running'; state: string; latestStep: string | null; usage: Usage | null }
  | {
      kind: 'terminal'
      status: 'succeeded' | 'failed' | 'cancelled' | 'timedOut'
      resultText: string | null
      usage: Usage | null
      failure: { category: string; code: string; message: string } | null
    }

export class RunnerError extends Error {
  constructor(
    readonly kind: 'ambiguous' | 'capacity' | 'credits' | 'fatal',
    message: string,
    readonly window?: { sentAt: number; failedAt: number },
  ) {
    super(message)
  }
}

export interface RunnerPort {
  start(req: StartRequest): Promise<{ handle: string; runnerId: string; sessionId: string }>
  /** After an ambiguous start: find the same logical create by requestId. */
  reconcile(req: StartRequest, window: { sentAt: number; failedAt: number }): Promise<
    { kind: 'matched'; handle: string; runnerId: string; sessionId: string } | { kind: 'none' } | { kind: 'ambiguous' }
  >
  snapshot(handle: string): Promise<RunnerSnapshot>
  stop(handle: string): Promise<void>
  runUrl(runnerId: string, sessionId: string | null): string
}

export interface PlatformPort {
  /** The current production deploy id, which every attempt starts from. */
  productionDeployId(): Promise<string | null>
  /** Asks the platform to run finalize-background for an attempt. */
  dispatchFinalize(attemptId: string): Promise<void>
  /** Checks for /setup: plan, agent runners, token, identity. */
  setupFacts(): Promise<SetupFacts>
}

export interface SetupFacts {
  tokenValid: boolean | null
  tokenError: string | null
  agentRunnersAvailable: boolean | null
  identityEnabled: boolean
}

export interface HttpPort {
  /** Webhook delivery; resolves DNS, refuses private addresses and redirects. */
  postJson(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number }>
}

export interface Clock {
  now(): Date
}

export interface Deps {
  config: Config
  store: Store
  blobs: BlobsPort
  identity: IdentityPort
  runner: RunnerPort
  platform: PlatformPort
  http: HttpPort
  clock: Clock
  ids: Ids
  log: Logger
}
