// In-memory fakes for every port. FakeRunner scripts a run's timeline so tests can reproduce
// lost callbacks, ambiguous starts, await_input, capacity errors and slow stops.
import { readFileSync } from 'node:fs'
import { tarGz } from './tarball.js'
import { createHash, randomUUID } from 'node:crypto'
import type {
  BlobStoreName,
  BlobsPort,
  Clock,
  Config,
  Deps,
  HttpPort,
  IdentityPort,
  IdentitySettings,
  IdentityUser,
  PlatformPort,
  RunnerPort,
  RunnerSnapshot,
  StartRequest,
  GatewayPort,
  OAuthPort,
  RouteAnswers,
} from '../src/deps.js'
import { RunnerError, readConfig } from '../src/deps.js'
import { ids as realIds } from '../src/lib/ids.js'
import { createLogger, type Logger } from '../src/lib/log.js'
import { createMemoryStore } from '../src/store/memory.js'
import { resetAuthCache } from '../src/domain/auth.js'
import { resetSettingsCache } from '../src/domain/settings.js'
import { resetOAuthCaches } from '../src/auth/oauth.js'
import { UpstreamError, type UpstreamIdentity, type UpstreamUser } from '../src/auth/upstream.js'
import type { Manifest } from '../src/domain/types.js'
import { PREVIEW_FILES, PREVIEW_NAMES, type PreviewFile } from '../src/lib/media/previews.js'

export class FakeClock implements Clock {
  constructor(public t = Date.parse('2026-11-02T10:00:00.000Z')) {}
  now() {
    return new Date(this.t)
  }
  advance(ms: number) {
    this.t += ms
  }
}

export class FakeBlobs implements BlobsPort {
  data = new Map<string, Uint8Array>()
  meta = new Map<string, Record<string, string>>()
  private k = (s: BlobStoreName, key: string) => `${s}:${key}`
  async get(s: BlobStoreName, key: string) {
    return this.data.get(this.k(s, key)) ?? null
  }
  async set(s: BlobStoreName, key: string, data: Uint8Array | string, metadata?: Record<string, string>) {
    this.data.set(this.k(s, key), typeof data === 'string' ? new TextEncoder().encode(data) : data)
    if (metadata) this.meta.set(this.k(s, key), metadata)
  }
  async delete(s: BlobStoreName, key: string) {
    this.data.delete(this.k(s, key))
  }
  async list(s: BlobStoreName, prefix: string) {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(`${s}:${prefix}`))
      .map((k) => k.slice(s.length + 1))
  }
  text(s: BlobStoreName, key: string) {
    const v = this.data.get(this.k(s, key))
    return v ? new TextDecoder().decode(v) : null
  }
}

export class FakeIdentity implements IdentityPort {
  users = new Map<string, IdentityUser>()
  sessions = new Map<string, string>() // cookie value -> user id
  settingsValue: IdentitySettings | null = { autoconfirm: false, disableSignup: false }
  outage = false
  addUser(u: Partial<IdentityUser> & { id: string; email: string }) {
    const user: IdentityUser = { name: null, confirmed: true, invited: false, ...u }
    this.users.set(user.id, user)
    const cookie = `sess-${user.id}`
    this.sessions.set(cookie, user.id)
    return { user, cookie: `nf_jwt=${cookie}` }
  }
  async sessionUser(req: Request) {
    const m = /nf_jwt=([^;]+)/.exec(req.headers.get('cookie') ?? '')
    const id = m?.[1] ? this.sessions.get(m[1]) : undefined
    // Like getUser(): falls back to token claims even if the account is gone.
    return id
      ? (this.users.get(id) ?? {
          id,
          email: 'ghost@example.com',
          name: null,
          confirmed: true,
          invited: false,
        })
      : null
  }
  async liveUser(id: string) {
    if (this.outage) throw new Error('identity unreachable')
    return this.users.get(id) ?? null
  }
  async settings() {
    return this.settingsValue
  }
}

