// Everything the app touches outside its own code goes through these ports, so tests and spec
// generation inject fakes (test/fakes.ts) and production wires real adapters (src/adapters).
import type { Logger } from './lib/log.js'
import type { Ids } from './lib/ids.js'
import type { Store } from './store/types.js'
import type { Usage } from './domain/types.js'
import type { UpstreamIdentity } from './auth/upstream.js'
import type { LookCatalogEntry } from './lib/looks.js'

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
  /** Optional OAuth for the MCP; null (off) unless a provider and its credentials are set. */
  mcpOAuth: McpOAuthConfig | null
  /** Google OAuth for the YouTube destination (publish destinations §4); null when the env isn't set. */
  google: { clientId: string; clientSecret: string } | null
  /** How people sign in to the web app: Netlify Identity (the default) or Sign in with Netlify. */
  authProvider: 'identity' | 'netlify'
  /** The Netlify OAuth app (web sign-in and MCP OAuth share it); null unless both values are set. */
  netlifyOAuth: { clientId: string; clientSecret: string } | null
  /** Netlify teams (slugs or ids) a Netlify sign-in must belong to; empty for no team rule. */
  netlifyRequiredTeams: string[]
  /** A registered Openverse app (higher rate limits); null for anonymous access. */
  openverse: { clientId: string; clientSecret: string } | null
}

export interface McpOAuthConfig {
  provider: 'netlify'
  clientId: string
  clientSecret: string
  /** Email domains that may connect; null admits only people who already have an account. */
  allowedEmailDomains: string[] | null
  /** Hosts whose https client ids (Client ID Metadata Documents) are fetched. */
  cimdHosts: string[]
}

