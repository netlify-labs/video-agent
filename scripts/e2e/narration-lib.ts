// Shared by the voice-over live gates (narration-privacy.ts, narration.ts; plan 2026-11-02 §9, §10): calls as any
// of several keys, a gate error that still runs cleanup, a recording upload through an upload session, the MCP call,
// PCM16 WAV read/write, and the --dry plan printer. JSON-line logging comes from lib.ts.
import { createHash } from 'node:crypto'
import { computePeaks, detectSpeech, encodePeaks, VAD_VERSION } from '../../src/lib/peaks.js'
import { SAMPLE_RATE, type Span } from '../../src/lib/timeline.js'
import { base, log, mcpPost } from './lib.js'

export const dry = process.argv.includes('--dry')
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A failed check: thrown, so the script's finally block still cleans up before it exits non-zero. */
export class GateError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message)
  }
}
export function check(ok: boolean, msg: string, f: Record<string, unknown> = {}): asserts ok {
  if (!ok) throw new GateError(msg, f)
}
/** A gate's last line, after cleanup: FAIL with the failure's fields and the summary (exit code 1), or PASS. */
export function finish(failure: Error | null, summary: Record<string, unknown>) {
  if (failure) {
    log('FAIL', { msg: failure.message, ...(failure instanceof GateError ? failure.fields : {}), summary })
    process.exitCode = 1
  } else log('PASS', summary)
}

