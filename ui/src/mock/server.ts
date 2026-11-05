// Mock mode: answers /api/* from mock/data.ts by replacing window.fetch. Loaded only when VITE_MOCK=1.
import spec from '../api/openapi.json'
import type { paths } from '../api/schema'
import { applyEdits, applyNarration, type EditOp } from '../../../src/lib/contract'
import { isLanguage } from '../../../src/lib/language'
import type { NarrationOp, Span } from '../../../src/lib/timeline'
import plainHtml from '../../../test/fixtures/contract1/index.html?raw'
import musicHtml from '../../../test/fixtures/contract1-music/index.html?raw'
import contractSummary from '../../../test/fixtures/contract1/summary.json'
import voiceHtml from '../../../test/fixtures/contract1-voice/index.html?raw'
import voiceSummary from '../../../test/fixtures/contract1-voice/summary.json'
import voiceFile from '../../../test/fixtures/contract1-voice/assets/voice/voice.json'
import type { Video } from '../api/client'
import { MOCK_TRANSCRIPT, embed, people, stats, videos } from './data'
import { mockFile } from './files'
import { parseVtt, writeVtt, type VttCue } from '../../../src/lib/vtt'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
// Tests pick the sign-in provider with localStorage.mockAuthProvider (identity by default).
export const mockAuthProvider = (): 'identity' | 'netlify' => {
  try {
    return localStorage.getItem('mockAuthProvider') === 'netlify' ? 'netlify' : 'identity'
  } catch {
    return 'identity'
  }
}
// Tests switch roles with localStorage.mockRole (admin by default).
const mockRole = () => {
  try {
    return localStorage.getItem('mockRole') ?? 'admin'
  } catch {
    return 'admin'
  }
}
const me = {
  id: people.sam.id,
  email: people.sam.email,
  name: people.sam.name,
  get role() {
    return mockRole()
  },
  via: 'session',
}

interface MockComment {
  /** Notes posted together share one (POST …/comments/batch). */
  groupId?: string | null
  /** Library media attached to the comment. */
  mediaIds?: string[]
  id: string
  videoId: string
  versionN: number
  author: { id: string; name: string | null; email: string | null }
  body: string
  timeSec: number | null
  x: number | null
  y: number | null
  createdAt: string
  editedAt: string | null
  resolvedAt: string | null
  resolvedBy: null
  addressedInN: number | null
  unread?: boolean
}
// Connected OAuth apps (MCP OAuth is on in mock mode unless localStorage.mockOAuth is '0').
const mockMissingSettings = () => {
  try {
    return (localStorage.getItem('mockMissingSettings') ?? '')
      .split(',')
      .filter((s): s is 'RUNNER_API_TOKEN' | 'ALLOWED_EMAIL_DOMAINS' | 'ADMIN_EMAILS' =>
        ['RUNNER_API_TOKEN', 'ALLOWED_EMAIL_DOMAINS', 'ADMIN_EMAILS'].includes(s),
      )
  } catch {
    return []
  }
}
const mockOAuth = () => {
  try {
    return localStorage.getItem('mockOAuth') !== '0'
  } catch {
    return true
  }
}
function mockYouTube(): 'connected' | 'unconnected' | null {
  try {
    const v = localStorage.getItem('mockYouTube')
    return v === 'unconnected' ? 'unconnected' : v ? 'connected' : null
  } catch {
    return null
  }
}
let mockYtConnected = mockYouTube() === 'connected'
// Admin settings (GET/PATCH /api/v1/admin/settings); localStorage.mockNarrationOff starts with recording off.
const adminSettings: {
  narrationEnabled: boolean
  transcriptionProvider: 'local' | 'elevenlabs' | 'off'
  takeQuotaBytes: number
  recordingQuotaBytes: number
  remixEnabled: boolean
  youtubeEnabled: boolean
  youtubeConfigured: boolean
} = {
  narrationEnabled: (() => {
    try {
      return localStorage.getItem('mockNarrationOff') !== '1'
    } catch {
      return true
    }
  })(),
  transcriptionProvider: 'local',
  takeQuotaBytes: 2 * 1024 ** 3,
  recordingQuotaBytes: 2 * 1024 ** 3,
  // localStorage.mockRemixOff = '1' starts with remixing turned off.
  remixEnabled: (() => {
    try {
      return localStorage.getItem('mockRemixOff') !== '1'
    } catch {
      return true
    }
  })(),
  // localStorage.mockYouTube = '1' sets YouTube up and turns it on (with a connected channel unless it's 'unconnected').
  youtubeEnabled: mockYouTube() !== null,
  youtubeConfigured: mockYouTube() !== null,
}
const grants = [
  {
    id: 'grt_claude',
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    clientName: 'Claude',
    createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  },
  {
    id: 'grt_cursor',
    clientId: 'nvc_cursor',
    clientName: 'Cursor',
    createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
    lastUsedAt: null,
  },
]

// Ada left two comments on Sam's teaser; one is unread.
const comments: MockComment[] = [
  {
    id: 'c_1',
    videoId: 'vid_teaser',
    versionN: 2,
    author: people.ada,
    body: 'The logo here is too small to read on a phone.',
    timeSec: 1.5,
    x: 0.25,
    y: 0.3,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    editedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    addressedInN: null,
  },
  {
    id: 'c_2',
    videoId: 'vid_teaser',
    versionN: 2,
    author: people.marco,
    body: 'Love the end card.',
    timeSec: null,
    x: null,
    y: null,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    editedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    addressedInN: null,
    unread: true,
  },
]
const commentDto = (c: MockComment) => {
  const owner = videos.find((v) => v.id === c.videoId)?.owner.id === me.id
  const mine = c.author.id === me.id
  const moderate = me.role === 'admin' || (owner && me.role === 'creator')
  return {
    ...c,
    groupId: c.groupId ?? null,
    mediaIds: undefined,
    attachments: (c.mediaIds ?? []).flatMap((id) => {
      const m = mockMedia.find((x) => x.id === id)
      return m
        ? [
            {
              id: m.id,
              kind: m.kind,
              filename: m.filename,
              title: m.title,
              url: m.urls?.file ?? null,
              poster: m.urls?.poster ?? null,
            },
          ]
        : []
    }),
    unread: undefined,
    can: { edit: mine && me.role !== 'viewer', delete: mine || moderate, resolve: moderate },
  }
}
/**
 * localStorage.mockFinish=ready|failed: the in-progress video's run ends on the second read of it after this is set
 * (so a poll, not the page's first load, sees it end), ready with another video's files or failed.
 */
let finishReads = 0
function stepMockFinish(id: string) {
  let how: string | null
  try {
    how = localStorage.getItem('mockFinish')
  } catch {
    how = null
  }
  const vid = videos.find((x) => x.id === id)
  const latest = vid?.versions[0]
  if (id !== 'vid_making' || (how !== 'ready' && how !== 'failed') || !vid || latest?.status !== 'running')
    return
  if (++finishReads < 2) return
  const done = videos.flatMap((x) => x.versions).find((x) => x.status === 'ready' && x.output)
  const endedAt = new Date().toISOString()
  vid.versions[0] =
    how === 'ready' && done
      ? {
          ...latest,
          status: 'ready',
          stage: 'ready',
          output: done.output,
          links: done.links,
          files: done.files,
        }
      : {
          ...latest,
          status: 'failed',
          stage: 'failed',
          error: { category: 'needs_input', message: 'The agent stopped to ask a question.' },
        }
  if (latest.timings) vid.versions[0].timings = { ...latest.timings, endedAt }
  vid.status = vid.versions[0].status
}
/**
 * localStorage.mockMusic=searching|picked|library: the in-progress video is finding music before its run, or has found
 * it (on Openverse, or in the library after Openverse found none).
 */
function mockMusic(): 'searching' | 'picked' | 'library' | null {
  try {
    const m = localStorage.getItem('mockMusic')
    return m === 'searching' || m === 'picked' || m === 'library' ? m : null
  } catch {
    return null
  }
}
const withMusic = <T extends { id: string; versions: Video['versions'] }>(v: T): T => {
  const m = mockMusic()
  const latest = v.versions[0]
  if (!m || v.id !== 'vid_making' || latest?.status !== 'running') return v
  const music = {
    status: m === 'searching' ? m : 'picked',
    query: m === 'library' ? 'corporate' : 'upbeat electronic',
    title: m === 'picked' ? 'Bright Horizons' : m === 'library' ? 'Quiet Lake' : null,
    mediaId: m === 'searching' ? null : 'med_music_auto',
    reason: null,
    source: m === 'searching' ? null : m === 'library' ? 'library' : 'openverse',
    tried:
      m === 'library'
        ? ['upbeat electronic', 'background instrumental', 'corporate'].map((query) => ({
            query,
            outcome: 'failed',
          }))
        : [{ query: 'upbeat electronic', outcome: m === 'picked' ? 'chosen' : 'searching' }],
  }
  return {
    ...v,
    versions: [
      { ...latest, sound: 'music', stage: 'finding_music', latestStep: null, music },
      ...v.versions.slice(1),
    ],
  }
}
const withComments = <
  T extends { id: string; versions: Video['versions']; comments: { count: number; unread: number } },
>(
  v: T,
): T => {
  const mine = comments.filter((c) => c.videoId === v.id)
  return withMusic({ ...v, comments: { count: mine.length, unread: mine.filter((c) => c.unread).length } })
}
const readBody = async (init?: RequestInit, input?: RequestInfo | URL) => {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body) as Record<string, unknown>
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>
  } catch {
    // no body
  }
  return {}
}

