// Mock mode: screen recordings for a demo (screen-recording plan §4.3–4.5; va-rsk5.4.1, 4.2, 4.7), a mockRoutes entry
// tried before the mock API's own (like ./looks.ts), so server.ts doesn't grow. Upload sessions with the
// screen-recording role, the pointer trace, the library's recordings (one with a trace, one without), and creating a
// video with `recording`: the request is kept on window.__mockDemoCreates for tests, then the mock API makes the video.
//
// localStorage switches, set before the app loads:
//   mockNoRecordings=1   the library has no screen recordings yet

interface MockRecording {
  id: string
  kind: 'video'
  status: 'ready'
  rejectReason: null
  filename: string
  title: string | null
  caption: null
  mime: 'video/mp4'
  bytes: number
  width: number
  height: number
  durationSec: number
  uploader: { id: string; name: string; email: string; avatarUrl: null }
  createdAt: string
  usedIn: number
  urls: { file: string; original: string; poster: string | null }
  canDelete: boolean
  source: null
  role: 'screen-recording'
  hasTrace: boolean
  recording: null
}

const setting = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status)

const me = { id: 'u_sam', name: 'Sam Rivera', email: 'sam@example.com', avatarUrl: null }
const item = (id: string, filename: string, o: Partial<MockRecording> = {}): MockRecording => ({
  id,
  kind: 'video',
  status: 'ready',
  rejectReason: null,
  filename,
  title: null,
  caption: null,
  mime: 'video/mp4',
  bytes: 4_200_000,
  width: 1280,
  height: 720,
  durationSec: 60,
  uploader: me,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  usedIn: 0,
  urls: { file: '/teaser-v2.mp4', original: '/teaser-v2.mp4', poster: '/teaser-v2.jpg' },
  canDelete: true,
  source: null,
  role: 'screen-recording',
  hasTrace: false,
  recording: null,
  ...o,
})

const recordings: MockRecording[] =
  setting('mockNoRecordings') === '1'
    ? []
    : [
        item('med_screen_plain', 'settings-tour.mp4', { durationSec: 95, title: 'Settings tour' }),
        item('med_screen_trace', 'add-webhook.mp4', {
          durationSec: 75,
          // Recorded with video-agent record at 2x: big enough to zoom sharply (no low-resolution note).
          width: 2560,
          height: 1440,
          hasTrace: true,
          title: 'Add a webhook',
        }),
      ]
/** Marks this route's own config request, so it passes through. */
const SKIP = 'x-mock-recording-pass'
const sessions = new Map<string, { id: string; filename: string; size: number; parts: Set<number> }>()

declare global {
  interface Window {
    __mockDemoConfirms?: string[][]
    __mockDemoCreates?: unknown[]
    __mockTraces?: Record<string, unknown>
  }
}

const readJson = async (init?: RequestInit, input?: RequestInfo | URL): Promise<Record<string, unknown>> => {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body) as Record<string, unknown>
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>
  } catch {
    // no body
  }
  return {}
}