function readMcpOAuth(
  env: Record<string, string | undefined>,
  list: (v: string | undefined) => string[],
  domains: string[] | 'invite-only' | null,
): McpOAuthConfig | null {
  const clientId = env.NETLIFY_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.NETLIFY_OAUTH_CLIENT_SECRET?.trim()
  // With Sign in with Netlify on the web, MCP OAuth is on too unless MCP_OAUTH_PROVIDER says otherwise.
  const provider =
    env.MCP_OAUTH_PROVIDER?.trim().toLowerCase() ||
    (env.AUTH_PROVIDER?.trim().toLowerCase() === 'netlify' ? 'netlify' : '')
  if (provider !== 'netlify' || !clientId || !clientSecret) return null
  const own = list(env.MCP_OAUTH_ALLOWED_EMAIL_DOMAINS)
  const cimd = list(env.MCP_OAUTH_CIMD_HOSTS)
  return {
    provider: 'netlify',
    clientId,
    clientSecret,
    allowedEmailDomains: own.includes('invite-only')
      ? null
      : own.length > 0
        ? own
        : Array.isArray(domains)
          ? domains
          : null,
    cimdHosts: cimd.length > 0 ? cimd : ['claude.ai', 'claude.com'],
  }
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  const domains = list(env.ALLOWED_EMAIL_DOMAINS)
  const admission = domains.length === 0 ? null : domains.includes('invite-only') ? 'invite-only' : domains
  const num = (v: string | undefined, d: number) =>
    v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d
  return {
    allowedEmailDomains: admission,
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
    mcpOAuth: readMcpOAuth(env, list, admission),
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
    authProvider: env.AUTH_PROVIDER?.trim().toLowerCase() === 'netlify' ? 'netlify' : 'identity',
    netlifyOAuth:
      env.NETLIFY_OAUTH_CLIENT_ID?.trim() && env.NETLIFY_OAUTH_CLIENT_SECRET?.trim()
        ? {
            clientId: env.NETLIFY_OAUTH_CLIENT_ID.trim(),
            clientSecret: env.NETLIFY_OAUTH_CLIENT_SECRET.trim(),
          }
        : null,
    netlifyRequiredTeams: list(env.NETLIFY_REQUIRED_TEAM),
    openverse:
      env.OPENVERSE_CLIENT_ID?.trim() && env.OPENVERSE_CLIENT_SECRET?.trim()
        ? { clientId: env.OPENVERSE_CLIENT_ID.trim(), clientSecret: env.OPENVERSE_CLIENT_SECRET.trim() }
        : null,
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

export type BlobStoreName =
  'uploads' | 'videos' | 'sources' | 'internal' | 'checkpoints' | 'bundles' | 'media'

export interface BlobsPort {
  get(store: BlobStoreName, key: string): Promise<Uint8Array | null>
  set(
    store: BlobStoreName,
    key: string,
    data: Uint8Array | string,
    metadata?: Record<string, string>,
  ): Promise<void>
  delete(store: BlobStoreName, key: string): Promise<void>
  list(store: BlobStoreName, prefix: string): Promise<string[]>
  /** Streams a blob, optionally a byte range [start, end] inclusive; null when it's missing. */
  stream(
    store: BlobStoreName,
    key: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array> | null>
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
  reconcile(
    req: StartRequest,
    window: { sentAt: number; failedAt: number },
  ): Promise<
    | { kind: 'matched'; handle: string; runnerId: string; sessionId: string }
    | { kind: 'none' }
    | { kind: 'ambiguous' }
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
  /** Asks the platform to assemble one finished upload session (media-assemble-background). */
  dispatchMediaAssembly(uploadId: string): Promise<void>
  /** Asks the platform to run one Openverse search or import job (openverse-background). */
  dispatchOpenverseJob(jobId: string): Promise<void>
  /** Asks the platform to run publish-background for one destination publication (publish destinations §2.4). */
  dispatchPublish(publicationId: string): Promise<void>
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
  postJson(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number }>
  /**
   * Publish destinations (§3.1): the same protections as postJson (https only, every resolved address public, pinned,
   * no redirects, no credentials in the URL), but returns the status, a few headers and the body up to maxBodyBytes.
   */
  postJsonForResponse(
    url: string,
    body: string,
    headers: Record<string, string>,
    opts: { timeoutMs: number; maxBodyBytes: number },
  ): Promise<HttpResponse>
}

export interface HttpResponse {
  status: number
  headers: { contentType: string | null; retryAfter: string | null }
  body: string
  truncated: boolean
}

/**
 * Outbound fetch for third-party APIs and downloads (Openverse). Production refuses hosts that resolve to private
 * addresses; callers follow redirects themselves (redirect: 'manual') so they can check every hop.
 */
export type FetchPort = (url: string, init?: RequestInit) => Promise<Response>

/**
 * What the MCP OAuth server and Sign in with Netlify need from outside: the upstream sign-in and client metadata
 * documents.
 */
export interface OAuthPort {
  upstream: UpstreamIdentity
  /** A bounded GET of a Client ID Metadata Document; the caller has checked the host. Null on any failure. */
  fetchClientMetadata(url: string): Promise<unknown>
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
  /** Openverse search, item lookups and file downloads. */
  fetch: FetchPort
  gateway: GatewayPort
  /** Null unless config.mcpOAuth is set or the web app signs in with Netlify. */
  oauth: OAuthPort | null
  clock: Clock
  ids: Ids
  log: Logger
  /** The looks this deploy carries (plan 2026-11-04-looks §4.8). */
  looks: LooksPort
}

/** The deploy's look catalog and its build-time archives (looks-build/<id>.tar.gz, read in task 2.2b). */
export interface LooksPort {
  catalog(): LookCatalogEntry[]
  archive(id: string): Promise<Uint8Array>
}

/** AI Gateway (plan v2 §4): a fast TypeSafe `jev` router and Anthropic Messages for questions and briefs. */
export interface GatewayUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
export interface RouteAnswers {
  needs_questions: 'yes' | 'no'
  template: 'launch' | 'tutorial' | 'social' | 'changelog' | 'sales' | 'other'
  complexity: 'simple' | 'standard' | 'complex'
  aspect: 'landscape' | 'vertical' | 'square' | 'portrait' | 'unspecified'
}
export interface GatewayPort {
  /** True when the Gateway env vars are present (credit-based plans; Enterprise only when enabled). */
  available(): boolean
  route(
    input: { request: string; history: string[] },
    opts: { signal: AbortSignal },
  ): Promise<{
    answers: RouteAnswers
    model: string
    usage: GatewayUsage
  }>
  messages(
    req: {
      model: string
      system: string
      user: string
      maxTokens: number
      images?: { mime: string; base64: string }[]
    },
    opts: { signal: AbortSignal },
  ): Promise<{ text: string; model: string; usage: GatewayUsage }>
}