interface MockDest {
  id: string
  name: string
  url: string
  enabled: boolean
  optionsSchema: unknown
  capabilities: Record<string, unknown>
  sharePublisherContact: boolean
  createdAt: string
}
const siteName = (o: unknown) => {
  const n = o && typeof o === 'object' ? (o as Record<string, unknown>).name : undefined
  return typeof n === 'string' && n ? n : 'acme-video'
}
/** Destinations an admin added in this mock session. */
const mockAdminDest: MockDest[] = []
const mockSecrets = new Map<string, string>()
const adminDestDto = (d: MockDest) => ({
  id: d.id,
  name: d.name,
  url: d.url,
  enabled: d.enabled,
  optionsSchema: d.optionsSchema,
  capabilities: d.capabilities,
  sharePublisherContact: d.sharePublisherContact,
  revision: 1,
  createdAt: d.createdAt,
  updatedAt: d.createdAt,
  live: 0,
  failed: 0,
})
/** The demo destination (localStorage.mockDestinations) plus the ones added in Admin. */
function mockDestRows(): MockDest[] {
  let demo: MockDest[] = []
  try {
    if (localStorage.getItem('mockDestinations'))
      demo = [
        {
          id: 'dst_sites',
          name: 'Netlify site',
          url: 'https://receiver.example.com/video-agent',
          enabled: true,
          optionsSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', title: 'Site name', maxLength: 40 },
              password: { type: 'boolean', title: 'Password-protect the site', default: false },
            },
          },
          capabilities: {
            targets: true,
            targetNoun: 'site',
            instructions: true,
            instructionsLabel: 'Where should the video go?',
            instructionsHint:
              'An agent will edit the site to place it. Leave empty to use the standard layout.',
          },
          sharePublisherContact: false,
          createdAt: new Date().toISOString(),
        },
      ]
  } catch {
    // no storage
  }
  return [...demo, ...mockAdminDest]
}

