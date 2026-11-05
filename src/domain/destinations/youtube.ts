// The YouTube destination (publish destinations §4). Bounded steps, each saving its ids before the next call:
// a resumable upload in 8 MiB chunks (probing the session's offset after any uncertain answer), processing, captions
// (de-duplicated on retry), the thumbnail after processing (Shorts need that), then live. Removal makes the video
// private through the publication's pinned connection, never the acting person's.
import type { OptionsSchema } from '../../lib/options-schema.js'
import { accessToken, API, googleError, ReconnectError, secondsToQuotaReset, UPLOAD_API } from './google.js'
import type { ManifestFile, PublishManifest } from './manifest.js'
import { registerKind, youtubeAvailable } from './registry.js'
import { safeError, type DestinationKind, type StepCtx, type StepResult } from './types.js'

export const CHUNK = 8 * 1024 * 1024
const POLL_FIRST_SEC = 30
const POLL_SEC = 60
const POLL_MAX = 120 // about 2 hours
const CAPTION_NAME = 'Video Agent'
export const TITLE_MAX = 100
export const DESCRIPTION_MAX_BYTES = 5000

export const YOUTUBE_OPTIONS: OptionsSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', title: 'Title', maxLength: TITLE_MAX },
    description: { type: 'string', title: 'Description', maxLength: DESCRIPTION_MAX_BYTES },
    privacy: {
      type: 'string',
      title: 'Privacy',
      enum: ['unlisted', 'private', 'public'],
      default: 'unlisted',
    },
    captions: { type: 'boolean', title: 'Also add captions', default: true },
  },
  required: ['title'],
}

interface YtState {
  phase?: 'upload' | 'processing' | 'captions' | 'thumbnail'
  session?: string
  offset?: number
  uncertain?: boolean
  videoId?: string
  polls?: number
  captionDone?: boolean
  warnings?: string[]
}

/** The CC BY credits under the description, always (the licences require them). */
export function creditsBlock(m: PublishManifest): string {
  const lines = (
    m.version.credits as unknown as {
      title?: string
      creator?: string | null
      license?: string
      url?: string | null
    }[]
  ).map((c) => [c.title, c.creator ? `by ${c.creator}` : null, c.license, c.url].filter(Boolean).join(' · '))
  return lines.length ? `Credits:\n${lines.join('\n')}` : ''
}

export function fullDescription(options: Record<string, unknown>, m: PublishManifest): string {
  const own = typeof options.description === 'string' ? options.description.trim() : ''
  const credits = creditsBlock(m)
  return [own, credits].filter(Boolean).join('\n\n')
}