export interface Res<T> {
  status: number
  json: T
  text: string
  headers: Headers
}
/** One call as `k`. JSON bodies by default; a Uint8Array goes as octet-stream. Never throws on a status. */
export async function call<T = Record<string, unknown>>(
  k: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const raw = body instanceof Uint8Array
  const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${k}`,
      ...(body === undefined
        ? {}
        : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}
  } catch {
    json = {}
  }
  return { status: res.status, json: json as T, text, headers: res.headers }
}

/** Downloads a version file link (a 302 to a signed URL) as bytes. */
export async function download(k: string, url: string) {
  const res = await fetch(url.startsWith('http') ? url : `${base}${url}`, {
    headers: { authorization: `Bearer ${k}` },
  })
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
}

/** An MCP tools/call as `k` (stateless JSON-RPC, as roles.ts does). The tool's structured result, or its error. */
export async function mcpTool(k: string, name: string, args: Record<string, unknown>) {
  const res = await mcpPost(k, 'tools/call', { name, arguments: args })
  const text = await res.text()
  // A streamable-HTTP server may answer as one SSE event.
  const body = text.trimStart().startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}')
  const rpc = JSON.parse(body) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text?: string }[] }
    error?: { code: number; message: string }
  }
  const structured =
    rpc.result?.structuredContent ??
    (rpc.result?.content?.[0]?.text
      ? (JSON.parse(rpc.result.content[0].text) as Record<string, unknown>)
      : {})
  return { http: res.status, rpcError: rpc.error ?? null, isError: rpc.result?.isError ?? false, structured }
}
export async function mcpTools(k: string) {
  const res = await mcpPost(k, 'tools/list', {})
  const text = await res.text()
  const body = text.trimStart().startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}')
  return ((JSON.parse(body) as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map(
    (t) => t.name,
  )
}

// ───── WAV (24 kHz mono PCM16, the take format) ─────
export function encodeWav(samples: Float32Array, rate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  dv.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++)
    dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767), true)
  return out
}
/** The samples of a PCM16 WAV (mono, or the first channel), with its rate. */
export function decodeWav(bytes: Uint8Array): { rate: number; channels: number; samples: Float32Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const id = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('not a WAV file')
  let rate = 0
  let channels = 0
  let bits = 0
  for (let o = 12; o + 8 <= bytes.length;) {
    const size = dv.getUint32(o + 4, true)
    if (id(o) === 'fmt ') {
      channels = dv.getUint16(o + 10, true)
      rate = dv.getUint32(o + 12, true)
      bits = dv.getUint16(o + 22, true)
    } else if (id(o) === 'data') {
      if (bits !== 16 || !channels) throw new Error(`expected PCM16, got ${bits}-bit`)
      const frames = Math.floor(Math.min(size, bytes.length - o - 8) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(o + 8 + i * 2 * channels, true) / 32768
      return { rate, channels, samples }
    }
    o += 8 + size + (size & 1)
  }
  throw new Error('no data chunk')
}

// ───── recordings ─────
export interface Media {
  id: string
  kind: string
  status: string
  filename: string
  bytes: number
  durationSec: number | null
  urls: { file: string; original: string; poster: string | null } | null
  recording: {
    role: string
    videoId: string | null
    usedIn: unknown[]
    retainUntil: string | null
  } | null
  error?: { code?: string; message?: string }
}

/**
 * Uploads a recording as `k` through an upload session (role + scopeJobId), waits until it's ready, then stores its
 * peaks and speech spans the way the recorder does. Returns the ready item.
 */
export async function uploadRecording(
  k: string,
  wav: Uint8Array,
  o: { filename: string; role: 'narration-take' | 'narration-upload'; scopeJobId: string; step: string },
): Promise<Media> {
  const t0 = Date.now()
  const s = await call<{ id: string; partSize: number; partCount: number; error?: unknown }>(
    k,
    'POST',
    '/api/v1/media/uploads',
    {
      filename: o.filename,
      size: wav.byteLength,
      sha256: sha256(wav),
      role: o.role,
      scopeJobId: o.scopeJobId,
    },
  )
  check(s.status === 201, `${o.step}: start upload session`, { status: s.status, body: s.json })
  const { id, partSize, partCount } = s.json
  for (let i = 0; i < partCount; i++) {
    const part = wav.subarray(i * partSize, Math.min(wav.byteLength, (i + 1) * partSize))
    const r = await call(k, 'PUT', `/api/v1/media/uploads/${id}/parts/${i}`, part, {
      'x-part-sha256': sha256(part),
    })
    check(r.status === 200, `${o.step}: part ${i}`, { status: r.status, body: r.json })
  }
  const done = await call<{ mediaId: string | null }>(k, 'POST', `/api/v1/media/uploads/${id}/complete`, {})
  check(done.status === 202 && !!done.json.mediaId, `${o.step}: complete upload`, {
    status: done.status,
    body: done.json,
  })
  const mediaId = done.json.mediaId
  let m: Media | undefined
  for (let i = 0; i < 90; i++) {
    m = (await call<Media>(k, 'GET', `/api/v1/media/${mediaId}`)).json
    if (m.status === 'ready' || m.status === 'rejected') break
    await sleep(2000)
  }
  check(m?.status === 'ready', `${o.step}: recording should be ready`, {
    mediaId,
    status: m?.status,
    media: m,
  })
  const pcm = decodeWav(wav).samples
  const peaks = await call(k, 'PUT', `/api/v1/media/${mediaId}/peaks`, encodePeaks(computePeaks(pcm)))
  check(peaks.status === 200, `${o.step}: store peaks`, { status: peaks.status, body: peaks.json })
  const spans: Span[] = detectSpeech(pcm)
  const speech = await call(k, 'PUT', `/api/v1/media/${mediaId}/speech`, {
    version: VAD_VERSION,
    spans,
    samples: pcm.length,
  })
  check(speech.status === 200, `${o.step}: store speech spans`, { status: speech.status, body: speech.json })
  log(o.step, {
    mediaId,
    uploadId: id,
    bytes: wav.byteLength,
    parts: partCount,
    seconds: m.durationSec,
    spans: spans.length,
    ms: Date.now() - t0,
  })
  return m
}

/** The narration op for clips of takes (integer samples at 24 kHz, identity fit: uploads have no recording drift). */
export function narrationOp(
  clips: { id: string; mediaId: string; srcStart: number; srcEnd: number; start: number; gainDb?: number }[],
  aiVoice: 'replace' | 'under' | 'keep' = 'replace',
) {
  return {
    op: 'narration' as const,
    schema: 1 as const,
    sampleRate: SAMPLE_RATE,
    clips: clips.map((c) => ({
      id: c.id,
      mediaId: c.mediaId,
      srcStart: c.srcStart,
      srcEnd: c.srcEnd,
      fit: { a: 0, b: 1 / SAMPLE_RATE, residualMs: 0 },
      offsetSamples: 0,
      start: c.start,
      gainDb: c.gainDb ?? 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    })),
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: aiVoice, volumeDb: -12 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: true },
    },
    cleanup: 'light' as const,
  }
}

export interface Edit {
  id: string
  rev: number
  ops: unknown[]
  composition: { duration: number; audio: { id: string; role: string; muted: boolean }[] }
  error?: unknown
}
/**
 * Opens `k`'s draft of version n and takes the video's narration lock for it. Refuses a draft of theirs that already
 * has edits (the gate never overwrites someone's work). `onCreated` gets the draft id before anything else can fail.
 */
export async function openDraft(k: string, videoId: string, n: number, onCreated: (id: string) => void) {
  const r = await call<Edit>(k, 'POST', `/api/v1/videos/${videoId}/versions/${n}/edits`)
  check(r.status === 200 || r.status === 201, 'open draft', { videoId, n, status: r.status, body: r.json })
  check(
    r.status === 201 || r.json.ops.length === 0,
    "This key already has a draft of that version with edits: finish or discard it first (the gate won't overwrite it)",
    { draftId: r.json.id, ops: r.json.ops.length },
  )
  onCreated(r.json.id)
  const lock = await call(k, 'POST', `/api/v1/videos/${videoId}/narration-lock`, { draftId: r.json.id })
  check(lock.status === 200, 'take the narration lock', { videoId, status: lock.status, body: lock.json })
  log('draft', {
    videoId,
    n,
    draftId: r.json.id,
    created: r.status === 201,
    rev: r.json.rev,
    duration: r.json.composition.duration,
  })
  return r.json
}
export const saveDraft = (k: string, d: Pick<Edit, 'id'>, rev: number, ops: unknown[]) =>
  call<Edit>(k, 'PUT', `/api/v1/edits/${d.id}`, { rev, ops })

// ───── --dry ─────
/** Prints the env check and the plan as JSON lines, then exits: 0 when the env is complete, 2 when it isn't. */
export function dryRun(o: {
  script: string
  required: Record<string, string | undefined>
  optional: Record<string, string | undefined>
  steps: string[]
  credits: Record<string, unknown>
  problems?: string[]
}): never {
  const missing = Object.entries(o.required)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  const problems = [...(o.problems ?? [])]
  if (o.required.VIDEO_AGENT_URL && !/^https?:\/\/[^/]+/.test(o.required.VIDEO_AGENT_URL))
    problems.push('VIDEO_AGENT_URL must be an http(s) URL')
  for (const [k, v] of Object.entries({ ...o.required, ...o.optional }))
    if (/KEY/.test(k) && v && !v.startsWith('nva_'))
      problems.push(`${k} doesn't look like an API key (nva_…)`)
  log('dry_env', {
    script: o.script,
    required: Object.fromEntries(
      Object.entries(o.required).map(([k, v]) => [k, v ? (/KEY/.test(k) ? 'set' : v) : null]),
    ),
    optional: Object.fromEntries(
      Object.entries(o.optional).map(([k, v]) => [k, v ? (/KEY/.test(k) ? 'set' : v) : null]),
    ),
    missing,
    problems,
  })
  o.steps.forEach((s, i) => log('dry_step', { n: i + 1, what: s }))
  log('dry_credits', o.credits)
  const ok = !missing.length && !problems.length
  log(ok ? 'DRY_OK' : 'DRY_INCOMPLETE', { missing, problems, network: 'none' })
  process.exit(ok ? 0 : 2)
}