export function installMock() {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    )
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const p = url.pathname
    // The editor reads the draft's composition from its preview link (the frame itself loads the stand-in page).
    if (p === '/mock-preview/contract.html' && mockEdit)
      return new Response(mockEditHtml ?? contractHtml(), { headers: { 'content-type': 'text/html' } })
    if (!p.startsWith('/api/')) return real(input, init)
    await new Promise((r) => setTimeout(r, 120))
    // JSON bodies the app sent, by path (window.__sent), so tests can check what a form submitted.
    const sent =
      input instanceof Request
        ? input.headers.get('content-type')
        : typeof init?.body === 'string'
          ? 'json'
          : ''
    if (method !== 'GET' && sent?.includes('json')) {
      const w = window as unknown as { __sent?: Record<string, unknown> }
      try {
        const text =
          input instanceof Request
            ? await input.clone().text()
            : typeof init?.body === 'string'
              ? init.body
              : ''
        w.__sent = { ...w.__sent, [p]: JSON.parse(text) as unknown }
      } catch {
        // not JSON
      }
    }
    if (p === '/api/health') {
      return json({
        ok: true,
        ready: true,
        checks: [
          {
            id: 'admission',
            label: 'Who can sign up',
            status: 'ok',
            detail: 'Confirmed emails at acme.com.',
          },
          { id: 'admins', label: 'First admins', status: 'ok', detail: 'sam@acme.com' },
          {
            id: 'identity-registration',
            label: 'Identity registration',
            status: 'ok',
            detail: 'Open (sign-ups are filtered by domain).',
          },
          {
            id: 'identity-autoconfirm',
            label: 'Email confirmation',
            status: 'ok',
            detail: 'People must confirm their email.',
          },
          { id: 'runner-token', label: 'Run token (RUNNER_API_TOKEN)', status: 'ok', detail: 'Set.' },
          { id: 'agent-runners', label: 'Agent Runners', status: 'ok', detail: 'Available.' },
          { id: 'database', label: 'Database', status: 'ok', detail: 'Connected and migrated.' },
          {
            id: 'context',
            label: 'Company context',
            status: 'warn',
            detail: 'context/ still has the neutral default.',
            fix: 'Edit context/BRAND.md and context/brand.json, add your logo to context/assets/, and push.',
          },
          {
            id: 'secure-context',
            label: 'HTTPS for recording',
            status: 'ok',
            detail: 'Served over HTTPS, so people can record their own voice-over.',
          },
        ],
      })
    }
    if (p === '/api/openapi.json') return json(spec)
    // Plan it first (plan v2 §4): a router that asks two questions, then a brief.
    if (p === '/api/v1/plans' && method === 'POST') {
      // The plan remembers a voice-over, so the brief gets a narration line per beat.
      const b = await readBody(init, input)
      const vo = b.voiceover as
        { enabled?: boolean; voice?: string; speed?: number; script?: string[] } | undefined
      mockVoice = vo?.enabled
        ? { voice: vo.voice ?? null, speed: vo.speed ?? null, script: vo.script ?? null }
        : null
      const prompt = typeof b.prompt === 'string' ? b.prompt : ''
      mockAudio = {
        ...(b.sound === undefined ? { sound: /music|soundtrack/i.test(prompt) ? 'music' : 'silent' } : {}),
        ...(vo?.enabled ? {} : { voiceover: /voice-?over|narrat/i.test(prompt) }),
      }
      const ro = b.remixOf as { videoId: string; version?: number } | undefined
      mockRemixPlan = ro ? { videoId: ro.videoId, version: ro.version ?? 1 } : null
      return json(mockPlan(), 201)
    }
    if (/^\/api\/v1\/plans\/[^/]+\/questions$/.test(p)) return json(mockPlan('questions'))
    if (/^\/api\/v1\/plans\/[^/]+\/brief$/.test(p)) return json(mockPlan('brief'))
    if (/^\/api\/v1\/plans\/[^/]+$/.test(p) && method === 'PATCH')
      return json({ ...mockPlan('brief'), briefRev: 2 })
    if (p === '/api/v1/me/usage')
      return json({
        since: new Date().toISOString().slice(0, 8) + '01T00:00:00.000Z',
        runs: { credits: 312, videos: 3, unknown: false },
        planning: { credits: 6.4, calls: 9, unknown: 0 },
      })
    if (p === '/api/v1/notifications') return json({ items: [], unreadCount: 0, nextCursor: null })
    if (p === '/api/v1/config')
      return json({
        version: { commit: null, promptTemplate: 16, release: null },
        features: [
          ...(adminSettings.remixEnabled ? ['remix'] : []),
          ...(adminSettings.narrationEnabled ? ['narration'] : []),
          'planning',
          'destinations',
          ...(adminSettings.youtubeEnabled ? ['youtube'] : []),
        ],
        admission: ['acme.com'],
        siteUrl: window.location.origin,
        planningAvailable: true,
        mcpOAuth: mockOAuth(),
        authProvider: mockAuthProvider(),
        requiredTeams: mockAuthProvider() === 'netlify' ? ['acme'] : [],
        narrationEnabled: adminSettings.narrationEnabled,
        remixEnabled: adminSettings.remixEnabled,
        youtubeAvailable: adminSettings.youtubeEnabled,
        // localStorage.mockMissingSettings = 'RUNNER_API_TOKEN,ADMIN_EMAILS' shows the not-set-up notices.
        missingSettings: mockMissingSettings(),
      })
    if (p === '/api/v1/oauth/grants')
      return mockOAuth() ? json(grants) : fail(404, 'not_found', 'OAuth is not enabled on this video agent.')
    const grant = /^\/api\/v1\/oauth\/grants\/([^/]+)$/.exec(p)
    if (grant && method === 'DELETE') {
      const i = grants.findIndex((g) => g.id === grant[1])
      if (i < 0) return fail(404, 'not_found', 'Connected app not found.')
      grants.splice(i, 1)
      return new Response(null, { status: 204 })
    }
    if (p === '/api/v1/me') return json(me)
    if (p === '/api/v1/stats') return json(stats)
    if (p === '/api/v1/admin/settings') {
      if (method === 'PATCH') Object.assign(adminSettings, await readBody(init, input))
      return json(adminSettings)
    }
    if (p === '/api/v1/users') {
      return json(
        Object.values(people).map((u, i) => ({
          ...u,
          role: i === 0 ? 'admin' : 'creator',
          admittedVia: 'domain',
          createdAt: new Date(Date.now() - (30 - i * 6) * 86400_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
          disabled: false,
          signInMethods: i === 0 ? ['identity', 'netlify'] : i % 2 ? ['netlify'] : ['identity'],
        })),
      )
    }
    if (p === '/api/v1/keys') {
      if (method === 'POST')
        return json(
          {
            id: 'key_new',
            name: 'Release pipeline',
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            key: 'nva_key_new_3f9c…',
            webhookSecret: 'whsec_9b1e…',
          },
          201,
        )
      return json([
        {
          id: 'key_ci',
          name: 'Release pipeline',
          createdAt: new Date(Date.now() - 6 * 86400_000).toISOString(),
          lastUsedAt: new Date(Date.now() - 3600_000).toISOString(),
          revokedAt: null,
        },
        {
          id: 'key_e2e',
          name: 'e2e',
          createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          lastUsedAt: new Date(Date.now() - 64 * 60_000).toISOString(),
          revokedAt: null,
        },
      ])
    }
    if (p === '/api/v1/videos' && method === 'GET') {
      const q = url.searchParams.get('q')?.toLowerCase()
      const status = url.searchParams.get('status')
      const owner = url.searchParams.get('owner')
      let items = videos
      if (q)
        items = items.filter(
          (v) =>
            v.title.toLowerCase().includes(q) || v.versions.some((x) => x.prompt.toLowerCase().includes(q)),
        )
      if (status) items = items.filter((v) => v.status === status)
      if (owner === 'me') items = items.filter((v) => v.owner.id === me.id)
      if (url.searchParams.get('favorite') === 'true') items = items.filter((v) => v.favorite)
      return json({ items: items.map(withComments), nextCursor: null })
    }
    const fav = /^\/api\/v1\/videos\/([^/]+)\/favorite$/.exec(p)
    if (fav?.[1] && (method === 'PUT' || method === 'DELETE')) {
      const found = videos.find((x) => x.id === fav[1])
      if (!found) return json({ error: { code: 'not_found', message: 'Video not found.' } }, 404)
      found.favorite = method === 'PUT'
      return new Response(null, { status: 204 })
    }
    // Live progress (plan v2 §6): the step moves on with every poll; localStorage.mockStale marks it stale.
    const pg = /^\/api\/v1\/videos\/([^/]+)\/progress$/.exec(p)
    if (pg?.[1]) {
      const w = window as unknown as { __progressCalls?: number }
      w.__progressCalls = (w.__progressCalls ?? 0) + 1
      const found = videos.find((x) => x.id === pg[1])
      const vid = found && withMusic(found)
      const latest = vid?.versions[0]
      const steps = [
        'Reading context/',
        'Writing the composition',
        'Writing the end card',
        'Checking, round 2',
      ]
      let stale = false
      let render = false
      let live = false
      try {
        stale = localStorage.getItem('mockStale') === '1'
        render = localStorage.getItem('mockRender') === '1' || pictureRender?.n === latest?.n
        live = localStorage.getItem('mockLive') === '1'
      } catch {
        // private mode
      }
      return json({
        attemptId: latest ? `att_${vid.id}_${latest.n}` : null,
        versionN: latest?.n ?? null,
        stage: latest?.stage ?? null,
        music: latest?.music ?? null,
        step: latest?.stage === 'finding_music' ? null : steps[(w.__progressCalls - 1) % steps.length],
        steps: 10 + w.__progressCalls,
        credits: 30 + w.__progressCalls * 2,
        observedAt: new Date(Date.now() - (stale ? 90_000 : 2000)).toISOString(),
        stale,
        checkpoint: live
          ? {
              seq: Math.ceil(w.__progressCalls / 3),
              message: 'Writing the end card',
              renderPercent: null,
              at: new Date().toISOString(),
              hasBundle: true,
            }
          : render
            ? {
                seq: w.__progressCalls,
                message: 'Rendering',
                renderPercent: Math.min(99, 40 + w.__progressCalls * 5),
                at: new Date().toISOString(),
                hasBundle: false,
              }
            : null,
      })
    }
    // Media library (plan v2 §9): in memory. localStorage.mockFailPart=1 fails one part once, to test resume.
    // A version's library media (the Remix dialog's chips): the webhooks launch used the first library item.
    const vmedia = /^\/api\/v1\/videos\/([^/]+)\/versions\/\d+\/media$/.exec(p)
    if (vmedia?.[1] && method === 'GET') {
      if (vmedia[1] !== 'vid_webhooks') return json({ items: [] })
      let logo = mockMedia.find((m) => m.id === 'med_logo01')
      if (!logo) {
        logo = { ...mockItem('Acme logo.png', 'image', 42_000), id: 'med_logo01' }
        mockMedia.push(logo)
      }
      return json({ items: [logo] })
    }
    if (p === '/api/v1/media' && method === 'GET') {
      seedLibraryMusic()
      seedRecordings()
      const kind = url.searchParams.get('kind')
      // Recordings: the caller's own only (the mock's seeded ones are all Sam's), or none of them.
      const recordings = url.searchParams.get('recordings') ?? 'include'
      // Search and sort as the server does: every word somewhere in the name, file name or notes.
      const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const sort = url.searchParams.get('sort') ?? 'newest'
      const name = (m: MockMedia) => (m.title ?? m.filename).toLowerCase()
      const items = mockMedia
        .filter((m) => !kind || m.kind === kind)
        .filter((m) =>
          recordings === 'only' ? m.recording !== null : recordings !== 'exclude' || m.recording === null,
        )
        .filter((m) => !m.recording || m.uploader.id === me.id)
        .filter((m) =>
          words.every((w) => [m.title, m.filename, m.caption].some((f) => f?.toLowerCase().includes(w))),
        )
      if (sort === 'oldest') items.reverse()
      if (sort === 'name') items.sort((a, b) => name(a).localeCompare(name(b)))
      return json({ items, nextCursor: null })
    }
    if (p === '/api/v1/media' && method === 'POST') {
      if (me.role === 'viewer' || me.role === 'reviewer')
        return fail(403, 'forbidden', `Your role (${me.role}) can't upload media.`)
      if (url.searchParams.has('role'))
        return fail(
          400,
          'invalid_request',
          'Recordings upload in a session: POST /api/v1/media/uploads with role and scopeJobId.',
        )
      const body = new Uint8Array(
        await (input instanceof Request
          ? input.clone().arrayBuffer()
          : new Response(init?.body as BodyInit).arrayBuffer()),
      )
      const name = url.searchParams.get('filename') ?? 'upload'
      const kind = mockKind(body)
      if (!kind)
        return fail(
          400,
          'invalid_request',
          'Upload PNG, JPEG, WebP or SVG images, MP4 clips, MP3, M4A, WAV, Ogg or WebM audio, WOFF2, TTF or OTF fonts, or PDFs.',
        )
      const m = mockItem(name, kind, body.byteLength)
      mockMedia.unshift(m)
      return json(m, 201)
    }
    // Duplicates: the mock keeps no hashes, so it matches by name (a different file with the same name).
    if (p === '/api/v1/media/check' && method === 'POST') {
      const b = (await readBody(init, input)) as { files: { filename: string; sha256: string }[] }
      return json({
        files: b.files.map((f) => ({
          ...f,
          sameFile: null,
          sameName: mockMedia.find((m) => m.filename === f.filename) ?? null,
        })),
      })
    }
    if (p === '/api/v1/media/uploads' && method === 'POST') {
      const b = (await readBody(init, input)) as {
        filename: string
        size: number
        role?: 'narration-take' | 'narration-upload'
        scopeJobId?: string
      }
      if (b.role && !b.scopeJobId)
        return fail(400, 'invalid_request', 'A recording needs scopeJobId: the video it is recorded for.')
      const s = {
        id: `upl_${mockUploads.size + 1}`,
        filename: b.filename,
        size: b.size,
        partSize: 4 * 1024 * 1024,
        partCount: Math.ceil(b.size / (4 * 1024 * 1024)),
        uploaded: [] as number[],
        status: 'open',
        mediaId: null as string | null,
        error: null,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        role: b.role ?? null,
        scopeJobId: b.role ? (b.scopeJobId ?? null) : null,
      }
      mockUploads.set(s.id, s)
      return json(s, 201)
    }
    const up = /^\/api\/v1\/media\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/.exec(p)
    if (up?.[1]) {
      const s = mockUploads.get(up[1])
      if (!s) return fail(404, 'not_found', 'Upload not found.')
      if (up[2] !== undefined) {
        const w = window as unknown as { __parts?: number }
        w.__parts = (w.__parts ?? 0) + 1
        let failOnce = false
        try {
          failOnce = Number(up[2]) === 1 && localStorage.getItem('mockFailPart') === '1'
          if (failOnce) localStorage.removeItem('mockFailPart')
        } catch {
          // ignore
        }
        if (failOnce) return fail(500, 'internal', 'Network hiccup.')
        if (!s.uploaded.includes(Number(up[2]))) s.uploaded.push(Number(up[2]))
        return json({ idx: Number(up[2]), sha256: 'x', duplicate: false })
      }
      if (up[3]) {
        // The real server reads the bytes; the mock goes by the file name.
        const ext = s.filename.split('.').pop()?.toLowerCase() ?? ''
        const kind: MockKind =
          ext === 'pdf'
            ? 'pdf'
            : ext === 'svg'
              ? 'svg'
              : ['png', 'jpg', 'jpeg', 'webp'].includes(ext)
                ? 'image'
                : ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'webm'].includes(ext)
                  ? 'audio'
                  : ['woff2', 'woff', 'ttf', 'otf'].includes(ext)
                    ? 'font'
                    : 'video'
        const m = mockItem(s.filename, kind, s.size)
        if (s.role)
          m.recording = {
            role: s.role,
            videoId: s.scopeJobId,
            usedIn: [],
            retainUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
          }
        mockMedia.unshift(m)
        s.status = 'done'
        s.mediaId = m.id
        return json(s, 202)
      }
      return json(s)
    }
    if (p === '/api/v1/media/openverse/search' && method === 'GET') {
      if (me.role === 'viewer' || me.role === 'reviewer')
        return fail(403, 'forbidden', `Your role (${me.role}) can't upload media.`)
      let busy = false
      try {
        busy = localStorage.getItem('mockOpenverseBusy') === '1'
      } catch {
        // ignore
      }
      if (busy) return fail(429, 'rate_limited', 'Openverse is busy, try again in a minute.')
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const cc0Only = url.searchParams.get('license') === 'cc0'
      // The common searches are kept warm on the server, so they answer at once even when Openverse is slow.
      if (mockOpenverseSlow() && !MOCK_COMMON.includes(q)) return mockJobStart('search', { q, cc0Only })
      return json(mockSearch(q, cc0Only, true))
    }
    if (p === '/api/v1/media/openverse/common' && method === 'GET') return json({ queries: MOCK_COMMON })
    if (p === '/api/v1/media/openverse/library' && method === 'GET') {
      seedLibraryMusic()
      const words = (url.searchParams.get('q') ?? '')
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 1 && w !== 'music')
      const text = (m: MockMedia) =>
        [m.filename, m.caption ?? '', m.source?.title ?? '', m.source?.creator ?? ''].join(' ').toLowerCase()
      const items = mockMedia.filter((m) => m.kind === 'audio' && words.some((w) => text(m).includes(w)))
      return json({ items })
    }
    if (p === '/api/v1/media/openverse/import' && method === 'POST') {
      const b = (await readBody(init, input)) as { id: string }
      if (!mockTracks.some((t) => t.id === b.id))
        return fail(404, 'not_found', "That track isn't on Openverse (any more).")
      const existing = mockMedia.find((m) => m.source?.id === b.id)
      if (mockOpenverseSlow() && !existing) return mockJobStart('import', { id: b.id })
      const r = mockImport(b.id)
      if (!r) return fail(404, 'not_found', "That track isn't on Openverse (any more).")
      return json(r.item, r.created ? 201 : 200)
    }
    const oj = /^\/api\/v1\/media\/openverse\/jobs\/([^/]+)$/.exec(p)
    if (oj?.[1] && method === 'GET') {
      const j = mockJobs.get(oj[1])
      if (!j)
        return fail(404, 'not_found', 'Job not found. Jobs are kept for 30 minutes; start the search again.')
      // A job finishes on its second poll, unless Openverse is stuck (mockOpenverseSlow=stuck).
      j.polls++
      if (j.polls >= 2 && mockOpenverseSlow() !== 'stuck') {
        if (j.kind === 'search')
          return json(mockJob(j, 'done', { search: mockSearch(j.q ?? '', j.cc0Only ?? false) }))
        const r = mockImport(j.trackId ?? '')
        return json(mockJob(j, 'done', { media: r?.item ?? null, created: r?.created ?? null }))
      }
      return json(mockJob(j, 'running'))
    }
    // Recordings (plan 2026-11-02 §2.3): a video's are the caller's own plus the ones its versions use.
    const vr = /^\/api\/v1\/videos\/([^/]+)\/recordings$/.exec(p)
    if (vr?.[1] && method === 'GET') {
      seedRecordings()
      if (!videos.some((v) => v.id === vr[1])) return fail(404, 'not_found', 'Video not found.')
      if (me.role === 'reviewer' || me.role === 'viewer') return json({ items: [] })
      return json({
        items: mockMedia.filter(
          (m) =>
            m.recording &&
            (m.recording.videoId === vr[1] || m.recording.usedIn.some((u) => u.videoId === vr[1])) &&
            (m.uploader.id === me.id || m.recording.usedIn.some((u) => u.kind === 'version')),
        ),
      })
    }
    if (p === '/api/v1/media/recordings/delete-unused' && method === 'POST') {
      const unused = mockMedia.filter((m) => m.recording?.retainUntil && m.uploader.id === me.id)
      for (const m of unused) mockMedia.splice(mockMedia.indexOf(m), 1)
      return json({ deleted: unused.length })
    }
    const extra = /^\/api\/v1\/media\/([^/]+)\/(peaks|speech)$/.exec(p)
    if (extra?.[1]) {
      if (!mockMedia.some((m) => m.id === extra[1])) return fail(404, 'not_found', 'Media not found.')
      if (extra[2] === 'peaks') {
        if (method === 'PUT') {
          const body = new Uint8Array(
            await (input instanceof Request
              ? input.clone().arrayBuffer()
              : new Response(init?.body as BodyInit).arrayBuffer()),
          )
          mockPeaks.set(extra[1], body)
          return json({ mediaId: extra[1], bytes: body.byteLength, levels: body[5] ?? 0, samples: 0 })
        }
        const bytes = mockPeaks.get(extra[1])
        if (!bytes) return fail(404, 'not_found', 'No peaks for this recording yet.')
        return new Response(new Uint8Array(bytes), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      }
      if (method === 'PUT') {
        const b = await readBody(init, input)
        mockSpeech.set(extra[1], b)
        return json(b)
      }
      const speech = mockSpeech.get(extra[1])
      return speech ? json(speech) : fail(404, 'not_found', 'No speech spans for this recording yet.')
    }
    const mm = /^\/api\/v1\/media\/([^/]+)$/.exec(p)
    if (mm?.[1]) {
      const i = mockMedia.findIndex((m) => m.id === mm[1])
      const m = mockMedia[i]
      if (!m) return fail(404, 'not_found', 'Media not found.')
      if (method === 'DELETE') {
        mockMedia.splice(i, 1)
        return new Response(null, { status: 204 })
      }
      if (method === 'PATCH') {
        const b = (await readBody(init, input)) as { caption?: string | null; title?: string | null }
        if (b.caption !== undefined) m.caption = b.caption?.trim() || null
        if (b.title !== undefined) m.title = b.title?.trim() || null
      }
      return json(m)
    }
    // Narration soft lock (plan 2026-11-02 §2.7). localStorage.mockNarrationHolder=ada starts with Ada holding it;
    // window.__mockNarrationTakeOver('ada') has her take it over, so the next heartbeat is refused.
    const nl = /^\/api\/v1\/videos\/([^/]+)\/narration-lock(\/take-over)?$/.exec(p)
    if (nl?.[1]) {
      const lock = mockLock()
      const dto = () => ({
        videoId: nl[1],
        holder: lock.holder ? { ...lock.holder.who, since: lock.holder.since } : null,
        mine: lock.holder?.who.userId === me.id,
        draftId: lock.holder?.who.userId === me.id ? lock.holder.draftId : null,
        heartbeatAt: lock.holder ? new Date().toISOString() : null,
        expiresAt: lock.holder ? new Date(Date.now() + 120_000).toISOString() : null,
      })
      if (method === 'GET') return json(dto())
      if (method === 'DELETE') {
        if (lock.holder?.who.userId === me.id) lock.holder = null
        return new Response(null, { status: 204 })
      }
      const b = (await readBody(init, input)) as { draftId: string; heartbeat?: boolean }
      const mine = { userId: me.id, name: me.name }
      if (nl[2]) {
        const previous =
          lock.holder && lock.holder.who.userId !== me.id
            ? { ...lock.holder.who, since: lock.holder.since }
            : null
        lock.holder = { who: mine, since: new Date().toISOString(), draftId: b.draftId }
        return json({ lock: dto(), previous })
      }
      if (lock.holder && lock.holder.who.userId !== me.id) {
        const holder = { ...lock.holder.who, since: lock.holder.since }
        return json(
          {
            error: {
              code: 'narration_locked',
              message: b.heartbeat
                ? `${holder.name} took over the narration. Your draft is saved; you can render it or discard it.`
                : `${holder.name} is editing the narration.`,
              details: {
                holder,
                ...(b.heartbeat ? { takenOverBy: lock.holder.who, at: holder.since } : {}),
              },
            },
          },
          409,
        )
      }
      lock.holder ??= { who: mine, since: new Date().toISOString(), draftId: b.draftId }
      return json(dto())
    }
    // Editor (plan v2 §8): drafts run on the real patcher over the spike S8 fixture. window.__lastEditOps records saves.
    const ed = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/edits$/.exec(p)
    const edit = /^\/api\/v1\/edits\/([^/]+)(\/render|\/preview|\/rebase-narration)?$/.exec(p)
    if (ed?.[1] && method === 'POST') {
      mockEdit = mockEdit ?? newMockEdit(ed[1], Number(ed[2]))
      return json(mockEdit, mockEdit.rev === 0 ? 201 : 200)
    }
    if (edit?.[1] && mockEdit && edit[1] === mockEdit.id) {
      if (edit[2] === '/preview')
        return json({
          url: `${window.location.origin}/mock-preview/contract.html?draft=${mockEdit.rev}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          seq: mockEdit.rev,
        })
      // Rebase (plan 2026-11-02 §2.7): the narration moves onto the newer base, which is then the newest.
      if (edit[2] === '/rebase-narration') {
        const b = (await readBody(init, input)) as { toN: number }
        const track = mockEdit.ops.filter((o) => (o as { op: string }).op === 'narration')
        // The new base's picture is the draft's: nothing else is pending there.
        mockEdit = {
          ...mockEdit,
          baseN: b.toN,
          rev: 1,
          ops: track,
          composition: mockEdit.base,
          renderedN: null,
          narrationChanged: null,
        }
        return json(mockEdit, 201)
      }
      if (edit[2] === '/render') {
        const vid = videos.find((x) => x.id === mockEdit?.videoId)
        // The render's settings are kept for tests (window.__lastRender). A fit (plan 2026-11-02 §6.4) is refused
        // as the server refuses it: without recorded narration in the draft, or with a held frame or no narration.
        const body = await readBody(init, input)
        ;(window as unknown as { __lastRender?: unknown }).__lastRender = body
        const r = body as { mode?: string; holdFinalFrame?: boolean; excludeNarration?: boolean }
        if (r.mode === 'fit_to_narration') {
          if (r.holdFinalFrame || r.excludeNarration)
            return fail(
              400,
              'invalid_request',
              'Fitting the video to your narration retimes the visuals to it, so it neither holds the last frame nor leaves the narration out.',
            )
          if (!mockEdit.ops.some((o) => (o as { op: string }).op === 'narration'))
            return fail(
              400,
              'invalid_request',
              'Fitting the video to your narration needs recorded narration in the draft. Record or upload some first, or render with your visuals kept.',
            )
        }
        const w = window as unknown as { __rendered?: number }
        w.__rendered = (w.__rendered ?? 0) + 1
        if (!vid) return fail(404, 'not_found', 'Video not found.')
        // Render picture first (plan 2026-11-02 §2.1): a real new version, which polls of the video move along.
        if ((body as { excludeNarration?: boolean }).excludeNarration) {
          const n = startPictureRender(vid, mockEdit.baseN)
          mockEdit = { ...mockEdit, renderedN: n }
          return json(withComments(vid), 202)
        }
        return json({ ...withComments(vid), latestVersion: vid.versions.length + 1 }, 202)
      }
      if (method === 'DELETE') {
        mockEdit = null
        mockEditHtml = null
        return new Response(null, { status: 204 })
      }
      if (method === 'PUT') {
        const b = (await readBody(init, input)) as { rev: number; ops: EditOp[] }
        ;(window as unknown as { __lastEditOps?: unknown }).__lastEditOps = b.ops
        if (b.rev !== mockEdit.rev)
          return fail(409, 'conflict', 'This draft changed in another tab. Reload it to continue.')
        // Recorded narration (plan 2026-11-02 §6.1): at most one whole-track op, laid over the edited visuals with
        // each take's stored speech spans, as the server's buildRev does.
        const tracks = b.ops.filter(
          (o) => (o as { op: string }).op === 'narration',
        ) as unknown as NarrationOp[]
        if (tracks.length && !adminSettings.narrationEnabled)
          return fail(403, 'narration_disabled', 'Recorded voice-over is turned off on this site.')
        if (tracks.length > 1)
          return fail(400, 'invalid_request', 'A draft has one narration track: send one narration op.')
        const track = tracks[0] ?? null
        const missing = track?.clips.find(
          (c) => !mockMedia.some((m) => m.id === c.mediaId && m.kind === 'audio'),
        )
        if (missing)
          return fail(
            400,
            'invalid_request',
            `That edit can't be made: recording ${missing.mediaId} isn't available.`,
          )
        try {
          const out = applyEdits(
            contractHtml(),
            mockSummary(),
            b.ops.filter((o) => (o as { op: string }).op !== 'narration'),
            { palette: mockPalette, ...mockNarration() },
          )
          const spans = new Map<string, Span[]>()
          for (const c of track?.clips ?? []) {
            const speech = mockSpeech.get(c.mediaId) as { spans?: Span[] } | undefined
            if (speech?.spans) spans.set(c.mediaId, speech.spans)
          }
          mockEditHtml = track ? applyNarration(out.html, out.summary, track, spans).html : out.html
          mockEdit = { ...mockEdit, rev: mockEdit.rev + 1, ops: b.ops, composition: out.composition }
          return json(mockEdit)
        } catch (e) {
          return fail(400, 'invalid_request', `That edit can't be made: ${(e as Error).message}`)
        }
      }
      return json(mockEdit)
    }
    // Composition preview links (plan v2 §7): a stand-in page with the bridge protocol. Short-lived, so the renewal
    // path runs in tests; window.__previewLinks counts how many were minted.
    if (/^\/api\/v1\/videos\/[^/]+\/versions\/\d+\/preview$/.test(p)) {
      const w = window as unknown as { __previewLinks?: number }
      w.__previewLinks = (w.__previewLinks ?? 0) + 1
      const live = url.searchParams.get('live') === '1'
      return json({
        url: `${window.location.origin}/mock-preview/index.html?link=${w.__previewLinks}${live ? '&live=1' : ''}`,
        expiresAt: new Date(Date.now() + 62_000).toISOString(),
        seq: live ? w.__previewLinks : null,
      })
    }
    // Review (plan v2 §5). Several notes posted together share a groupId; the last body is kept for tests.
    const cb = /^\/api\/v1\/videos\/([^/]+)\/comments\/batch$/.exec(p)
    if (cb?.[1] && method === 'POST') {
      if (me.role === 'viewer') return fail(403, 'forbidden', "Your role (viewer) can't comment.")
      const b = (await readBody(init, input)) as {
        versionN?: number
        notes?: {
          body?: string
          timeSec?: number | null
          x?: number | null
          y?: number | null
          mediaIds?: string[]
        }[]
      }
      ;(window as unknown as { __lastBatch?: unknown }).__lastBatch = b
      const notes = b.notes ?? []
      const groupId = notes.length > 1 ? `g_${comments.length + 1}` : null
      const made = notes.map((n, i): MockComment => ({
        id: `c_${comments.length + 1 + i}`,
        groupId,
        videoId: cb[1] as string,
        versionN: Number(b.versionN),
        author: people.sam,
        body: (n.body ?? '').trim(),
        timeSec: n.timeSec ?? null,
        x: n.x ?? null,
        y: n.y ?? null,
        mediaIds: n.mediaIds ?? [],
        createdAt: new Date(Date.now() + i).toISOString(),
        editedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        addressedInN: null,
      }))
      comments.push(...made)
      return json({ items: made.map(commentDto) }, 201)
    }
    const cm = /^\/api\/v1\/videos\/([^/]+)\/comments(\/read)?$/.exec(p)
    if (cm?.[1] && cm[2]) {
      for (const c of comments) if (c.videoId === cm[1]) c.unread = false
      return new Response(null, { status: 204 })
    }
    if (cm?.[1] && method === 'GET') {
      const mine = comments.filter((c) => c.videoId === cm[1])
      return json({
        items: mine.map(commentDto),
        unreadCount: mine.filter((c) => c.unread).length,
        readAt: null,
        nextCursor: null,
      })
    }
    if (cm?.[1] && method === 'POST') {
      if (me.role === 'viewer') return fail(403, 'forbidden', "Your role (viewer) can't comment.")
      const b = await readBody(init, input)
      ;(window as unknown as { __lastComment?: unknown }).__lastComment = b
      const c: MockComment = {
        id: `c_${comments.length + 1}`,
        videoId: cm[1],
        versionN: Number(b.versionN),
        author: people.sam,
        body: typeof b.body === 'string' ? b.body.trim() : '',
        timeSec: (b.timeSec as number | undefined) ?? null,
        x: (b.x as number | undefined) ?? null,
        y: (b.y as number | undefined) ?? null,
        mediaIds: (b.mediaIds as string[] | undefined) ?? [],
        createdAt: new Date().toISOString(),
        editedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        addressedInN: null,
      }
      comments.push(c)
      return json(commentDto(c), 201)
    }
    const one = /^\/api\/v1\/comments\/([^/]+)$/.exec(p)
    if (one?.[1]) {
      const i = comments.findIndex((c) => c.id === one[1])
      const c = comments[i]
      if (!c) return fail(404, 'not_found', 'Comment not found.')
      if (method === 'DELETE') {
        comments.splice(i, 1)
        return new Response(null, { status: 204 })
      }
      const b = await readBody(init, input)
      if (typeof b.body === 'string') Object.assign(c, { body: b.body, editedAt: new Date().toISOString() })
      if (typeof b.resolved === 'boolean') c.resolvedAt = b.resolved ? new Date().toISOString() : null
      return json(commentDto(c))
    }
    // A picked poster: the mock keeps what was sent (window.__posterBody) and the DTO's poster field; the picture
    // stays the mock asset.
    const pm = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/poster$/.exec(p)
    if (pm?.[1] && (method === 'PUT' || method === 'DELETE')) {
      const vid = videos.find((x) => x.id === pm[1])
      const ver = vid?.versions.find((x) => x.n === Number(pm[2]))
      if (!vid || !ver) return fail(404, 'not_found', 'Video not found.')
      if (method === 'DELETE') {
        ver.poster = null
        return new Response(null, { status: 204 })
      }
      const b = (await readBody(init, input)) as { source: 'frame' | 'upload'; at?: number }
      ;(window as unknown as { __posterBody?: unknown }).__posterBody = b
      ver.poster = { source: b.source, at: b.source === 'frame' ? (b.at ?? 0) : null }
      return json(ver.poster)
    }
    const vm = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/verdict$/.exec(p)
    if (vm?.[1] && method === 'PUT') {
      const b = await readBody(init, input)
      const vid = videos.find((x) => x.id === vm[1])
      const ver = vid?.versions.find((x) => x.n === Number(vm[2]))
      if (!vid || !ver) return fail(404, 'not_found', 'Video not found.')
      const prev = ver.verdicts.mine
      const next = (b.verdict as 'approved' | 'changes_requested' | null) ?? null
      if (prev === 'approved') ver.verdicts.approved--
      if (prev === 'changes_requested') ver.verdicts.changesRequested--
      if (next === 'approved') ver.verdicts.approved++
      if (next === 'changes_requested') ver.verdicts.changesRequested++
      ver.verdicts.mine = next
      return json(withComments(vid))
    }
    if (p === '/api/v1/videos' && method === 'POST') return json(videos[0], 202)
    // Remix: a new queued video owned by "me", remixed from the source; the last request body is kept for tests.
    const rm = /^\/api\/v1\/videos\/([^/]+)\/remix$/.exec(p)
    if (rm?.[1] && method === 'POST') {
      const b = (await readBody(init, input)) as {
        prompt?: string
        fromVersion?: number
        aspect?: Video['aspect']
      }
      ;(window as unknown as { __lastRemix?: unknown }).__lastRemix = { sourceId: rm[1], ...b }
      if (!adminSettings.remixEnabled)
        return fail(409, 'remix_disabled', 'Remixing is turned off by an admin.')
      const src = videos.find((x) => x.id === rm[1])
      if (!src) return fail(404, 'not_found', 'Video not found.')
      const from = b.fromVersion ?? src.versions.find((x) => x.status === 'ready')?.n ?? 1
      const template = videos.find((x) => x.id === 'vid_queued') as Video
      const made: Video = {
        ...structuredClone(template),
        id: `vid_remix_${videos.length}`,
        title: (b.prompt ?? 'Remix').slice(0, 80),
        aspect: b.aspect ?? src.aspect,
        owner: { id: me.id, name: me.name, email: me.email },
        isRemix: true,
        remixOf: { id: src.id, n: from, title: src.title },
        favorite: false,
        createdAt: new Date().toISOString(),
      }
      made.versions = made.versions.map((x) => ({ ...x, prompt: b.prompt ?? x.prompt }))
      videos.unshift(made)
      return json(withComments(made), 202)
    }
    // Revise (and incorporate): the last request body is kept for tests.
    const rv = /^\/api\/v1\/videos\/([^/]+)\/versions$/.exec(p)
    if (rv?.[1] && method === 'POST') {
      const b = await readBody(init, input)
      ;(window as unknown as { __lastRevise?: unknown }).__lastRevise = b
      const vid = videos.find((x) => x.id === rv[1])
      return vid ? json(withComments(vid), 202) : fail(404, 'not_found', 'Video not found.')
    }
    // Narration captions and their corrections (POST: compare-and-swap on the revision, text-only).
    const cp = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/captions$/.exec(p)
    const capVer = cp?.[1]
      ? videos.find((x) => x.id === cp[1])?.versions.find((x) => x.n === Number(cp[2]))
      : null
    if (cp?.[1] && capVer?.captions) {
      const key = `${cp[1]}/${cp[2]}`
      const cues = (mockCues[key] ??= parseVtt(MOCK_CAPTIONS))
      if (method === 'GET')
        return new Response(writeVtt(cues), { headers: { 'content-type': 'text/vtt; charset=utf-8' } })
      if (method === 'POST') {
        const b = (await readBody(init, input)) as { expectedRev?: number; cues?: VttCue[] }
        if (b.expectedRev !== capVer.captions.rev)
          return fail(409, 'conflict', 'The captions changed since you opened them. Reload and try again.')
        const next = b.cues ?? []
        if (
          next.length !== cues.length ||
          next.some((c, i) => {
            const was = cues[i]
            return !was || c.id !== was.id || c.start !== was.start
          })
        )
          return fail(400, 'invalid_request', "A cue's id or timing changed: corrections change text only.")
        mockCues[key] = cues.map((c, i) => ({ ...c, text: next[i]?.text.trim() ?? c.text }))
        capVer.captions = { ...capVer.captions, rev: capVer.captions.rev + 1 }
        return json(capVer.captions)
      }
    }
    // Publish destinations (docs/plans/2026-11-04-publish-destinations.md §6): an HTTP destination with targets and
    // instructions when localStorage.mockDestinations is set, plus the ones an admin adds. A publication moves
    // queued → waiting → live on its own, like a receiver that answers 202 and calls back.
    if (p === '/api/v1/destinations' && method === 'GET') {
      const items = [
        {
          id: 'share_page',
          kind: 'share_page',
          name: 'Share page',
          ready: true,
          reason: null,
          capabilities: {
            targets: false,
            targetNoun: null,
            instructions: false,
            instructionsLabel: null,
            instructionsHint: null,
          },
          optionsSchema: null,
          unpublishOptionsSchema: null,
        },
        ...(adminSettings.youtubeEnabled
          ? [
              {
                id: 'youtube',
                kind: 'youtube',
                name: 'YouTube',
                ready: mockYtConnected,
                reason: mockYtConnected ? null : 'Connect YouTube first (API keys → Connected accounts).',
                capabilities: {
                  targets: false,
                  targetNoun: null,
                  instructions: false,
                  instructionsLabel: null,
                  instructionsHint: null,
                },
                optionsSchema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', title: 'Title', maxLength: 100 },
                    description: { type: 'string', title: 'Description', maxLength: 5000 },
                    privacy: {
                      type: 'string',
                      title: 'Privacy',
                      enum: ['unlisted', 'private', 'public'],
                      default: 'unlisted',
                    },
                    captions: { type: 'boolean', title: 'Also add captions', default: true },
                  },
                  required: ['title'],
                },
                unpublishOptionsSchema: null,
              },
            ]
          : []),
        ...mockDestRows()
          .filter((d) => d.enabled)
          .map((d) => ({
            id: d.id,
            kind: 'http',
            name: d.name,
            ready: true,
            reason: null,
            capabilities: {
              targets: d.capabilities.targets === true,
              targetNoun: (d.capabilities.targetNoun as string | undefined) ?? null,
              instructions: d.capabilities.instructions === true,
              instructionsLabel: (d.capabilities.instructionsLabel as string | undefined) ?? null,
              instructionsHint: (d.capabilities.instructionsHint as string | undefined) ?? null,
            },
            optionsSchema: d.optionsSchema,
            unpublishOptionsSchema: null,
          })),
      ]
      return json({ items })
    }
    const dt = /^\/api\/v1\/destinations\/([^/]+)\/targets$/.exec(p)
    if (dt?.[1] && method === 'GET') {
      const d = mockDestRows().find((x) => x.id === dt[1])
      if (!d?.capabilities.targets) return json({ targets: [], dropped: 0, noun: null, error: null })
      return json({
        targets: [
          {
            id: 'site-launch',
            name: 'acme-launch',
            description: '2 videos · updated yesterday',
            url: 'https://acme-launch.netlify.app',
            metadata: { videos: 2 },
          },
          {
            id: 'site-docs',
            name: 'acme-docs-demos',
            description: '1 video · updated last week',
            url: 'https://acme-docs-demos.netlify.app',
            metadata: { videos: 1 },
          },
        ],
        dropped: 0,
        noun: (d.capabilities.targetNoun as string | undefined) ?? null,
        error: null,
      })
    }
    if (p === '/api/v1/me/connections' && method === 'GET')
      return json({
        youtube: {
          configured: adminSettings.youtubeConfigured,
          available: adminSettings.youtubeEnabled,
          connectUrl: '/auth/google/start',
        },
        items: mockYtConnected
          ? [
              {
                id: 'dcon_mock',
                kind: 'youtube',
                account: 'Acme on YouTube',
                accountId: 'UCmock',
                status: 'ok',
                connectedAt: new Date().toISOString(),
              },
            ]
          : [],
      })
    if (p === '/api/v1/me/connections/dcon_mock' && method === 'DELETE') {
      mockYtConnected = false
      return new Response(null, { status: 204 })
    }
    const dpPub = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/destinations$/.exec(p)
    if (dpPub?.[1] && method === 'POST') {
      const vid = videos.find((x) => x.id === dpPub[1])
      const ver = vid?.versions.find((x) => x.n === Number(dpPub[2]))
      if (!vid || !ver) return fail(404, 'not_found', 'Video not found.')
      const b = await readBody(init, input)
      ;(window as unknown as { __lastDestPublish?: unknown }).__lastDestPublish = b
      if (b.destination === 'youtube') {
        const o = (b.options ?? {}) as Record<string, unknown>
        if (typeof o.title !== 'string' || !o.title) return fail(400, 'invalid_request', 'Give it a title.')
        const yt: Video['versions'][number]['destinations'][number] = {
          id: `dpub_yt${String(Math.random()).slice(2, 8)}`,
          kind: 'youtube',
          destination: { id: 'youtube', name: 'YouTube' },
          target: null,
          status: 'queued',
          desired: 'published',
          url: null,
          message: null,
          warnings: [],
          error: null,
          hasSecret: false,
          secretLabel: null,
          publishedAt: new Date().toISOString(),
          liveAt: null,
        }
        ver.destinations = [...ver.destinations, yt]
        setTimeout(() => Object.assign(yt, { status: 'waiting', message: 'Processing on YouTube' }), 500)
        setTimeout(
          () =>
            Object.assign(yt, {
              status: 'live',
              message: null,
              url: 'https://youtu.be/mockvid1',
              liveAt: new Date().toISOString(),
              warnings: ['The custom thumbnail needs a verified YouTube channel; YouTube picked one.'],
            }),
          1300,
        )
        return json(yt)
      }
      const d = mockDestRows().find((x) => x.id === b.destination)
      if (!d) return fail(404, 'not_found', 'Destination not found.')
      const target = (b.target as { id: string; name: string; url: string | null } | null | undefined) ?? null
      const entry: Video['versions'][number]['destinations'][number] = {
        id: `dpub_mock${String(Math.random()).slice(2, 8)}`,
        kind: 'http',
        destination: { id: d.id, name: d.name },
        target: target ? { name: target.name, url: target.url } : null,
        status: 'queued',
        desired: 'published',
        url: null,
        message: null,
        warnings: [],
        error: null,
        hasSecret: false,
        secretLabel: null,
        publishedAt: new Date().toISOString(),
        liveAt: null,
      }
      ver.destinations = [...ver.destinations, entry]
      const password = (b.options as Record<string, unknown> | undefined)?.password === true
      setTimeout(() => {
        Object.assign(entry, {
          status: 'waiting',
          message: b.instructions ? 'Agent is adding the video to the page' : 'Creating the site',
        })
      }, 500)
      setTimeout(() => {
        Object.assign(entry, {
          status: 'live',
          message: null,
          url: target?.url ?? `https://${siteName(b.options)}.netlify.app`,
          liveAt: new Date().toISOString(),
          ...(password ? { hasSecret: true, secretLabel: 'Site password' } : {}),
        })
        if (password) mockSecrets.set(entry.id, 'mock-password-4821')
      }, 1300)
      return json(entry)
    }
    const dpRow = /^\/api\/v1\/destination-publications\/([^/]+)(?:\/(retry|secret))?$/.exec(p)
    if (dpRow?.[1]) {
      const found = videos
        .flatMap((v) => v.versions)
        .flatMap((v) => v.destinations)
        .find((x) => x.id === dpRow[1])
      if (!found) return fail(404, 'not_found', 'Not found.')
      if (dpRow[2] === 'secret' && method === 'POST') {
        const value = mockSecrets.get(found.id)
        if (!value) return fail(410, 'gone', 'This secret was already shown, or it expired.')
        mockSecrets.delete(found.id)
        Object.assign(found, { hasSecret: false, secretLabel: null })
        return json({ label: 'Site password', value })
      }
      if (dpRow[2] === 'retry' && method === 'POST') {
        Object.assign(found, { status: 'queued', error: null })
        setTimeout(
          () =>
            Object.assign(found, {
              status: 'live',
              url: 'https://acme-video.netlify.app',
              liveAt: new Date().toISOString(),
            }),
          800,
        )
        return json(found)
      }
      if (!dpRow[2] && method === 'DELETE') {
        Object.assign(found, { status: 'removing', desired: 'removed', message: null })
        setTimeout(() => Object.assign(found, { status: 'removed' }), 600)
        return json(found)
      }
    }
    if (p === '/api/v1/admin/destinations' && method === 'GET')
      return json({ items: mockAdminDest.map(adminDestDto) })
    if (p === '/api/v1/admin/destinations' && method === 'POST') {
      const b = await readBody(init, input)
      if (typeof b.url !== 'string' || !b.url.startsWith('https://'))
        return fail(400, 'invalid_request', 'Destination URLs must use https.')
      const row: MockDest = {
        id: `dst_mock${mockAdminDest.length + 1}`,
        name: typeof b.name === 'string' ? b.name : '',
        url: b.url,
        enabled: true,
        optionsSchema: b.optionsSchema ?? null,
        capabilities: {},
        sharePublisherContact: b.sharePublisherContact === true,
        createdAt: new Date().toISOString(),
      }
      mockAdminDest.push(row)
      return json({ ...adminDestDto(row), secret: 'dsec_mock_shown_once_3f9a' }, 201)
    }
    const ad = /^\/api\/v1\/admin\/destinations\/([^/]+)(?:\/(rotate|test|remove-all))?$/.exec(p)
    if (ad?.[1]) {
      const row = mockAdminDest.find((x) => x.id === ad[1])
      if (!row) return fail(404, 'not_found', 'Destination not found.')
      if (ad[2] === 'rotate') return json({ ...adminDestDto(row), secret: 'dsec_mock_rotated_7c21' })
      if (ad[2] === 'test') {
        row.capabilities = { targets: true, targetNoun: 'site', instructions: true }
        return json({ ok: true, status: 200, capabilities: row.capabilities, error: null })
      }
      if (ad[2] === 'remove-all') return json({ removing: 0 })
      if (method === 'PATCH') {
        Object.assign(row, await readBody(init, input))
        return json(adminDestDto(row))
      }
      if (method === 'DELETE') {
        mockAdminDest.splice(mockAdminDest.indexOf(row), 1)
        return new Response(null, { status: 204 })
      }
    }
    // Publish and unpublish; the last publish body is kept for tests.
    const pb = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/publish$/.exec(p)
    if (pb?.[1] && (method === 'POST' || method === 'DELETE')) {
      const vid = videos.find((x) => x.id === pb[1])
      const ver = vid?.versions.find((x) => x.n === Number(pb[2]))
      if (!vid || !ver) return fail(404, 'not_found', 'Video not found.')
      if (method === 'DELETE') {
        for (const x of ver.publications) x.unpublishedAt ??= new Date().toISOString()
        return new Response(null, { status: 204 })
      }
      const b = await readBody(init, input)
      ;(window as unknown as { __lastPublish?: unknown }).__lastPublish = b
      const showTranscript = b.showTranscript === true
      const live = ver.publications.find((x) => !x.unpublishedAt)
      const slug = live?.slug ?? `mock${vid.id.slice(-4)}${ver.n}pub`
      const base = `${window.location.origin}/v/${slug}`
      const w = ver.output?.width ?? 1920
      const h = ver.output?.height ?? 1080
      const pub = {
        slug,
        versionN: ver.n,
        publishedAt: live?.publishedAt ?? new Date().toISOString(),
        unpublishedAt: null,
        showTranscript,
        urls: {
          page: base,
          mp4: `${base}.mp4`,
          poster: `${base}.jpg`,
          gif: `${base}.gif`,
          captions: `${base}.vtt`,
          ...(ver.links.narrationAudio ? { narration: `${base}.mp3` } : {}),
          ...(showTranscript && ver.links.transcript ? { transcript: `${base}.txt` } : {}),
        },
        embed: embed(slug, w, h, ver.credits),
      }
      ver.publications = [pub, ...ver.publications.filter((x) => x.slug !== slug)]
      return json(pub)
    }
    const nf = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/(narration-audio|transcript)$/.exec(p)
    if (nf?.[1] && method === 'GET') {
      const ver = videos.find((x) => x.id === nf[1])?.versions.find((x) => x.n === Number(nf[2]))
      if (!ver?.links.transcript) return fail(404, 'not_found', 'This version has no such file.')
      return nf[3] === 'transcript'
        ? new Response(MOCK_TRANSCRIPT, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
        : new Response(new Uint8Array(0), { headers: { 'content-type': 'audio/mpeg' } })
    }
    const m = /^\/api\/v1\/videos\/([^/]+)(?:\/versions\/(\d+)\/(video|poster|gif|captions))?$/.exec(p)
    if (m?.[1] && m[3])
      return Response.redirect(new URL(mockFile(m[1], m[3] as 'video'), window.location.origin).href, 302)
    if (m?.[1]) {
      stepPictureRender(m[1])
      if (method === 'GET') stepMockFinish(m[1])
      const v = videos.find((x) => x.id === m[1])
      if (v && method === 'PATCH') {
        const b = (await readBody(init, input)) as { title?: string; private?: boolean; language?: string }
        if (b.language !== undefined && !isLanguage(b.language))
          return fail(400, 'invalid_request', 'Unknown language.')
        if (b.title !== undefined) v.title = b.title.trim()
        if (b.private !== undefined) v.private = b.private
        if (b.language !== undefined) v.language = b.language
      }
      return v ? json(withComments(v)) : fail(404, 'not_found', 'Video not found.')
    }
    return fail(404, 'not_found', `Mock has no ${method} ${p}`)
  }
}