const fileOf = (m: PublishManifest, kind: ManifestFile['kind']) =>
  m.files.find((f) => f.kind === kind) ?? null

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const r = s.getReader()
  for (;;) {
    const { value, done } = await r.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** A Google error as a step result: quota waits for the reset; the channel's upload limit fails. */
async function fromGoogle(res: Response, now: Date, state: YtState): Promise<StepResult> {
  const e = await googleError(res)
  if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded')
    return {
      status: 'retry',
      state,
      error: safeError('quota', 'YouTube’s daily quota is used up; it continues after the reset.'),
      retryAt: new Date(
        now.getTime() + (secondsToQuotaReset(now) + 60 + Math.floor(Math.random() * 600)) * 1000,
      ).toISOString(),
    }
  if (e.reason === 'uploadLimitExceeded')
    return { status: 'failed', error: safeError('upload_limit', e.message) }
  if (res.status === 401)
    return { status: 'retry', state, error: safeError('auth', 'Refreshing access to YouTube.') }
  if (
    res.status === 429 ||
    res.status >= 500 ||
    e.reason === 'rateLimitExceeded' ||
    e.reason === 'backendError'
  )
    return { status: 'retry', state, error: safeError(`http_${res.status}`, e.message) }
  return { status: 'failed', error: safeError(e.reason, e.message) }
}

async function publishStep(ctx: StepCtx, token: string): Promise<StepResult> {
  const { deps } = ctx
  const m = ctx.manifest as PublishManifest
  const s = { ...(ctx.state as YtState) }
  const now = deps.clock.now()
  const auth = { authorization: `Bearer ${token}` }
  const o = ctx.publication.options
  const mp4 = fileOf(m, 'mp4')
  if (!mp4) return { status: 'failed', error: safeError('no_video', 'The version has no video file.') }
  s.phase ??= 'upload'

  if (s.phase === 'upload') {
    if (!s.session) {
      const res = await deps.fetch(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(mp4.bytes),
          'x-upload-content-type': 'video/mp4',
        },
        body: JSON.stringify({
          snippet: {
            title: (typeof o.title === 'string' && o.title ? o.title : m.version.title).slice(0, TITLE_MAX),
            description: fullDescription(o, m),
            defaultLanguage: m.video.language,
          },
          status: {
            privacyStatus: typeof o.privacy === 'string' ? o.privacy : 'unlisted',
            selfDeclaredMadeForKids: false,
          },
        }),
      })
      const session = res.headers.get('location')
      if (!res.ok || !session) return fromGoogle(res, now, s)
      return { status: 'continue', state: { ...s, session, offset: 0 } }
    }
    if (s.uncertain) {
      // After an answer we couldn't trust: ask the session how much it has.
      const res = await deps.fetch(s.session, {
        method: 'PUT',
        headers: { ...auth, 'content-range': `bytes */${mp4.bytes}`, 'content-length': '0' },
      })
      if (res.status === 308) {
        const range = res.headers.get('range')
        const end = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? -1) : -1
        return { status: 'continue', state: { ...s, uncertain: false, offset: end + 1 } }
      }
      if (res.status === 200 || res.status === 201) {
        const j = (await res.json().catch(() => ({}))) as { id?: string }
        if (j.id)
          return { status: 'continue', state: { ...s, uncertain: false, videoId: j.id, phase: 'processing' } }
      }
      if (res.status === 404 || res.status === 410) {
        // The session expired. Start again only if no video was made.
        if (s.videoId) return { status: 'continue', state: { ...s, uncertain: false, phase: 'processing' } }
        const fresh: YtState = { ...s, uncertain: false }
        delete fresh.session
        fresh.offset = 0
        return { status: 'continue', state: fresh }
      }
      return fromGoogle(res, now, s)
    }
    const start = s.offset ?? 0
    const end = Math.min(start + CHUNK, mp4.bytes) - 1
    const stream = await ctx.stream('mp4', { start, end })
    if (!stream) return { status: 'failed', error: safeError('video_deleted', 'The video’s file is gone.') }
    const body = await readAll(stream)
    let res: Response
    try {
      res = await deps.fetch(s.session, {
        method: 'PUT',
        headers: {
          ...auth,
          'content-type': 'video/mp4',
          'content-length': String(body.byteLength),
          'content-range': `bytes ${start}-${start + body.byteLength - 1}/${mp4.bytes}`,
        },
        body: body as unknown as NonNullable<RequestInit['body']>,
      })
    } catch {
      return {
        status: 'retry',
        state: { ...s, uncertain: true },
        error: safeError('network', 'The upload was interrupted.'),
      }
    }
    if (res.status === 308) {
      const range = res.headers.get('range')
      const got = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? start - 1) + 1 : start
      return { status: 'continue', state: { ...s, offset: got } }
    }
    if (res.status === 200 || res.status === 201) {
      const j = (await res.json().catch(() => ({}))) as { id?: string }
      if (!j.id)
        return {
          status: 'retry',
          state: { ...s, uncertain: true },
          error: safeError('bad_response', 'YouTube didn’t say which video it made.'),
        }
      deps.log.info('youtube.uploaded', { id: ctx.publication.id, videoId: j.id })
      return {
        status: 'waiting',
        checkAfterSec: POLL_FIRST_SEC,
        state: { ...s, videoId: j.id, phase: 'processing', polls: 0 },
        message: 'Processing on YouTube',
        externalId: j.id,
      }
    }
    if (res.status >= 500 || res.status === 429)
      return {
        status: 'retry',
        state: { ...s, uncertain: true },
        error: safeError(`http_${res.status}`, 'YouTube had a problem; resuming.'),
      }
    return fromGoogle(res, now, s)
  }

  const videoId = s.videoId ?? ''
  if (s.phase === 'processing') {
    const res = await deps.fetch(
      `${API}/videos?part=processingDetails,status&id=${encodeURIComponent(videoId)}`,
      { headers: auth },
    )
    if (!res.ok) return fromGoogle(res, now, s)
    const j = (await res.json()) as {
      items?: {
        processingDetails?: { processingStatus?: string; processingFailureReason?: string }
        status?: { uploadStatus?: string; rejectionReason?: string; failureReason?: string }
      }[]
    }
    const v = j.items?.[0]
    const ps = v?.processingDetails?.processingStatus
    const us = v?.status?.uploadStatus
    if (us === 'rejected' || us === 'failed' || ps === 'failed' || ps === 'terminated')
      return {
        status: 'failed',
        error: safeError(
          'youtube_rejected',
          `YouTube didn’t accept it: ${v?.status?.rejectionReason ?? v?.status?.failureReason ?? v?.processingDetails?.processingFailureReason ?? ps ?? us}.`,
        ),
      }
    if (ps === 'succeeded' || us === 'processed')
      return { status: 'continue', state: { ...s, phase: 'captions' } }
    const polls = (s.polls ?? 0) + 1
    if (polls > POLL_MAX)
      return {
        status: 'failed',
        error: safeError('processing_timeout', 'YouTube is still processing it after two hours.'),
      }
    return {
      status: 'waiting',
      checkAfterSec: POLL_SEC,
      state: { ...s, polls },
      message: 'Processing on YouTube',
    }
  }

  if (s.phase === 'captions') {
    const vtt = fileOf(m, 'captions')
    if (o.captions === false || !vtt || s.captionDone)
      return { status: 'continue', state: { ...s, phase: 'thumbnail' } }
    // Already added on an earlier try?
    const list = await deps.fetch(`${API}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {
      headers: auth,
    })
    if (list.ok) {
      const j = (await list.json()) as { items?: { snippet?: { name?: string } }[] }
      if (j.items?.some((c) => c.snippet?.name === CAPTION_NAME))
        return { status: 'continue', state: { ...s, captionDone: true, phase: 'thumbnail' } }
    }
    const stream = await ctx.stream('captions')
    if (!stream) return { status: 'continue', state: { ...s, phase: 'thumbnail' } }
    const text = new TextDecoder().decode(await readAll(stream))
    const boundary = `va${ctx.publication.id}`
    const meta = JSON.stringify({ snippet: { videoId, language: m.video.language, name: CAPTION_NAME } })
    const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: text/vtt\r\n\r\n${text}\r\n--${boundary}--`
    const res = await deps.fetch(`${UPLOAD_API}/captions?part=snippet&uploadType=multipart`, {
      method: 'POST',
      headers: { ...auth, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    })
    if (res.ok) return { status: 'continue', state: { ...s, captionDone: true, phase: 'thumbnail' } }
    const r = await fromGoogle(res, now, s)
    if (r.status === 'retry') return r
    // A permanent caption failure doesn't stop the video going live.
    return {
      status: 'continue',
      state: {
        ...s,
        phase: 'thumbnail',
        warnings: [...(s.warnings ?? []), 'The captions couldn’t be added.'],
      },
    }
  }

  // Thumbnail, after processing (Shorts need that). Without a verified channel YouTube answers 403: a warning.
  const poster = fileOf(m, 'poster')
  const warnings = [...(s.warnings ?? [])]
  if (poster) {
    const stream = await ctx.stream('poster')
    if (stream) {
      const bytes = await readAll(stream)
      const res = await deps.fetch(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) },
        body: bytes as unknown as NonNullable<RequestInit['body']>,
      })
      if (res.status === 403)
        warnings.push('The custom thumbnail needs a verified YouTube channel; YouTube picked one.')
      else if (!res.ok) {
        const r = await fromGoogle(res, now, s)
        if (r.status === 'retry') return r
        warnings.push('The custom thumbnail couldn’t be set.')
      }
    }
  }
  return {
    status: 'live',
    url: `https://youtu.be/${videoId}`,
    externalId: videoId,
    ...(warnings.length ? { warnings } : {}),
  }
}

