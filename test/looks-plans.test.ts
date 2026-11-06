// Looks on plans (plan 2026-11-04-looks §4.12, bead va-nifa.4.6): a plan carries a look, chosen or picked
// deterministically from the router's template; the planner gets it as chosen_look and never asks about style; the
// video made from the plan uses it (falling back to the default when it has been turned off since).
import { describe, expect, it } from 'vitest'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A 30-second launch video for org-wide webhooks. Ends on our logo.'
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

interface Plan {
  id: string
  look: { id: string | null; chosen: boolean } | null
}

type Template = 'launch' | 'tutorial' | 'social' | 'changelog' | 'sales' | 'other'

function routeAs(h: Harness, template: Template) {
  h.deps.gateway.routeAnswers = {
    needs_questions: 'yes',
    template,
    complexity: 'standard',
    aspect: 'landscape',
  }
}

async function plan(h: Harness, body: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/api/v1/plans', { as: h.member, body: { prompt: PROMPT, ...body } })
  return { status: res.status, plan: await h.json<Plan & { error?: { code: string } }>(res) }
}

/** Questions, then the brief: the plan is ready to create with. */
async function toBrief(h: Harness, id: string) {
  h.deps.gateway.replies.push(QUESTIONS)
  await h.call('POST', `/api/v1/plans/${id}/questions`, { as: h.member })
  h.deps.gateway.replies.push(BRIEF)
  await h.call('POST', `/api/v1/plans/${id}/brief`, { as: h.member, body: { answers: [] } })
}

const settings = (h: Harness, body: Record<string, unknown>) =>
  h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body })

async function createFrom(h: Harness, planId: string, body: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/api/v1/videos', {
    as: h.member,
    body: { prompt: PROMPT, planId, ...body },
  })
  return h.json<{ id: string; versions: { n: number; look: { id: string } | null; plan: unknown }[] }>(res)
}

describe('a plan look', () => {
  it('a chosen look reaches the planner as chosen_look, once, with the no-style-questions rule', async () => {
    const h = harness()
    routeAs(h, 'changelog')
    const { plan: p } = await plan(h, { look: 'kinetic' })
    expect(p.look).toEqual({ id: 'kinetic', chosen: true })
    await toBrief(h, p.id)
    const [q, b] = h.deps.gateway.calls.filter((c) => c.kind === 'messages')
    for (const call of [q, b]) {
      expect(call?.user?.split('<data name="chosen_look">').length).toBe(2)
      expect(call?.user).toContain('"name":"Kinetic"')
      expect(call?.system).toContain('never ask about style')
    }
  })

  it('with none chosen, the first enabled look made for the template, else the default, else none', async () => {
    const h = harness()
    routeAs(h, 'social')
    expect((await plan(h)).plan.look).toEqual({ id: 'kinetic', chosen: false })
    routeAs(h, 'launch')
    expect((await plan(h)).plan.look).toEqual({ id: 'clean', chosen: false })
    // A turned-off match is skipped.
    await settings(h, { disabledLooks: ['clean'] })
    expect((await plan(h)).plan.look).toEqual({ id: 'kinetic', chosen: false })
    // No match: the admin default, else none.
    routeAs(h, 'other')
    expect((await plan(h)).plan.look).toEqual({ id: null, chosen: false })
    await settings(h, { defaultLook: 'terminal' })
    expect((await plan(h)).plan.look).toEqual({ id: 'terminal', chosen: false })
    // No planner block without a look.
    h.deps.gateway.calls.length = 0
    routeAs(h, 'other')
    await settings(h, { defaultLook: null })
    const none = (await plan(h)).plan
    await toBrief(h, none.id)
    expect(h.deps.gateway.calls.some((c) => c.user?.includes('chosen_look'))).toBe(false)
  })

  it('refuses an unknown or turned-off look like a create', async () => {
    const h = harness()
    routeAs(h, 'launch')
    expect((await plan(h, { look: 'nope' })).plan.error?.code).toBe('unknown_look')
    await settings(h, { disabledLooks: ['kinetic'] })
    expect((await plan(h, { look: 'kinetic' })).status).toBe(409)
  })

  it('the video made from the plan uses its look; explicit null stays none over the default', async () => {
    const h = harness()
    routeAs(h, 'social')
    const { plan: p } = await plan(h)
    await toBrief(h, p.id)
    const v = await createFrom(h, p.id)
    expect(v.versions[0]?.look?.id).toBe('kinetic')
    expect(v.versions[0]?.plan).toMatchObject({ planId: p.id })

    await settings(h, { defaultLook: 'terminal' })
    const { plan: none } = await plan(h, { look: null })
    expect(none.look).toEqual({ id: null, chosen: true })
    await toBrief(h, none.id)
    expect((await createFrom(h, none.id)).versions[0]?.look).toBeNull()

    // The create's own look wins over the plan's.
    const { plan: q } = await plan(h)
    await toBrief(h, q.id)
    expect((await createFrom(h, q.id, { look: 'clean' })).versions[0]?.look?.id).toBe('clean')
  })

  it('a plan look turned off after planning falls back to the default, and says so', async () => {
    const h = harness()
    routeAs(h, 'social')
    const { plan: p } = await plan(h)
    await toBrief(h, p.id)
    await settings(h, { disabledLooks: ['kinetic'], defaultLook: 'terminal' })
    expect((await createFrom(h, p.id)).versions[0]?.look?.id).toBe('terminal')
    expect(h.deps.logs.some((l) => l.includes('"look.fallback"'))).toBe(true)
  })

  it('a remix plan keeps the source look unless one is chosen', async () => {
    const h = harness()
    routeAs(h, 'launch')
    const src = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, look: 'kinetic' } }),
    )
    await h.drive(4)
    const remix = async (body: Record<string, unknown>) => {
      const { plan: p } = await plan(h, { remixOf: { videoId: src.id, version: 1 }, ...body })
      await toBrief(h, p.id)
      const res = await h.call('POST', `/api/v1/videos/${src.id}/remix`, {
        as: h.member,
        body: { prompt: 'For payments', fromVersion: 1, planId: p.id },
      })
      return { p, made: await h.json<{ versions: { look: { id: string } | null }[] }>(res) }
    }
    const kept = await remix({})
    expect(kept.p.look).toBeNull()
    expect(kept.made.versions[0]?.look?.id).toBe('kinetic')
    const chosen = await remix({ look: 'terminal' })
    expect(chosen.p.look).toEqual({ id: 'terminal', chosen: true })
    expect(chosen.made.versions[0]?.look?.id).toBe('terminal')
  })
})