// A narrated version's captions as the render wrote them, and their corrections (per video and version).
const MOCK_CAPTIONS = writeVtt([
  { id: 'nc_mock00000001', start: 0.4, end: 3.2, text: 'Every pull request gets its own URL.' },
  { id: 'nc_mock00000002', start: 3.6, end: 7.8, text: 'Review the real site, not a screen shot.' },
  { id: 'nc_mock00000003', start: 8.2, end: 13.5, text: 'Merge with confidence. Book a demo.' },
])
const mockCues: Record<string, VttCue[]> = {}

let mockVoice: { voice: string | null; speed: number | null; script: string[] | null } | null = null
// What the mock planner takes from the request for settings left untouched (like the real one: the request wins).
let mockAudio: { sound?: 'silent' | 'music' | 'music_sfx'; voiceover?: boolean } = {}
const NARRATION = [
  'Every project used to need its own webhook.',
  'Now one org webhook covers them all.',
  'Read the docs to set it up.',
]

/** The remix the current mock plan is for, if any (POST /api/v1/plans remixOf). */
let mockRemixPlan: { videoId: string; version: number } | null = null
function mockPlan(stage: 'route' | 'questions' | 'brief' = 'route') {
  const questions = [
    {
      id: 'q1',
      question: 'Who is this video for?',
      why: 'It sets how technical the beats get.',
      options: [
        { id: 'a', label: 'Developers', description: 'Show the API', recommended: true },
        { id: 'b', label: 'Team leads', description: 'Show the outcome' },
      ],
      multiSelect: false,
      allowOther: true,
    },
    {
      id: 'q2',
      question: 'How should it end?',
      why: '',
      options: [
        { id: 'a', label: 'Read the docs', description: '' },
        { id: 'b', label: 'Start free', description: '' },
      ],
      multiSelect: false,
      allowOther: true,
    },
  ]
  return {
    id: 'plan_mock',
    prompt: 'mock',
    revisionOf: null,
    remixOf: mockRemixPlan,
    route: { needsQuestions: true, template: 'launch', suggestedAspect: null },
    questions: stage === 'route' ? null : questions,
    answers: stage === 'brief' ? [] : null,
    brief:
      stage === 'brief'
        ? {
            title: 'Org-wide webhooks in 30 seconds',
            goal: 'Announce org-wide webhooks',
            audience: 'Developers',
            keyMessage: 'One subscription covers every project',
            beats: [
              { text: 'The problem: a webhook per project', seconds: 8 },
              { text: 'Org webhooks: subscribe once', seconds: 14 },
              { text: 'End card: Read the docs', seconds: 8 },
            ].map((b, i) =>
              mockVoice || mockAudio.voiceover
                ? { ...b, narration: mockVoice?.script?.[i] ?? NARRATION[i] }
                : b,
            ),
            tone: 'Confident, plain',
            callToAction: 'Read the docs',
            mustInclude: ['logo'],
            avoid: [],
            ...mockAudio,
          }
        : null,
    briefRev: stage === 'brief' ? 1 : 0,
    voiceover: mockVoice,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }
}