/** The screen recording routes, tried before the mock API's own; null passes to it. */
export async function recordingRoute(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  inner: () => Promise<Response>,
): Promise<Response | null> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    window.location.origin,
  )
  const p = url.pathname
  if (!p.startsWith('/api/')) return null
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (p === '/api/v1/config' && !headers.has(SKIP)) {
    // Through the other routes (looks adds its feature too), then screen_recording.
    const res = await window.fetch(url.pathname + url.search, { headers: { [SKIP]: '1' } })
    const body = (await res.json()) as { features: string[] }
    return json({ ...body, features: [...body.features, 'screen_recording'] }, res.status)
  }
  if (p === '/api/v1/media/uploads' && method === 'POST') {
    const b = await readJson(init, input)
    if (b.role !== 'screen-recording') return null
    const s = {
      id: `upl_screen${String(sessions.size + 1)}`,
      filename: String(b.filename),
      size: Number(b.size),
      parts: new Set<number>(),
    }
    sessions.set(s.id, s)
    return json(session(s), 201)
  }
  const up = /^\/api\/v1\/media\/uploads\/(upl_screen\d+)(?:\/parts\/(\d+)|\/(complete))?$/.exec(p)
  if (up?.[1]) {
    const s = sessions.get(up[1])
    if (!s) return fail(404, 'not_found', 'Upload not found.')
    if (up[2] !== undefined) {
      s.parts.add(Number(up[2]))
      return json({ idx: Number(up[2]), sha256: 'x', duplicate: false })
    }
    if (up[3]) {
      const m = item(`med_screen_up${String(recordings.length + 1)}`, s.filename, {
        bytes: s.size,
        durationSec: 30,
        createdAt: new Date().toISOString(),
      })
      recordings.unshift(m)
      return json({ ...session(s), status: 'done', mediaId: m.id }, 202)
    }
    return json(session(s))
  }
  const trace = /^\/api\/v1\/media\/([^/]+)\/trace$/.exec(p)
  if (trace?.[1] && method === 'PUT') {
    const m = recordings.find((r) => r.id === trace[1])
    if (!m) return fail(404, 'not_found', 'Media not found.')
    m.hasTrace = true
    window.__mockTraces = { ...window.__mockTraces, [m.id]: await readJson(init, input) }
    return json({ ok: true })
  }
  const one = /^\/api\/v1\/media\/([^/]+)$/.exec(p)
  if (one?.[1] && method === 'GET') {
    const m = recordings.find((r) => r.id === one[1])
    return m ? json(m) : null
  }
  if (p === '/api/v1/media' && method === 'GET') {
    // Only the demo page lists them, so the library's own mock lists (and their tests) stay as they are.
    const kind = url.searchParams.get('kind')
    if ((kind && kind !== 'video') || !window.location.pathname.startsWith('/new/demo')) return null
    const res = await inner()
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null }
    return json({ ...body, items: [...recordings, ...body.items] }, res.status)
  }
  // mockDemo: a video is a demo, its versions made from a recording with a Hidden list (one area unchecked).
  // mockDemo=1 makes vid_teaser the demo; mockDemo=<video id> makes that one.
  const demoId = setting('mockDemo') === '1' ? 'vid_teaser' : setting('mockDemo')
  if (demoId) {
    if (p.startsWith(`/api/v1/videos/${demoId}/versions/`) && p.endsWith('/hidden/confirm')) {
      if (method === 'POST') {
        const b = (await readJson(init, input)) as { ids?: string[] }
        for (const id of b.ids ?? []) checked.add(id)
        window.__mockDemoConfirms = [...(window.__mockDemoConfirms ?? []), b.ids ?? []]
        return withDemo(await window.fetch(`/api/v1/videos/${demoId}`))
      }
    }
    if (p === `/api/v1/videos/${demoId}` && method === 'GET') return withDemo(await inner())
  }
  if (p === '/api/v1/videos' && method === 'POST') {
    const b = await readJson(init, input)
    if (!b.recording) return null
    window.__mockDemoCreates = [...(window.__mockDemoCreates ?? []), b]
    // The mock API makes an ordinary video from the rest (this route passes it on: no recording).
    const rest = { ...b }
    delete rest.recording
    delete rest.agent
    return recreate(input, init, rest)
  }
  return null
}

const session = (s: { id: string; filename: string; size: number; parts: Set<number> }) => ({
  id: s.id,
  filename: s.filename,
  size: s.size,
  partSize: 4 * 1024 * 1024,
  partCount: Math.max(1, Math.ceil(s.size / (4 * 1024 * 1024))),
  uploaded: [...s.parts],
  status: 'open',
  mediaId: null,
  error: null,
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  role: 'screen-recording',
  scopeJobId: null,
})

/** The same create without the demo fields, through the mock API (window.fetch is the mock). */
function recreate(input: RequestInfo | URL, init: RequestInit | undefined, body: Record<string, unknown>) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  return window.fetch('/api/v1/videos', { method: 'POST', headers, body: JSON.stringify(body) })
}

/** Hidden areas checked with Looks right (mockDemo). */
const checked = new Set<string>()
const demoHidden = () =>
  [
    {
      id: 's1',
      source: 'setup',
      beat: 'add-site',
      start: 0,
      end: 20,
      reason: 'Hidden by you',
      why: 'You drew it',
    },
    {
      id: 'p1',
      source: 'agent',
      beat: 'add-site',
      start: 3,
      end: 9,
      reason: 'Privacy mode: email',
      why: 'Privacy mode: email',
    },
  ].map((h) => ({
    ...h,
    checkedBy: checked.has(h.id) ? 'u_sam' : null,
    checkedAt: checked.has(h.id) ? new Date().toISOString() : null,
  }))

/** The video as a demo: every version made from a recording, with its summary and Hidden list. */
async function withDemo(res: Response) {
  const v = (await res.json()) as { versions: Record<string, unknown>[] }
  return json(
    {
      ...v,
      versions: v.versions.map((ver) => ({
        ...ver,
        recording: {
          mediaId: 'med_screen_trace',
          trace: true,
          compose: false,
          privacy: true,
          summary: { sourceSec: 75, steps: 3, cutSec: 31, spedUpSec: 6, redactionsAdded: 1 },
          hidden: demoHidden(),
          // What the check of the rendered video still read (privacy mode): a warning, not a failure.
          privacyWarnings: [{ t: 12.4, kind: 'email', warning: 'An email may still be readable at 0:12' }],
        },
      })),
    },
    res.status,
  )
}