export type RunScript = {
  /** Snapshots returned in order; the last one repeats. */
  timeline: RunnerSnapshot[]
  /** Uploads to perform (into fake blobs) when the run reaches its terminal snapshot. */
  onTerminal?: (req: StartRequest) => Promise<void>
}

export class FakeRunner implements RunnerPort {
  runs = new Map<
    string,
    { req: StartRequest; script: RunScript; i: number; stopped: boolean; runnerId: string }
  >()
  starts: StartRequest[] = []
  nextScripts: RunScript[] = []
  defaultScript: (req: StartRequest) => RunScript = () => ({ timeline: [running(), succeeded()] })
  startError: RunnerError | null = null
  /** Simulates "accepted, response lost": the run exists but start() throws ambiguous. */
  loseNextResponse = false
  stopCalls = 0

  async start(req: StartRequest) {
    this.starts.push(req)
    if (this.startError) {
      const e = this.startError
      this.startError = null
      throw e
    }
    const runnerId = `run_${this.runs.size + 1}`
    const script = this.nextScripts.shift() ?? this.defaultScript(req)
    this.runs.set(req.requestId, { req, script, i: 0, stopped: false, runnerId })
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new RunnerError('ambiguous', 'response lost', { sentAt: Date.now(), failedAt: Date.now() })
    }
    return { handle: JSON.stringify({ requestId: req.requestId }), runnerId, sessionId: `${runnerId}_s1` }
  }
  async reconcile(req: StartRequest) {
    const r = this.runs.get(req.requestId)
    if (!r) return { kind: 'none' as const }
    return {
      kind: 'matched' as const,
      handle: JSON.stringify({ requestId: req.requestId }),
      runnerId: r.runnerId,
      sessionId: `${r.runnerId}_s1`,
    }
  }
  async snapshot(handle: string): Promise<RunnerSnapshot> {
    const { requestId } = JSON.parse(handle) as { requestId: string }
    const r = this.runs.get(requestId)
    if (!r) throw new Error('unknown run')
    if (r.stopped)
      return {
        kind: 'terminal',
        status: 'cancelled',
        resultText: null,
        usage: { totalCreditsCost: 1 },
        failure: null,
      }
    const snap = r.script.timeline[Math.min(r.i, r.script.timeline.length - 1)] as RunnerSnapshot
    r.i++
    if (snap.kind === 'terminal' && r.script.onTerminal) {
      const fn = r.script.onTerminal
      delete r.script.onTerminal
      await fn(r.req)
    }
    return snap
  }
  async stop(handle: string) {
    this.stopCalls++
    const { requestId } = JSON.parse(handle) as { requestId: string }
    const r = this.runs.get(requestId)
    if (r) r.stopped = true
  }
  runUrl(runnerId: string) {
    return `https://app.netlify.com/projects/test/agent-runs/${runnerId}`
  }
}

export const running = (state = 'running', latestStep = 'Writing the composition'): RunnerSnapshot => ({
  kind: 'running',
  state,
  latestStep,
  usage: null,
})
export const succeeded = (resultText: string | null = 'done'): RunnerSnapshot => ({
  kind: 'terminal',
  status: 'succeeded',
  resultText,
  usage: { totalCreditsCost: 42 },
  failure: null,
})
export const failedSnap = (): RunnerSnapshot => ({
  kind: 'terminal',
  status: 'failed',
  resultText: null,
  usage: { totalCreditsCost: 5 },
  failure: { category: 'terminal', code: 'error', message: 'The agent crashed.' },
})

export class FakePlatform implements PlatformPort {
  dispatched: string[] = []
  onDispatch: ((attemptId: string) => Promise<void>) | null = null
  async productionDeployId() {
    return 'deploy_prod_1'
  }
  async dispatchFinalize(attemptId: string) {
    this.dispatched.push(attemptId)
    if (this.onDispatch) await this.onDispatch(attemptId)
  }
  assemblies: string[] = []
  onAssemble: ((uploadId: string) => Promise<void>) | null = null
  async dispatchMediaAssembly(uploadId: string) {
    this.assemblies.push(uploadId)
    if (this.onAssemble) await this.onAssemble(uploadId)
  }
  async setupFacts() {
    return { tokenValid: true, tokenError: null, agentRunnersAvailable: true, identityEnabled: true }
  }
}

