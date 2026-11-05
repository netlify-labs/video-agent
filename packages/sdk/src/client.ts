// The VideoAgent client (cli-and-sdk plan §4.1, §4.2): the generated resource methods, `raw` for every route, and the
// cached server config that feature checks read.
import createClient, { type Client } from 'openapi-fetch'
import { VideoAgentError } from './errors.js'
import type { paths } from './generated/schema.js'
import { resources, type Resources } from './generated/resources.js'
import { send, type HttpOptions, type Logger } from './http.js'
import { prepare, type Call, type CallOptions, type Transport } from './transport.js'
import { VERSION } from './version.js'

export interface VideoAgentOptions {
  /** The deployment, e.g. https://acme-video.netlify.app. Default: VIDEO_AGENT_URL. */
  url?: string
  /** An nva_ API key. Default: VIDEO_AGENT_KEY. Without one, only the public routes work. */
  apiKey?: string
  /** Added to the User-Agent, so the deployment's logs show who calls. */
  userAgent?: string
  /** Default: globalThis.fetch. */
  fetch?: typeof fetch
  /** Retries for GETs and idempotent POSTs. Default 3. */
  retries?: number
  /** Receives one `request` event per attempt: method, path, status, ms, attempt, requestId. Never headers or bodies. */
  logger?: Logger
}

export interface ServerConfig {
  version: { commit: string | null; promptTemplate: number; release: string | null } | null
  features: string[]
}

/** Operations that always carry an Idempotency-Key, so a retried create never makes two videos. */
const IDEMPOTENT = new Set(['createVideo', 'reviseVideo', 'remixVideo'])

const env = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]

// Resources are copied onto the instance in the constructor, so the class carries their types too.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface VideoAgent extends Resources {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class VideoAgent {
  /** Every route, typed by the spec, with auth, retries and errors: `va.raw.GET('/api/v1/stats')`. */
  readonly raw: Client<paths>
  readonly url: string
  readonly #http: HttpOptions
  #config: Promise<ServerConfig> | null = null

  constructor(o: VideoAgentOptions = {}) {
    const url = (o.url ?? env('VIDEO_AGENT_URL') ?? '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(url))
      throw new VideoAgentError({
        status: 0,
        code: 'invalid_options',
        message: 'Set url (or VIDEO_AGENT_URL) to your deployment, e.g. https://acme-video.netlify.app.',
      })
    const f = o.fetch ?? globalThis.fetch.bind(globalThis)
    this.url = url
    this.#http = {
      baseUrl: url,
      apiKey: o.apiKey ?? env('VIDEO_AGENT_KEY'),
      userAgent: `netlify-video-agent-sdk/${VERSION}${o.userAgent ? ` (+${o.userAgent})` : ''}`,
      fetch: f,
      retries: o.retries ?? 3,
      logger: o.logger,
    }
    const transport: Transport = { call: (call, opts) => this.#call(call, opts) }
    Object.assign(this, resources(transport))
    this.raw = createClient<paths>({
      baseUrl: url,
      fetch: async (req: Request) => {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => {
          if (k !== 'authorization') headers[k] = v
        })
        const body = req.body ? await req.arrayBuffer() : undefined
        return send(this.#http, {
          method: req.method,
          url: req.url.slice(url.length),
          headers,
          body,
          signal: req.signal,
        })
      },
    })
  }

  /** The server's version and features, fetched once and cached. A server older than both reads as no features. */
  serverConfig(): Promise<ServerConfig> {
    this.#config ??= send(this.#http, { method: 'GET', url: '/api/v1/config' })
      .then(async (res) => {
        const body = (await res.json()) as { version?: ServerConfig['version']; features?: unknown }
        return {
          version: body.version ?? null,
          features: Array.isArray(body.features) ? body.features.filter((f) => typeof f === 'string') : [],
        }
      })
      .catch((e: unknown) => {
        this.#config = null
        throw e
      })
    return this.#config
  }

  /** Throws unsupported_by_server unless the server lists every one of these features. */
  async requireFeatures(features: readonly string[]): Promise<void> {
    if (!features.length) return
    const config = await this.serverConfig()
    const missing = features.find((f) => !config.features.includes(f))
    if (missing)
      throw new VideoAgentError({
        status: 0,
        code: 'unsupported_by_server',
        message: `This server (${config.version?.commit ?? 'unknown'}) doesn't support ${missing}. Update the deployment.`,
        details: { feature: missing },
      })
  }

  async #call<T>(call: Call, opts: CallOptions = {}): Promise<T> {
    await this.requireFeatures(call.features)
    const { path, query, body } = prepare(call)
    const headers: Record<string, string> = { ...opts.headers }
    const key = opts.idempotencyKey ?? (IDEMPOTENT.has(call.operationId) ? crypto.randomUUID() : undefined)
    if (key) headers['idempotency-key'] = key
    // Serialized once: every retry sends exactly these bytes.
    const payload = body ? JSON.stringify(body) : undefined
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const qs = query.toString()
    const res = await send(this.#http, {
      method: call.method,
      url: `${path}${qs ? `?${qs}` : ''}`,
      headers,
      body: payload,
      signal: opts.signal,
    })
    if (res.status === 204 || res.status === 304) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}