async function removeStep(ctx: StepCtx, token: string): Promise<StepResult> {
  const videoId = ctx.publication.externalId ?? (ctx.state as YtState).videoId
  if (!videoId) return { status: 'removed' }
  const res = await ctx.deps.fetch(`${API}/videos?part=status`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: videoId,
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    }),
  })
  if (res.ok || res.status === 404) return { status: 'removed' }
  return fromGoogle(res, ctx.deps.clock.now(), ctx.state)
}

async function step(ctx: StepCtx): Promise<StepResult> {
  const conn = ctx.connection
  if (!conn)
    return ctx.operation.action === 'remove'
      ? {
          status: 'failed',
          error: safeError(
            'disconnected',
            'YouTube was disconnected: make the video private on YouTube by hand.',
          ),
        }
      : { status: 'failed', error: safeError('no_connection', 'Connect YouTube first.') }
  let token: string
  try {
    token = await accessToken(ctx.deps, conn)
  } catch (e) {
    if (e instanceof ReconnectError)
      return ctx.operation.action === 'remove'
        ? { status: 'waiting', checkAfterSec: 3600, message: 'Reconnect YouTube to finish removing it.' }
        : { status: 'failed', error: safeError('reconnect', 'Reconnect YouTube, then try again.') }
    return { status: 'retry', error: safeError('auth', 'Couldn’t reach Google; trying again.') }
  }
  return ctx.operation.action === 'remove' ? removeStep(ctx, token) : publishStep(ctx, token)
}

export const youtubeKind: DestinationKind = {
  kind: 'youtube',
  optionsSchema: () => YOUTUBE_OPTIONS,
  unpublishOptionsSchema: () => null,
  ready: async ({ deps, repo, principal }) => {
    if (!(await youtubeAvailable(deps, repo)))
      return { ok: false, reason: 'YouTube isn’t set up on this video agent.' }
    const c = await repo.getUserConnection(principal.userId, 'youtube')
    if (!c) return { ok: false, reason: 'Connect YouTube first (API keys → Connected accounts).' }
    if (c.status !== 'ok') return { ok: false, reason: 'Reconnect YouTube (API keys → Connected accounts).' }
    return { ok: true }
  },
  checkOptions: (o, m) => {
    const title = typeof o.title === 'string' ? o.title : ''
    const desc = fullDescription(o, m)
    if (!title.trim()) return 'Give it a title.'
    if (title.length > TITLE_MAX) return `The title can be at most ${TITLE_MAX} characters.`
    if (/[<>]/.test(title) || /[<>]/.test(desc))
      return 'YouTube doesn’t allow < or > in titles or descriptions.'
    if (new TextEncoder().encode(desc).length > DESCRIPTION_MAX_BYTES)
      return `The description, credits included, can be at most ${DESCRIPTION_MAX_BYTES} bytes.`
    return null
  },
  step,
}

registerKind(youtubeKind)
