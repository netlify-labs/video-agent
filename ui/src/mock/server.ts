// Mock mode: answers /api/* from mock/data.ts by replacing window.fetch. Loaded only when VITE_MOCK=1.
import spec from '../../../openapi.json'
import type { paths } from '../api/schema'
import { applyEdits, type EditOp } from '../../../src/lib/contract'
import plainHtml from '../../../test/fixtures/contract1/index.html?raw'
import musicHtml from '../../../test/fixtures/contract1-music/index.html?raw'
import contractSummary from '../../../test/fixtures/contract1/summary.json'
import voiceHtml from '../../../test/fixtures/contract1-voice/index.html?raw'
import voiceSummary from '../../../test/fixtures/contract1-voice/summary.json'
import voiceFile from '../../../test/fixtures/contract1-voice/assets/voice/voice.json'
import { people, stats, videos } from './data'
import { mockFile } from './files'

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
const mockOAuth = () => {
  try {
    return localStorage.getItem('mockOAuth') !== '0'
  } catch {
    return true
  }
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
    unread: undefined,
    can: { edit: mine && me.role !== 'viewer', delete: mine || moderate, resolve: moderate },
  }
}
const withComments = <T extends { id: string; comments: { count: number; unread: number } }>(v: T): T => {
  const mine = comments.filter((c) => c.videoId === v.id)
  return { ...v, comments: { count: mine.length, unread: mine.filter((c) => c.unread).length } }
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

export function installMock() {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    )
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const p = url.pathname
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
        admission: ['acme.com'],
        siteUrl: window.location.origin,
        planningAvailable: true,
        mcpOAuth: mockOAuth(),
        authProvider: mockAuthProvider(),
        requiredTeams: mockAuthProvider() === 'netlify' ? ['acme'] : [],
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
      return json({ items: items.map(withComments), nextCursor: null })
    }
    // Live progress (plan v2 §6): the step moves on with every poll; localStorage.mockStale marks it stale.
    const pg = /^\/api\/v1\/videos\/([^/]+)\/progress$/.exec(p)
    if (pg?.[1]) {
      const w = window as unknown as { __progressCalls?: number }
      w.__progressCalls = (w.__progressCalls ?? 0) + 1
      const vid = videos.find((x) => x.id === pg[1])
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
        render = localStorage.getItem('mockRender') === '1'
        live = localStorage.getItem('mockLive') === '1'
      } catch {
        // private mode
      }
      return json({
        attemptId: latest ? `att_${vid.id}_${latest.n}` : null,
        versionN: latest?.n ?? null,
        stage: latest?.stage ?? null,
        step: steps[(w.__progressCalls - 1) % steps.length],
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
    if (p === '/api/v1/media' && method === 'GET') {
      const kind = url.searchParams.get('kind')
      return json({ items: mockMedia.filter((m) => !kind || m.kind === kind), nextCursor: null })
    }
    if (p === '/api/v1/media' && method === 'POST') {
      if (me.role === 'viewer' || me.role === 'reviewer')
        return fail(403, 'forbidden', `Your role (${me.role}) can't upload media.`)
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
          'Upload PNG, JPEG, WebP or SVG images, MP4 clips, MP3, M4A, WAV or Ogg audio, or WOFF2, TTF or OTF fonts.',
        )
      const m = mockItem(name, kind, body.byteLength)
      mockMedia.unshift(m)
      return json(m, 201)
    }
    if (p === '/api/v1/media/uploads' && method === 'POST') {
      const b = (await readBody(init, input)) as { filename: string; size: number }
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
        const m = mockItem(s.filename, 'video', s.size)
        mockMedia.unshift(m)
        s.status = 'done'
        s.mediaId = m.id
        return json(s, 202)
      }
      return json(s)
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
        const b = (await readBody(init, input)) as { caption: string | null }
        m.caption = b.caption?.trim() || null
      }
      return json(m)
    }
    // Editor (plan v2 §8): drafts run on the real patcher over the spike S8 fixture. window.__lastEditOps records saves.
    const ed = /^\/api\/v1\/videos\/([^/]+)\/versions\/(\d+)\/edits$/.exec(p)
    const edit = /^\/api\/v1\/edits\/([^/]+)(\/render|\/preview)?$/.exec(p)
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
      if (edit[2] === '/render') {
        const vid = videos.find((x) => x.id === mockEdit?.videoId)
        const w = window as unknown as { __rendered?: number }
        w.__rendered = (w.__rendered ?? 0) + 1
        if (!vid) return fail(404, 'not_found', 'Video not found.')
        return json({ ...withComments(vid), latestVersion: vid.versions.length + 1 }, 202)
      }
      if (method === 'DELETE') {
        mockEdit = null
        return new Response(null, { status: 204 })
      }
      if (method === 'PUT') {
        const b = (await readBody(init, input)) as { rev: number; ops: EditOp[] }
        ;(window as unknown as { __lastEditOps?: unknown }).__lastEditOps = b.ops
        if (b.rev !== mockEdit.rev)
          return fail(409, 'conflict', 'This draft changed in another tab. Reload it to continue.')
        try {
          const out = applyEdits(contractHtml(), mockSummary(), b.ops, {
            palette: mockPalette,
            ...mockNarration(),
          })
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
    // Review (plan v2 §5)
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
      const c: MockComment = {
        id: `c_${comments.length + 1}`,
        videoId: cm[1],
        versionN: Number(b.versionN),
        author: people.sam,
        body: typeof b.body === 'string' ? b.body.trim() : '',
        timeSec: (b.timeSec as number | undefined) ?? null,
        x: (b.x as number | undefined) ?? null,
        y: (b.y as number | undefined) ?? null,
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
    // Revise (and incorporate): the last request body is kept for tests.
    const rv = /^\/api\/v1\/videos\/([^/]+)\/versions$/.exec(p)
    if (rv?.[1] && method === 'POST') {
      const b = await readBody(init, input)
      ;(window as unknown as { __lastRevise?: unknown }).__lastRevise = b
      const vid = videos.find((x) => x.id === rv[1])
      return vid ? json(withComments(vid), 202) : fail(404, 'not_found', 'Video not found.')
    }
    const m = /^\/api\/v1\/videos\/([^/]+)(?:\/versions\/(\d+)\/(video|poster|gif|captions))?$/.exec(p)
    if (m?.[1] && m[3])
      return Response.redirect(new URL(mockFile(m[1], m[3] as 'video'), window.location.origin).href, 302)
    if (m?.[1]) {
      const v = videos.find((x) => x.id === m[1])
      return v ? json(withComments(v)) : fail(404, 'not_found', 'Video not found.')
    }
    return fail(404, 'not_found', `Mock has no ${method} ${p}`)
  }
}

let mockVoice: { voice: string | null; speed: number | null; script: string[] | null } | null = null
const NARRATION = [
  'Every project used to need its own webhook.',
  'Now one org webhook covers them all.',
  'Read the docs to set it up.',
]

function mockPlan(stage: 'route' | 'questions' | 'brief' = 'route') {
  const questions = [
    {
      id: 'q1',
      question: 'Who is this video for?',
      why: 'It sets how technical the beats get.',
      options: [
        { id: 'a', label: 'Developers', description: 'Show the API' },
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
    route: { needsQuestions: true, template: 'launch', suggestedAspect: null },
    questions: stage === 'route' ? null : questions,
    answers: stage === 'brief' ? [] : null,
    brief:
      stage === 'brief'
        ? {
            goal: 'Announce org-wide webhooks',
            audience: 'Developers',
            keyMessage: 'One subscription covers every project',
            beats: [
              { text: 'The problem: a webhook per project', seconds: 8 },
              { text: 'Org webhooks: subscribe once', seconds: 14 },
              { text: 'End card: Read the docs', seconds: 8 },
            ].map((b, i) => (mockVoice ? { ...b, narration: mockVoice.script?.[i] ?? NARRATION[i] } : b)),
            tone: 'Confident, plain',
            callToAction: 'Read the docs',
            mustInclude: ['logo'],
            avoid: [],
          }
        : null,
    briefRev: stage === 'brief' ? 1 : 0,
    voiceover: mockVoice,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }
}

const mockPalette = ['#0b0d10', '#f4f5f7', '#9aa3ad', '#14b8a6', '#ff5a1f']
type MockEdit = ReturnType<typeof newMockEdit>
let mockEdit: MockEdit | null = null
/**
 * localStorage.mockMusic=1 edits the copy of the fixture with a music layer, whose track is in the library;
 * localStorage.mockVoice=1 the copy that also has a voice-over in two beats.
 */
function contractHtml() {
  const voice = !!localStorage.getItem('mockVoice')
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
    renderedN: null,
    newerVersion: null,
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
  }
>()
type MockKind = MockMedia['kind']
function mockKind(b: Uint8Array): MockKind | null {
  const head = String.fromCharCode(...b.subarray(0, 12))
  if (b[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'image'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image'
  if (head.startsWith('ID3') || head.startsWith('OggS') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return 'audio'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'audio'
  if (head.slice(4, 8) === 'ftyp') return 'video'
  if (head.startsWith('wOF2') || head.startsWith('OTTO')) return 'font'
  if (new TextDecoder().decode(b.subarray(0, 200)).includes('<svg')) return 'svg'
  return null
}
function mockItem(filename: string, kind: MockKind, bytes: number): MockMedia {
  const id = `med_mock${String(mockMedia.length + 1).padStart(4, '0')}`
  return {
    id,
    kind,
    status: 'ready',
    rejectReason: null,
    filename,
    caption: null,
    mime:
      kind === 'video'
        ? 'video/mp4'
        : kind === 'svg'
          ? 'image/svg+xml'
          : kind === 'audio'
            ? 'audio/mpeg'
            : 'image/png',
    bytes,
    width: kind === 'font' || kind === 'audio' ? null : 1920,
    height: kind === 'font' || kind === 'audio' ? null : 1080,
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
  }
}
