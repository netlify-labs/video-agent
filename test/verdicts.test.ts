// Approvals (plan v2 §3, §14 rule 8): a signal per person per version; never on your own version.
import { describe, expect, it } from 'vitest'
import { encrypt } from '../src/lib/crypto.js'
import { getSettings } from '../src/domain/settings.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { apiKey, harness, mcpCall, person, PROMPT, readyVideo, type Harness } from './helpers.js'

const verdict = (h: Harness, as: string, id: string, n: number, body: unknown) =>
  h.call('PUT', `/api/v1/videos/${id}/versions/${n}/verdict`, { as, body })

describe('verdicts', () => {
  it('records one changeable verdict per person, with counts and your own verdict on the version', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const rita = await person(h, 'u_rita', 'reviewer')
    const id = await readyVideo(h, h.member)
    expect((await verdict(h, bob, id, 1, { verdict: 'approved', note: 'Ship it' })).status).toBe(200)
    const after = await h.json(await verdict(h, rita, id, 1, { verdict: 'changes_requested' }))
    expect(after.versions[0].verdicts).toEqual({
      approved: 1,
      changesRequested: 1,
      mine: 'changes_requested',
    })
    await verdict(h, rita, id, 1, { verdict: 'approved' })
    const asBob = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: bob }))
    expect(asBob.versions[0].verdicts).toEqual({ approved: 2, changesRequested: 0, mine: 'approved' })
    await verdict(h, bob, id, 1, { verdict: null })
    const cleared = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: bob }))
    expect(cleared.versions[0].verdicts).toEqual({ approved: 1, changesRequested: 0, mine: null })
    // Library counts come from one grouped query.
    const list = await h.json(await h.call('GET', '/api/v1/videos', { as: bob }))
    expect(list.items[0].versions[0].verdicts.approved).toBe(1)
  })

  it("nobody approves their own version, not even an admin; owners can review someone else's version", async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const own = await readyVideo(h, h.member)
    const res = await verdict(h, h.member, own, 1, { verdict: 'approved' })
    expect(res.status).toBe(403)
    expect((await h.json(res)).error.message).toBe("You can't approve your own version.")
    const adminOwn = await readyVideo(h, h.admin)
    expect((await verdict(h, h.admin, adminOwn, 1, { verdict: 'approved' })).status).toBe(403)
    // Bob revises Mia's video; Mia (the owner) may review Bob's v2.
    await h.call('POST', `/api/v1/videos/${own}/versions`, { as: bob, body: { prompt: 'Make it orange' } })
    await h.drive(4)
    expect((await verdict(h, h.member, own, 2, { verdict: 'approved' })).status).toBe(200)
  })

  it('only ready versions; viewers cannot; private videos 404', async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const vic = await person(h, 'u_vic', 'viewer')
    const queued = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    expect((await verdict(h, bob, queued.id, 1, { verdict: 'approved' })).status).toBe(409)
    const id = await readyVideo(h, h.member)
    expect((await verdict(h, vic, id, 1, { verdict: 'approved' })).status).toBe(403)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await verdict(h, bob, id, 1, { verdict: 'approved' })).status).toBe(404)
  })

  it("emits version.approved to the owner's webhook with who approved it", async () => {
    const h = harness()
    const bob = await person(h, 'u_bob')
    const id = await readyVideo(h, h.member)
    const { dataEncryptionKey } = await getSettings(h.deps)
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.putUserWebhook({
      userId: 'u_member',
      url: 'https://mia.example.com/hook',
      secretEnc: encrypt(dataEncryptionKey, 's'),
      createdAt: now,
      updatedAt: now,
    })
    await verdict(h, bob, id, 1, { verdict: 'approved', note: 'Nice' })
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    const body = JSON.parse(h.deps.http.calls.at(-1)?.body ?? '{}')
    expect(body.event).toBe('version.approved')
    expect(body.verdict).toEqual({
      by: { id: 'u_bob', name: 'u_bob', email: 'u_bob@acme.com' },
      verdict: 'approved',
      note: 'Nice',
    })
  })

  it('MCP set_verdict works for reviewers and is hidden from viewers', async () => {
    const h = harness()
    const rita = await person(h, 'u_rita', 'reviewer')
    const vic = await person(h, 'u_vic', 'viewer')
    const id = await readyVideo(h, h.member)
    const mcp = async (cookie: string, method: string, params: unknown) =>
      mcpCall(h, await apiKey(h, cookie), method, params)
    const r = await mcp(rita, 'tools/call', {
      name: 'set_verdict',
      arguments: { video_id: id, version: 1, verdict: 'approved' },
    })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent.verdicts.approved).toBe(1)
    const tools = (await mcp(vic, 'tools/list', {})).tools.map((t: { name: string }) => t.name)
    expect(tools).not.toContain('set_verdict')
  })
})
