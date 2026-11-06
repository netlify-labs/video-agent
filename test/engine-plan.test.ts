// A plan keeps its engine (render-engines plan §4.2): a new-video plan may name one, checked as a create checks it, and
// the video made from the plan is made with it unless the create names another.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import { apiKey, harness, mcpCall, pgStore, PROMPT, type Harness } from './helpers.js'

const QUESTIONS = JSON.stringify({ questions: [] })
const BRIEF = JSON.stringify({
  title: 'Org webhooks in 30 seconds',
  goal: 'Announce org webhooks',
  audience: 'Developers',
  keyMessage: 'One subscription for every project',
  beats: [{ text: 'Problem', seconds: 10 }],
  tone: 'Confident',
  callToAction: 'Read the docs',
  mustInclude: [],
  avoid: [],
})
const ack = {
  by: 'u_admin',
  email: 'admin@acme.com',
  at: '2026-11-05T00:00:00Z',
  tier: 'free' as const,
  note: null,
}

async function plan(h: Harness, body: Record<string, unknown>) {
  const res = await h.call('POST', '/api/v1/plans', { as: h.member, body: { prompt: PROMPT, ...body } })
  return {
    status: res.status,
    body: (await res.json()) as { id: string; engine: string | null; error?: { code: string } },
  }
}
async function toBrief(h: Harness, id: string) {
  h.deps.gateway.replies.push(QUESTIONS)
  await h.call('POST', `/api/v1/plans/${id}/questions`, { as: h.member })
  h.deps.gateway.replies.push(BRIEF)
  await h.call('POST', `/api/v1/plans/${id}/brief`, { as: h.member, body: { answers: [] } })
}

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('a plan keeps its engine (%s)', { timeout: 20_000 }, (_name, stores) => {
  async function deployment(on = true) {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await getSettings(h.deps)
    await h.deps.store.updateSettings({ remotionEnabled: on, remotionLicenseAck: ack })
    h.deps.gateway.routeAnswers = {
      needs_questions: 'yes',
      template: 'other',
      complexity: 'standard',
      aspect: 'landscape',
    }
    return h
  }

  it('a new-video plan with Remotion makes a Remotion video, and the plan shows its engine', async () => {
    const h = await deployment()
    const p = await plan(h, { engine: 'remotion', look: null, sound: 'music' })
    expect(p.status).toBe(201)
    expect(p.body.engine).toBe('remotion')
    await toBrief(h, p.body.id)
    const res = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, planId: p.body.id },
    })
    expect(res.status).toBe(202)
    const id = ((await res.json()) as { id: string }).id
    expect((await h.deps.store.getVersion(id, 1))?.engine).toBe('remotion')
  })

  it('a create naming an engine wins over its plan', async () => {
    const h = await deployment()
    const p = await plan(h, { engine: 'remotion', look: null })
    await toBrief(h, p.body.id)
    const res = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, planId: p.body.id, engine: 'hyperframes' },
    })
    const id = ((await res.json()) as { id: string }).id
    expect((await h.deps.store.getVersion(id, 1))?.engine).toBe('hyperframes')
  })

  it('a plan without an engine says null and makes the look’s choice', async () => {
    const h = await deployment()
    const p = await plan(h, { look: null })
    expect(p.body.engine).toBeNull()
  })

  it.each([
    ['Remotion while it is off', false, { engine: 'remotion', look: null }, 409, 'engine_disabled'],
    [
      'sound effects on Remotion',
      true,
      { engine: 'remotion', look: null, sound: 'music_sfx' },
      409,
      'engine_unsupported',
    ],
    [
      'a look that lists only HyperFrames',
      true,
      { engine: 'remotion', look: 'clean' },
      400,
      'engine_not_supported_by_look',
    ],
  ] as const)('refuses %s, as a create would', async (_l, on, body, status, code) => {
    const h = await deployment(on)
    const p = await plan(h, body)
    expect(p.status).toBe(status)
    expect(p.body.error?.code).toBe(code)
  })

  it('a revision or remix plan keeps its video’s engine: engine is refused', async () => {
    const h = await deployment()
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    const p = await plan(h, { engine: 'remotion', revisionOf: { videoId: v.id } })
    expect(p.status).toBe(400)
    expect(p.body.error?.code).toBe('invalid_request')
  })

  it('MCP plan_video takes engine only where Remotion is on', async () => {
    const off = harness({}, await stores())
    const props = async (h: Harness) =>
      (
        (await mcpCall(h, await apiKey(h, h.member), 'tools/list', {})).tools as {
          name: string
          inputSchema: { properties: Record<string, unknown> }
        }[]
      ).find((t) => t.name === 'plan_video')?.inputSchema.properties
    expect(await props(off)).not.toHaveProperty('engine')
    expect(await props(await deployment())).toHaveProperty('engine')
  })
})