/**
 * A Render picture first render (plan 2026-11-02 §2.1): v`n`, a copy of the base version that each poll of its
 * video moves on: queued, two polls running (Rendering N%), then ready.
 */
let pictureRender: { videoId: string; n: number; polls: number; ready: Video['versions'][number] } | null =
  null
function startPictureRender(vid: Video, baseN: number) {
  const base = vid.versions.find((x) => x.n === baseN) ?? vid.versions[0]
  const n = vid.versions.length + 1
  if (!base) return n
  const ready = {
    ...structuredClone(base),
    n,
    prompt: `Edited from v${baseN} in the browser.`,
    parentN: baseN,
    editedFromN: baseN,
    mode: 'render_unchanged' as const,
    createdAt: new Date().toISOString(),
    publications: [],
  }
  vid.versions.unshift({ ...ready, status: 'queued', stage: 'queued', output: null })
  vid.status = 'queued'
  vid.latestVersion = n
  pictureRender = { videoId: vid.id, n, polls: 0, ready }
  return n
}
function stepPictureRender(videoId: string) {
  const r = pictureRender
  const vid = videos.find((x) => x.id === videoId)
  if (r?.videoId !== videoId || !vid) return
  r.polls += 1
  const status = r.polls < 2 ? 'queued' : r.polls < 4 ? 'running' : 'ready'
  vid.versions[0] =
    status === 'ready'
      ? r.ready
      : { ...r.ready, status, stage: status, output: null, latestStep: 'Rendering' }
  vid.status = status
  if (status === 'ready') pictureRender = null
}

