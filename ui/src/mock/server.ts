// Mock mode: answers /api/* from mock/data.ts by replacing window.fetch. Loaded only when VITE_MOCK=1.
import spec from '../../../openapi.json'
import { ASSETS, people, stats, videos } from './data'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

export function mockFile(videoId: string, file: 'video' | 'poster' | 'gif' | 'captions'): string {
  const base = ASSETS[videoId] ?? 'teaser-v2'
  const ext = { video: 'mp4', poster: 'jpg', gif: 'gif', captions: 'vtt' }[file]
  if (file === 'video' && base === 'sales-vertical') return '/sales-vertical.mp4'
  return `/${file === 'video' || file === 'captions' ? 'teaser-v2' : base}.${ext}`
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
    if (p === '/api/v1/plans' && method === 'POST') return json(mockPlan(), 201)
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
      return json({ admission: ['acme.com'], siteUrl: window.location.origin, planningAvailable: true })
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
      try {
        stale = localStorage.getItem('mockStale') === '1'
        render = localStorage.getItem('mockRender') === '1'
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
        checkpoint: render
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
    // Composition preview links (plan v2 §7): a stand-in page with the bridge protocol. Short-lived, so the renewal
    // path runs in tests; window.__previewLinks counts how many were minted.
    if (/^\/api\/v1\/videos\/[^/]+\/versions\/\d+\/preview$/.test(p)) {
      const w = window as unknown as { __previewLinks?: number }
      w.__previewLinks = (w.__previewLinks ?? 0) + 1
      return json({
        url: `${window.location.origin}/mock-preview/index.html?link=${w.__previewLinks}`,
        expiresAt: new Date(Date.now() + 62_000).toISOString(),
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
      if (me.role === 'viewer')
        return json({ error: { code: 'forbidden', message: "Your role (viewer) can't comment." } }, 403)
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
      if (!c) return json({ error: { code: 'not_found', message: 'Comment not found.' } }, 404)
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
      if (!vid || !ver) return json({ error: { code: 'not_found', message: 'Video not found.' } }, 404)
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
      return vid
        ? json(withComments(vid), 202)
        : json({ error: { code: 'not_found', message: 'Video not found.' } }, 404)
    }
    const m = /^\/api\/v1\/videos\/([^/]+)(?:\/versions\/(\d+)\/(video|poster|gif|captions))?$/.exec(p)
    if (m?.[1] && m[3])
      return Response.redirect(new URL(mockFile(m[1], m[3] as 'video'), window.location.origin).href, 302)
    if (m?.[1]) {
      const v = videos.find((x) => x.id === m[1])
      return v
        ? json(withComments(v))
        : json({ error: { code: 'not_found', message: 'Video not found.' } }, 404)
    }
    return json({ error: { code: 'not_found', message: `Mock has no ${method} ${p}` } }, 404)
  }
}

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
            ],
            tone: 'Confident, plain',
            callToAction: 'Read the docs',
            mustInclude: ['logo'],
            avoid: [],
          }
        : null,
    briefRev: stage === 'brief' ? 1 : 0,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }
}
