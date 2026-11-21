// Usage views (plan v2 §4, §14 rule 17): runs vs planning for admins; my usage this month.
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

const PROMPT = 'A 30-second launch video for org-wide webhooks. Ends on our logo.'

describe('usage', () => {
  it('splits run and planning credits for admins, and shows mine this month', async () => {
    const h = harness()
    // Planning: the router (ok), then questions that fail on every try (unknown cost).
    const plan = await h.json(
      await h.call('POST', '/api/v1/plans', { as: h.member, body: { prompt: PROMPT } }),
    )
    h.deps.gateway.replies.push(new Error('429'), new Error('429'), new Error('429'))
    await h.call('POST', `/api/v1/plans/${plan.id}/questions`, { as: h.member })
    // A run (the fake runner reports 42 credits).
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(4)

    const stats = await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))
    const row = stats.usage.find((u: { userId: string }) => u.userId === 'u_member')
    expect(row.credits).toBe(42)
    expect(row.videos).toBe(1)
    expect(row.planningCredits).toBeGreaterThan(0)
    expect(row.planningUnknown).toBe(3)

    const mine = await h.json(await h.call('GET', '/api/v1/me/usage', { as: h.member }))
    expect(mine.runs).toEqual({ credits: 42, videos: 1, unknown: false })
    expect(mine.planning.calls).toBe(4)
    expect(mine.planning.unknown).toBe(3)
    expect(mine.planning.credits).toBe(row.planningCredits)
    // Someone else's usage isn't mine.
    expect((await h.json(await h.call('GET', '/api/v1/me/usage', { as: h.admin }))).runs.videos).toBe(0)
  })

  it('lists people who only planned', async () => {
    const h = harness()
    await h.call('POST', '/api/v1/plans', { as: h.member, body: { prompt: PROMPT } })
    const stats = await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))
    expect(stats.usage).toEqual([expect.objectContaining({ userId: 'u_member', videos: 0, credits: 0 })])
  })
})