type MockPerson = { userId: string; name: string }
let narrationLock: { holder: { who: MockPerson; since: string; draftId: string } | null } | null = null
/** The mock's one narration lock (it's per video on the server; the mock edits one video at a time). */
function mockLock() {
  if (narrationLock) return narrationLock
  const key = localStorage.getItem('mockNarrationHolder') as keyof typeof people | null
  const who = key ? people[key] : undefined
  narrationLock = {
    holder: who
      ? {
          who: { userId: who.id, name: who.name },
          since: new Date(Date.now() - 10 * 60_000).toISOString(),
          draftId: 'their-draft',
        }
      : null,
  }
  const w = window as unknown as { __mockNarrationTakeOver?: (k: keyof typeof people) => void }
  w.__mockNarrationTakeOver = (k) => {
    const p = people[k]
    mockLock().holder = {
      who: { userId: p.id, name: p.name },
      since: new Date().toISOString(),
      draftId: 'their-draft',
    }
  }
  return narrationLock
}

const mockPalette = ['#0b0d10', '#f4f5f7', '#9aa3ad', '#14b8a6', '#ff5a1f']
type MockEdit = ReturnType<typeof newMockEdit>
let mockEdit: MockEdit | null = null
/** The draft's index.html as last saved (null: the version's own). */
let mockEditHtml: string | null = null
/**
 * localStorage.mockMusic=1 edits the copy of the fixture with a music layer, whose track is in the library;
 * localStorage.mockVoice=1 the copy that also has a voice-over in two beats.
 */
