// The VideoAgent client (cli-and-sdk plan §4.1, §4.2): the generated resource methods, `raw` for every route, and the
// cached server config that feature checks read.
import createClient, { type Client } from 'openapi-fetch'
import { VideoAgentError } from './errors.js'
import type { components, paths } from './generated/schema.js'
import { resources, type Resources } from './generated/resources.js'
import { send, type Exchange, type HttpOptions, type Logger } from './http.js'
import {
  listAll,
  redoScenes,
  resolveVideo,
  waitForVideo,
  type Pageable,
  type RedoScenesInput,
  type ResolvedVideo,
  type WaitOptions,
} from './helpers/videos.js'
import { downloadFile, fileUrl, type FileOptions } from './helpers/files.js'
import { importMusicAndWait, uploadMedia, type UploadOptions } from './helpers/media.js'
import { prepare, type Call, type CallOptions, type Input, type Ok, type Transport } from './transport.js'
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

type Video = Ok<'/api/v1/videos/{id}', 'get'>

/** The hand-written helpers on va.videos, beside the generated methods. */
export interface VideoHelpers {
  /** Waits until the version is ready (no timeout unless given); throws video_failed on failed, cancelled, timed_out. */
  wait(id: string, o?: WaitOptions): Promise<Video>
  /** Every video matching the list's filters, page by page. */
  listAll(
    input?: Omit<Input<'/api/v1/videos', 'get'>, 'cursor'>,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<Video>
  /** A video id, web URL or share URL → { id, versionN? }. */
  resolve(ref: string): Promise<ResolvedVideo>
  /** Redoes some scenes: a revision with scope.beats, from the latest ready version unless fromVersion is given. */
  redoScenes(id: string, input: RedoScenesInput, opts?: CallOptions): Promise<Video>
}

/** va.files: links and downloads for a version's files. */
export interface FileHelpers {
  /** A URL to fetch without the key (signed in the DTO, or the file route's short-lived redirect). */
  url(video: Video | string, o: FileOptions): Promise<string>
  /** Streams the file to `to` (atomically) and resolves { path, bytes }; without `to`, resolves the Response. */
  download(
    video: Video | string,
    o: FileOptions & { to: string; signal?: AbortSignal },
  ): Promise<{ path: string; bytes: number }>
  download(
    video: Video | string,
    o: FileOptions & { to?: undefined; signal?: AbortSignal },
  ): Promise<Response>
}

type Media = Ok<'/api/v1/media/{id}', 'get'>

/** The hand-written helpers on va.media, va.music and va.config. */
export interface MediaHelpers {
  /** Uploads a path (Node), Blob/File or bytes of any size, resuming parts after a failure, and waits for ready. */
  upload(file: string | Blob | Uint8Array, o?: UploadOptions): Promise<Media>
  /**
   * Uploads a screen recording (H.264 MP4, fast start, a keyframe at least every 2 s; the server refuses anything
   * else with the reason), waits for ready, then stores its pointer trace when given. Needs the screen_recording
   * feature.
   */
  uploadRecording(
    file: string | Blob | Uint8Array,
    o?: Omit<UploadOptions, 'role' | 'scopeJobId' | 'dedupe'> & {
      trace?: components['schemas']['PointerTrace']
    },
  ): Promise<Media>
}
export interface MusicHelpers {
  /** Imports an Openverse track, following a slow (202) import's job until it's done. */
  importAndWait(
    input: { id: string; caption?: string },
    o?: { signal?: AbortSignal; pollIntervalMs?: number },
  ): Promise<Media>
}
export interface ConfigHelpers {
  /** The server's version and features (cached for the client's life). */
  get(): Promise<ServerConfig>
  /** Whether the server lists this feature. */
  supports(feature: string): Promise<boolean>
}

// Resources are copied onto the instance in the constructor, so the class carries their types too.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface VideoAgent extends Omit<Resources, 'videos' | 'media' | 'music' | 'config'> {
  readonly videos: Resources['videos'] & VideoHelpers
  readonly files: FileHelpers
  readonly media: Resources['media'] & MediaHelpers
  readonly music: Resources['music'] & MusicHelpers
  readonly config: ConfigHelpers
}

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
    const generated = resources(transport)
    const videos: VideoAgent['videos'] = {
      ...generated.videos,
      wait: (id, o) =>
        waitForVideo({ send: (x) => this.send(x), progress: (v) => generated.videos.progress(v) }, id, o),
      listAll: (input, opts) => listAll(generated.videos.list, input, opts),
      resolve: (ref) => resolveVideo(f, ref),
      redoScenes: (id, input, opts) =>
        redoScenes({ get: (v) => generated.videos.get(v), revise: generated.videos.revise }, id, input, opts),
    }
    const fileDeps = {
      baseUrl: url,
      send: (x: Exchange) => this.send(x),
      fetch: f,
      getVideo: (id: string) => generated.videos.get(id),
    }
    const files: FileHelpers = {
      url: (video, fo) => fileUrl(fileDeps, video, fo),
      download: ((video: Video | string, fo: FileOptions & { to?: string; signal?: AbortSignal }) =>
        downloadFile(fileDeps, video, fo as FileOptions & { to: string })) as FileHelpers['download'],
    }
    const mediaDeps = { send: (x: Exchange) => this.send(x), retries: o.retries ?? 3, log: o.logger }
    const media: VideoAgent['media'] = {
      ...generated.media,
      upload: async (file, uo) => {
        // The role field is shared with takes, so the feature is checked here rather than on the route.
        if (uo?.role === 'screen-recording') await this.requireFeatures(['screen_recording'])
        return uploadMedia(mediaDeps, file, uo)
      },
      uploadRecording: async (file, ro = {}) => {
        await this.requireFeatures(['screen_recording'])
        const { trace, ...uo } = ro
        const item = await uploadMedia(mediaDeps, file, { ...uo, role: 'screen-recording', dedupe: false })
        return trace ? generated.media.setTrace(item.id, trace) : item
      },
    }
    const music: VideoAgent['music'] = {
      ...generated.music,
      importAndWait: (input, mo) => importMusicAndWait(mediaDeps, input, mo),
    }
    const config: ConfigHelpers = {
      get: () => this.serverConfig(),
      supports: async (feature) => (await this.serverConfig()).features.includes(feature),
    }
    Object.assign(this, generated, { videos, files, media, music, config })
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

  /** Every item of any list that pages with { items, nextCursor }: `va.listAll(va.media.list, { kind: 'audio' })`. */
  listAll<I extends { cursor?: string }, T>(
    list: Pageable<I, T>,
    input?: Omit<I, 'cursor'>,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<T> {
    return listAll(list, input, opts)
  }

  /** One request through the client's auth, retries and errors (for helpers that need the raw Response). */
  send(x: Exchange): Promise<Response> {
    return send(this.#http, x)
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
