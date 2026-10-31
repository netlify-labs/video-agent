// Mock mode: answers /api/* from mock/data.ts by replacing window.fetch. Loaded only when VITE_MOCK=1.
import spec from '../../../openapi.json'
import { ASSETS, people, stats, videos } from './data'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const me = {
  id: people.sam.id,
  email: people.sam.email,
  name: people.sam.name,
  role: 'admin',
  via: 'session',
}

export function mockFile(videoId: string, file: 'video' | 'poster' | 'gif' | 'captions'): string {
  const base = ASSETS[videoId] ?? 'teaser-v2'
  const ext = { video: 'mp4', poster: 'jpg', gif: 'gif', captions: 'vtt' }[file]
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
      return json({ items, nextCursor: null })
    }
    if (p === '/api/v1/videos' && method === 'POST') return json(videos[0], 202)
    const m = /^\/api\/v1\/videos\/([^/]+)(?:\/versions\/(\d+)\/(video|poster|gif|captions))?$/.exec(p)
    if (m?.[1] && m[3])
      return Response.redirect(new URL(mockFile(m[1], m[3] as 'video'), window.location.origin).href, 302)
    if (m?.[1]) {
      const v = videos.find((x) => x.id === m[1])
      return v ? json(v) : json({ error: { code: 'not_found', message: 'Video not found.' } }, 404)
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