function contractHtml() {
  const voice = !!localStorage.getItem('mockVoice')
  // localStorage.mockCode: the opening scene has a syntax-highlighted code block, one field per line.
  if (localStorage.getItem('mockCode'))
    return plainHtml.replace(
      '<h1 class="title" data-va-text="intro-title" data-va-label="Headline">Org webhooks</h1>',
      `<h1 class="title" data-va-text="intro-title" data-va-label="Headline">Org webhooks</h1>
          <pre class="code"><span class="ln" data-va-text="code1" data-va-label="Code line 1">const ai = new Anthropic()</span>
<span class="ln" data-va-text="code2" data-va-label="Code line 2">  <span class="tk-prop">model</span>: <span class="tk-str">'claude-opus-4-8'</span>,</span>
<span class="ln" data-va-text="code3" data-va-label="Code line 3">})</span></pre>`,
    )
  if (!voice && !localStorage.getItem('mockMusic')) return plainHtml
  if (!mockMedia.some((m) => m.id === 'med_theme01'))
    mockMedia.push({ ...mockItem('Upbeat theme.mp3', 'audio', 2_400_000), id: 'med_theme01' })
  return voice ? voiceHtml : musicHtml
}
const mockSummary = () => (localStorage.getItem('mockVoice') ? voiceSummary : contractSummary)
/** The voiced fixture's spoken lines, as the server reads them from voice.json. */
const mockNarration = () =>
  localStorage.getItem('mockVoice')
    ? { narration: Object.fromEntries(voiceFile.beats.map((b) => [b.beat, b.text])) }
    : {}
function newMockEdit(videoId: string, baseN: number) {
  const base = applyEdits(contractHtml(), mockSummary(), [], mockNarration()).composition
  return {
    id: '00000000-0000-4000-8000-00000000ed17',
    videoId,
    baseN,
    rev: 0,
    ops: [] as EditOp[],
    composition: base,
    base,
    palette: mockPalette,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    renderedN: null as number | null,
    newerVersion: null,
    // localStorage.mockNarrationChanged=1: Ada changed the narration in a newer version 10 minutes ago.
    narrationChanged: localStorage.getItem('mockNarrationChanged')
      ? {
          inVersion: baseN + 1,
          by: { userId: people.ada.id, name: people.ada.name },
          at: new Date(Date.now() - 10 * 60_000).toISOString(),
          yoursReplaces: true,
        }
      : null,
  }
}