export class FakeHttp implements HttpPort {
  calls: { url: string; body: string; headers: Record<string, string> }[] = []
  status = 200
  async postJson(url: string, body: string, headers: Record<string, string>) {
    this.calls.push({ url, body, headers })
    return { status: this.status }
  }
}

/** Scripted AI Gateway: set `route`/`reply` or push errors; every call is recorded. */
export class FakeGateway implements GatewayPort {
  isAvailable = true
  calls: { kind: 'route' | 'messages'; model?: string; system?: string; user?: string; images?: number }[] =
    []
  routeAnswers: RouteAnswers = {
    needs_questions: 'yes',
    template: 'launch',
    complexity: 'standard',
    aspect: 'unspecified',
  }
  /** Replies for messages() in order; a function gets the request. Errors are thrown. */
  replies: (string | Error | ((req: { model: string; system: string; user: string }) => string))[] = []
  delayMs = 0
  available() {
    return this.isAvailable
  }
  async route(input: { request: string; history: string[] }) {
    this.calls.push({ kind: 'route', user: input.request })
    return {
      answers: this.routeAnswers,
      model: 'jev-1.14.0',
      usage: { inputTokens: 330, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
  async messages(
    req: {
      model: string
      system: string
      user: string
      maxTokens: number
      images?: { mime: string; base64: string }[]
    },
    opts: { signal: AbortSignal },
  ) {
    this.calls.push({
      kind: 'messages',
      model: req.model,
      system: req.system,
      user: req.user,
      images: req.images?.length ?? 0,
    })
    if (this.delayMs)
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs)
        opts.signal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        })
      })
    const next = this.replies.shift()
    if (next === undefined) throw new Error('FakeGateway: no reply scripted')
    if (next instanceof Error) throw next
    const text = typeof next === 'function' ? next(req) : next
    return {
      text,
      model: req.model,
      usage: { inputTokens: 300, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
}

/** The upstream identity provider: signIn() hands out a code the callback can trade for that person. */
export class FakeUpstream implements UpstreamIdentity {
  codes = new Map<string, UpstreamUser>()
  exchanges: { code: string; redirectUri: string }[] = []
  failNext = false
  authorizeUrl(input: { state: string; redirectUri: string }) {
    const u = new URL('https://upstream.example/authorize')
    u.searchParams.set('state', input.state)
    u.searchParams.set('redirect_uri', input.redirectUri)
    return u.toString()
  }
  async exchange(code: string, redirectUri: string) {
    this.exchanges.push({ code, redirectUri })
    if (this.failNext) {
      this.failNext = false
      throw new UpstreamError('unavailable', 'token')
    }
    const u = this.codes.get(code)
    if (!u) throw new UpstreamError('rejected', 'token')
    return u
  }
  signIn(u: Partial<UpstreamUser> & { email: string }) {
    const code = `up_${randomUUID()}`
    this.codes.set(code, { subject: `sub-${u.email}`, emailVerified: true, ...u })
    return code
  }
}

export class FakeOAuth implements OAuthPort {
  upstream = new FakeUpstream()
  documents = new Map<string, unknown>()
  fetched: string[] = []
  async fetchClientMetadata(url: string) {
    this.fetched.push(url)
    return this.documents.get(url) ?? null
  }
}

export interface TestDeps extends Deps {
  clock: FakeClock
  blobs: FakeBlobs
  identity: FakeIdentity
  runner: FakeRunner
  platform: FakePlatform
  http: FakeHttp
  gateway: FakeGateway
  oauth: FakeOAuth
  logs: string[]
  /** The source.tar.gz the next fake run uploads (once), instead of the default fixture. */
  nextSource: Uint8Array | null
  /** Preview variants (and placeholder) the next fake run uploads and lists in its manifest (once). */
  nextPreviews: {
    files: Partial<Record<PreviewFile, Uint8Array>>
    lqip?: string
    skipped?: { name: string; reason: string }[]
  } | null
}

export function makeDeps(env: Record<string, string> = {}, store?: Deps['store']): TestDeps {
  resetAuthCache()
  resetSettingsCache()
  resetOAuthCaches()
  const logs: string[] = []
  const log: Logger = createLogger({}, (l) => logs.push(l))
  const config: Config = readConfig({
    ALLOWED_EMAIL_DOMAINS: 'acme.com',
    ADMIN_EMAILS: 'admin@acme.com',
    RUNNER_API_TOKEN: 'x',
    URL: 'https://video.example.com',
    ...env,
  })
  const clock = new FakeClock()
  let n = 0
  return {
    config,
    store: store ?? createMemoryStore(),
    nextSource: null,
    nextPreviews: null,
    blobs: new FakeBlobs(),
    identity: new FakeIdentity(),
    runner: new FakeRunner(),
    platform: new FakePlatform(),
    http: new FakeHttp(),
    gateway: new FakeGateway(),
    oauth: new FakeOAuth(),
    clock,
    ids: { ...realIds, videoId: () => `vid_${String(++n).padStart(4, '0')}` },
    log,
    logs,
  }
}

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** What render-job.ts would upload: fixture files sized for the job's aspect. */
export function fixtureFiles(aspect: '16:9' | '9:16' | '1:1' | '4:5' = '16:9') {
  const video = { '16:9': 'a169.mp4', '9:16': 'a916.mp4', '1:1': 'a11.mp4', '4:5': 'a45.mp4' }[aspect]
  return {
    'video.mp4': fx(video),
    'poster.jpg': fx('poster.jpg'),
    'preview.gif': fx('preview.gif'),
    'captions.vtt': fx('captions.vtt'),
    // A real archive, like render-job makes, so finalize extracts a preview bundle from it.
    'source.tar.gz': tarGz([
      { name: 'video/', type: '5' },
      { name: 'video/index.html', body: `<!doctype html><h1 id="title">composition ${randomUUID()}</h1>` },
      { name: 'video/summary.json', body: '{}' },
    ]),
  }
}

/** Preview variants with the right magic bytes (finalize checks those, not the pixels). */
export function previewFixtures(
  names: PreviewFile[] = PREVIEW_NAMES,
): Partial<Record<PreviewFile, Uint8Array>> {
  const enc = (s: string) => new TextEncoder().encode(s)
  const body = {
    'image/webp': () => enc(`RIFF\x10\x00\x00\x00WEBPVP8 ${randomUUID()}`),
    'image/avif': () => enc(`\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1${randomUUID()}`),
    'video/webm': () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...enc(randomUUID())]),
    'video/mp4': () => enc(`\x00\x00\x00\x18ftypisom${randomUUID()}`),
  }
  return Object.fromEntries(names.map((n) => [n, body[PREVIEW_FILES[n]]()]))
}

/** A real 20px WebP placeholder, as render-job inlines it. */
export const LQIP =
  'data:image/webp;base64,UklGRjgAAABXRUJQVlA4ICwAAADwAgCdASoUAAwAPu1iqU2ppaOiMAgBMB2JZQCdAC0kAAD+7tO5LfGkxkwAAA=='

export async function uploadAndManifest(
  blobs: FakeBlobs,
  jobId: string,
  attemptId: string,
  files: Record<string, Uint8Array> = fixtureFiles(),
  extra: { lqip?: string } = {},
): Promise<Manifest> {
  const entries = Object.entries(files) as [keyof Manifest['files'], Uint8Array][]
  for (const [name, bytes] of entries) await blobs.set('uploads', `${attemptId}/${name}`, bytes)
  return {
    jobId,
    attemptId,
    title: 'Test video',
    summary: 'Made in a test.',
    files: Object.fromEntries(
      entries.map(([n, b]) => [n, { sha256: sha(b), bytes: b.byteLength }]),
    ) as Manifest['files'],
    ...extra,
    durationSec: 2,
    width: 1920,
    height: 1080,
  }
}