type MockMedia = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
const mockMedia: MockMedia[] = []
const mockUploads = new Map<
  string,
  {
    id: string
    filename: string
    size: number
    partSize: number
    partCount: number
    uploaded: number[]
    status: string
    mediaId: string | null
    error: null
    expiresAt: string
    role: 'narration-take' | 'narration-upload' | null
    scopeJobId: string | null
  }
>()
// A recording's peaks.bin and speech spans, by media id (PUT/GET /api/v1/media/{id}/peaks and /speech).
const mockPeaks = new Map<string, Uint8Array<ArrayBuffer>>()
const mockSpeech = new Map<string, unknown>()
type MockKind = MockMedia['kind']
function mockKind(b: Uint8Array): MockKind | null {
  const head = String.fromCharCode(...b.subarray(0, 12))
  if (head.startsWith('%PDF-')) return 'pdf'
  if (b[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'image'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image'
  if (head.startsWith('ID3') || head.startsWith('OggS') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return 'audio'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'audio'
  // EBML (WebM): audio only, as the real classifier takes it.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio'
  if (head.slice(4, 8) === 'ftyp') return 'video'
  if (head.startsWith('wOF2') || head.startsWith('OTTO')) return 'font'
  if (new TextDecoder().decode(b.subarray(0, 200)).includes('<svg')) return 'svg'
  return null
}
// Ids only go up: after a delete, the next upload still gets a new one.
let mockMediaSeq = 0
function mockItem(filename: string, kind: MockKind, bytes: number): MockMedia {
  mockMediaSeq = Math.max(mockMediaSeq, mockMedia.length) + 1
  const id = `med_mock${String(mockMediaSeq).padStart(4, '0')}`
  return {
    id,
    kind,
    status: 'ready',
    rejectReason: null,
    filename,
    title: null,
    caption: null,
    mime:
      kind === 'video'
        ? 'video/mp4'
        : kind === 'pdf'
          ? 'application/pdf'
          : kind === 'svg'
            ? 'image/svg+xml'
            : kind === 'audio'
              ? 'audio/mpeg'
              : 'image/png',
    bytes,
    width: kind === 'font' || kind === 'audio' || kind === 'pdf' ? null : 1920,
    height: kind === 'font' || kind === 'audio' || kind === 'pdf' ? null : 1080,
    durationSec: kind === 'video' ? 12 : kind === 'audio' ? 95 : null,
    uploader: people.sam,
    createdAt: new Date().toISOString(),
    usedIn: 0,
    urls: {
      file: kind === 'audio' ? '/tone.mp3' : '/teaser-v2.jpg',
      original: kind === 'audio' ? '/tone.mp3' : '/teaser-v2.jpg',
      poster: kind === 'video' ? '/teaser-v2.jpg' : null,
    },
    canDelete: true,
    source: null,
    role: null,
    hasTrace: false,
    recording: null,
  }
}

// Openverse (Find music): fixture tracks, filtered like the server (CC0 + CC BY only). localStorage.mockOpenverseBusy=1
// answers searches with the rate-limit error; mockOpenverseSlow=1 answers searches and imports with a job (202) that
// finishes on its second poll, and mockOpenverseSlow=stuck with one that never finishes.
type MockTrack =
  paths['/api/v1/media/openverse/search']['get']['responses'][200]['content']['application/json']['items'][number]
const track = (
  n: number,
  title: string,
  creator: string,
  license: 'cc0' | 'by',
  sec: number,
  genres: string[],
): MockTrack => ({
  id: `0000000${n}-0000-4000-8000-00000000000${n}`,
  title,
  creator,
  creatorUrl: `https://www.jamendo.com/artist/100${n}`,
  durationSec: sec,
  license,
  licenseVersion: license === 'cc0' ? '1.0' : '4.0',
  licenseLabel: license === 'cc0' ? 'CC0 1.0' : 'CC BY 4.0',
  licenseUrl:
    license === 'cc0'
      ? 'https://creativecommons.org/publicdomain/zero/1.0/'
      : 'https://creativecommons.org/licenses/by/4.0/',
  attribution: `"${title}" by ${creator} is licensed under ${license === 'cc0' ? 'CC0 1.0' : 'CC BY 4.0'}.`,
  landingUrl: `https://www.jamendo.com/track/200${n}`,
  source: 'jamendo',
  category: 'music',
  genres,
  previewUrl: '/tone.mp3',
  filetype: 'mp3',
  filesize: 3_400_000,
  importable: true,
  mediaId: null,
})
const mockTracks: MockTrack[] = [
  track(1, 'Morning Light', 'Lena Park', 'by', 154, ['ambient', 'piano']),
  track(2, 'Quiet Harbor', 'Tomas Reyes', 'cc0', 201, ['acoustic']),
  track(3, 'Night Drive', 'Kai Morgan', 'by', 187, ['electronic', 'synthwave']),
]
const mockOpenverseSlow = () => {
  try {
    return localStorage.getItem('mockOpenverseSlow')
  } catch {
    return null
  }
}
/** localStorage.mockOpenverseStale=1: stored searches are three hours past their fresh day (refreshing). */
const mockStale = () => {
  try {
    return localStorage.getItem('mockOpenverseStale') === '1'
  } catch {
    return false
  }
}
const MOCK_COMMON = ['upbeat', 'ambient', 'corporate', 'cinematic', 'acoustic', 'piano', 'lofi', 'calm']
/** localStorage.mockLibraryMusic=1: the library already has a piano track imported from Openverse. */
function seedLibraryMusic() {
  try {
    if (!localStorage.getItem('mockLibraryMusic') || mockMedia.some((m) => m.id === 'med_libpiano')) return
  } catch {
    return
  }
  const m = { ...mockItem('Quiet Piano Morning - Ada Keys.mp3', 'audio', 2_100_000), id: 'med_libpiano' }
  m.caption = 'Calm piano bed'
  m.source = {
    name: 'openverse',
    id: '00000009-0000-4000-8000-000000000009',
    url: 'https://www.jamendo.com/track/2009',
    title: 'Quiet Piano Morning',
    creator: 'Ada Keys',
    creatorUrl: 'https://www.jamendo.com/artist/1009',
    license: 'cc0',
    licenseVersion: '1.0',
    licenseLabel: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: null,
    creditRequired: false,
  }
  mockMedia.push(m)
}
// localStorage.mockRecordings=1 seeds three of Sam's recordings for "Ship faster with preview deploys": one on v2,
// one in his draft, and one unused (kept until its retention ends).
function seedRecordings() {
  try {
    if (!localStorage.getItem('mockRecordings') || mockMedia.some((m) => m.id === 'med_take0001')) return
  } catch {
    return
  }
  const take = (id: string, title: string, recording: NonNullable<MockMedia['recording']>) => ({
    ...mockItem(`${id}.wav`, 'audio', 1_200_000),
    id,
    title,
    durationSec: 24,
    recording,
  })
  const videoId = 'vid_teaser'
  mockMedia.push(
    take('med_take0001', 'Intro take', {
      role: 'narration-take',
      videoId,
      usedIn: [{ kind: 'version', videoId, n: 2 }],
      retainUntil: null,
    }),
    take('med_take0002', 'Second try', {
      role: 'narration-take',
      videoId,
      usedIn: [{ kind: 'draft', videoId, draftId: '00000000-0000-4000-8000-00000000ed17' }],
      retainUntil: null,
    }),
    take('med_take0003', 'Warm-up', {
      role: 'narration-upload',
      videoId,
      usedIn: [],
      retainUntil: new Date(Date.now() + 12 * 86400_000).toISOString(),
    }),
  )
}
function mockSearch(q: string, cc0Only: boolean, stored = false) {
  const items = mockTracks
    .filter(
      (t) =>
        (!cc0Only || t.license === 'cc0') &&
        (q === '' ||
          `${t.title} ${t.genres.join(' ')} music`
            .toLowerCase()
            .split(/\s+/)
            .some((w) => q.includes(w))),
    )
    .map((t) => ({ ...t, mediaId: mockMedia.find((m) => m.source?.id === t.id)?.id ?? null }))
  const stale = stored && mockStale()
  const fetchedAt = new Date(Date.now() - (stale ? 27 : 0) * 3600_000).toISOString()
  return { items, page: 1, pageCount: 1, total: items.length, fetchedAt, stale }
}
interface MockJob {
  id: string
  kind: 'search' | 'import'
  polls: number
  q?: string
  cc0Only?: boolean
  trackId?: string
  createdAt: string
}
const mockJobs = new Map<string, MockJob>()
function mockJob(j: MockJob, status: 'queued' | 'running' | 'done', result: Record<string, unknown> = {}) {
  return {
    id: j.id,
    kind: j.kind,
    status,
    search: null,
    media: null,
    created: null,
    error: null,
    createdAt: j.createdAt,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...result,
  }
}
function mockJobStart(kind: 'search' | 'import', o: { q?: string; cc0Only?: boolean; id?: string }) {
  const j: MockJob = {
    id: `ovj_mock${String(mockJobs.size + 1).padStart(4, '0')}`,
    kind,
    polls: 0,
    ...(o.q !== undefined ? { q: o.q } : {}),
    ...(o.cc0Only !== undefined ? { cc0Only: o.cc0Only } : {}),
    ...(o.id !== undefined ? { trackId: o.id } : {}),
    createdAt: new Date().toISOString(),
  }
  mockJobs.set(j.id, j)
  return new Response(JSON.stringify(mockJob(j, 'queued')), {
    status: 202,
    headers: { 'content-type': 'application/json', location: `/api/v1/media/openverse/jobs/${j.id}` },
  })
}
function mockImport(id: string): { item: MockMedia; created: boolean } | null {
  const t = mockTracks.find((x) => x.id === id)
  if (!t) return null
  const existing = mockMedia.find((m) => m.source?.id === id)
  if (existing) return { item: existing, created: false }
  const m = mockItem(`${t.title} - ${t.creator ?? ''}.mp3`, 'audio', t.filesize ?? 0)
  m.caption = `${t.title} by ${t.creator ?? ''}`
  m.durationSec = t.durationSec
  m.source = {
    name: 'openverse',
    id: t.id,
    url: t.landingUrl,
    title: t.title,
    creator: t.creator,
    creatorUrl: t.creatorUrl,
    license: t.license,
    licenseVersion: t.licenseVersion,
    licenseLabel: t.licenseLabel,
    licenseUrl: t.licenseUrl,
    attribution: t.attribution,
    creditRequired: t.license === 'by',
  }
  mockMedia.unshift(m)
  return { item: m, created: true }
}
